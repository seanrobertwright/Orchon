// Live updates: the worker holds Archon's dashboard stream while Connected, reads its frames by
// hand, and posts hints. It reopens a stream that has gone quiet, retries on a backoff, and
// tells the connection when the stream is open and when the server refused it. Nothing here
// waits on a frame: every promise is caught, since an unhandled rejection would stop the worker.
import type { Client, Timers } from './client'
import type { HintType, RunsHint } from './hint-view'
import { createFrameParser, HINT_TYPES, readDashboardFrame } from './stream-frames'

/** Archon's dashboard stream. It is not in the path list, so the path check does not cover it. */
export const DASHBOARD_STREAM_PATH = '/api/stream/__dashboard__'
/** The stream is reopened after this long with nothing read. Archon sends a heartbeat every 30 seconds. */
export const SILENCE_MS = 75_000
/** A stream that could not be opened, or dropped, is tried again after this long, doubling to the last. */
export const FIRST_STREAM_RETRY_MS = 1_000
export const LAST_STREAM_RETRY_MS = 30_000
/** At most one hint is posted in this long. */
export const HINT_GAP_MS = 1_000
/** A hint past this many runs says `many` in place of their ids. */
export const HINT_RUNS_CAP = 50

export type LivePorts = {
  client: Client
  now(): number
  timers: Timers
  /** Posts a hint to every open frame. */
  hint(hint: RunsHint): void
  /** The stream opened (true) or closed (false). */
  live(live: boolean): void
  /** Nothing took the stream's connection: the server is gone. */
  refused(): void
  log(message: string): void
}

export type Live = {
  /** Connected to this server: opens the stream at once, with the backoff started over. */
  open(baseUrl: string): void
  /** No longer Connected: closes the stream and clears every timer. */
  close(): void
}

/** Folds the runs named in one second into one hint. */
function createHints(ports: LivePorts) {
  const types = new Set<HintType>()
  const runs = new Set<string>()
  let many = false
  let lastPost: number | undefined
  let timer: unknown

  function post(): void {
    timer = undefined
    if (types.size === 0) return
    lastPost = ports.now()
    // Listed in a fixed order, so the same frames always make the same hint.
    ports.hint({ types: HINT_TYPES.filter((type) => types.has(type)), runs: many ? 'many' : [...runs] })
    types.clear()
    runs.clear()
    many = false
  }

  function schedule(): void {
    if (timer !== undefined) return
    const wait = lastPost === undefined ? 0 : lastPost + HINT_GAP_MS - ports.now()
    if (wait <= 0) post()
    else timer = ports.timers.set(post, wait)
  }

  return {
    add(type: HintType, runId: string): void {
      types.add(type)
      if (!many) runs.add(runId)
      if (runs.size > HINT_RUNS_CAP) {
        many = true
        runs.clear()
      }
      schedule()
    },
    /** Every run may have changed, such as while the stream was down. */
    everything(): void {
      for (const type of HINT_TYPES) types.add(type)
      many = true
      runs.clear()
      schedule()
    },
    stop(): void {
      if (timer !== undefined) ports.timers.clear(timer)
      timer = undefined
      types.clear()
      runs.clear()
      many = false
    }
  }
}

export function createLive(ports: LivePorts): Live {
  const hints = createHints(ports)
  let baseUrl: string | null = null
  /** Rises with every attempt and on close, so an older attempt changes nothing when it ends. */
  let generation = 0
  let controller = new AbortController()
  let watchdog: unknown
  let retryTimer: unknown
  let retryDelay = FIRST_STREAM_RETRY_MS
  /** Whether the stream has opened since the last `open`, so that the next opening is a reconnect. */
  let openedBefore = false
  let isLive = false
  /**
   * The last attempt was refused, which sent the connection to Searching. The rediscovery that
   * follows waits out the backoff before it opens the stream, so a server that answers its other
   * calls and refuses the stream is not asked again in a tight loop.
   */
  let refusedLast = false

  function clear(timer: unknown): undefined {
    if (timer !== undefined) ports.timers.clear(timer)
    return undefined
  }

  function setLive(next: boolean): void {
    if (next === isLive) return
    isLive = next
    ports.live(next)
  }

  /** Starts the silence over: once it runs out, the attempt in flight is dropped and another begins. */
  function arm(mine: number): void {
    watchdog = clear(watchdog)
    watchdog = ports.timers.set(() => {
      watchdog = undefined
      if (mine !== generation) return
      // The quiet stream is dropped: it is not live until the next one opens.
      setLive(false)
      attemptNow()
    }, SILENCE_MS)
  }

  function retryLater(): void {
    const wait = retryDelay
    retryDelay = Math.min(retryDelay * 2, LAST_STREAM_RETRY_MS)
    retryTimer = ports.timers.set(() => {
      retryTimer = undefined
      attemptNow()
    }, wait)
  }

  function attemptNow(): void {
    attempt().catch((error: unknown) => {
      ports.log(`Orchon could not read Archon's stream: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** One open of the stream, read until it ends, breaks or goes quiet. */
  async function attempt(): Promise<void> {
    const server = baseUrl
    if (server === null) return
    generation += 1
    const mine = generation
    controller.abort()
    controller = new AbortController()
    const { signal } = controller
    retryTimer = clear(retryTimer)
    arm(mine)
    let dropped = false
    try {
      const opened = await ports.client.stream({ baseUrl: server, path: DASHBOARD_STREAM_PATH, signal })
      if (mine !== generation) return
      if (!opened.ok) {
        if (opened.failure.kind === 'refused') {
          watchdog = clear(watchdog)
          setLive(false)
          refusedLast = true
          ports.refused()
          return
        }
        dropped = true
        return
      }
      retryDelay = FIRST_STREAM_RETRY_MS
      refusedLast = false
      setLive(true)
      if (openedBefore) hints.everything()
      openedBefore = true
      const parser = createFrameParser()
      for await (const text of opened.text) {
        if (mine !== generation) return
        arm(mine)
        const frames = parser.push(text)
        if (frames === null) break
        for (const frame of frames) {
          const read = readDashboardFrame(frame)
          if (read !== null) hints.add(read.type, read.runId)
        }
      }
      if (mine === generation) dropped = true
    } catch {
      // A broken or quiet stream ends here; the watchdog has already begun the next attempt.
      if (mine === generation) dropped = true
    } finally {
      if (mine === generation && dropped) {
        watchdog = clear(watchdog)
        setLive(false)
        retryLater()
      }
    }
  }

  return {
    open(next) {
      baseUrl = next
      openedBefore = false
      if (refusedLast) {
        refusedLast = false
        retryLater()
        return
      }
      retryDelay = FIRST_STREAM_RETRY_MS
      attemptNow()
    },
    close() {
      baseUrl = null
      generation += 1
      controller.abort()
      watchdog = clear(watchdog)
      retryTimer = clear(retryTimer)
      hints.stop()
      isLive = false
    }
  }
}
