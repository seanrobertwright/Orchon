// The per-view fetch rules, one piece every view of the panel and the tabs reuses (#13, part 5):
// a request counter so only the answer to the newest request is applied; one fetch in flight and
// at most one more queued; a minimum gap between the starts of two fetches; a user action that
// aborts the fetch in flight and starts at once; a safety refetch; and every timer cleared when
// the view closes. It is pure logic on the clock and timers it is given.
import type { Timers } from './client'

export type ViewFetchOptions<T> = {
  /** Fetches the view once. The signal aborts when a newer fetch supersedes it or the view closes. */
  load(signal: AbortSignal): Promise<T>
  /** Called with the answer to the newest fetch only. */
  apply(value: T): void
  /** Called when the newest fetch fails. An older fetch's failure is dropped like its answer. */
  fail(error: unknown): void
  /** The least time between the starts of two fetches that were not asked for by the person. */
  minGapMs: number
  /**
   * The view fetches again this long after its last fetch ended, whatever else happened. A
   * function is asked each time the timer is set, so the wait can follow whether live updates are on.
   */
  safetyMs: number | (() => number)
  now(): number
  timers: Timers
}

export type ViewFetch = {
  /** A hint or a timer: fetches once the gap allows; while one is in flight, queues one more. */
  refresh(): void
  /** A person's action, or a returned write: aborts the fetch in flight and fetches at once. */
  restart(): void
  /** The view closed: aborts the fetch in flight and clears every timer. Nothing runs after it. */
  stop(): void
}

/** The minimum gap of the runs table. */
export const RUNS_TABLE_GAP_MS = 2_000
/** How often every visible view refetches by itself. */
export const SAFETY_REFETCH_MS = 30_000
/** How often it refetches while live updates are off. */
export const LIVE_OFF_REFETCH_MS = 5_000

export function createViewFetch<T>(options: ViewFetchOptions<T>): ViewFetch {
  /** Rises with every fetch started: an answer is applied only when it carries the newest number. */
  let counter = 0
  let controller: AbortController | undefined
  let inFlight = false
  let queued = false
  let lastStart: number | undefined
  let gapTimer: unknown
  let safetyTimer: unknown
  let stopped = false

  function clear(timer: unknown): undefined {
    if (timer !== undefined) options.timers.clear(timer)
    return undefined
  }

  function start(): void {
    counter += 1
    const mine = counter
    controller?.abort()
    controller = new AbortController()
    inFlight = true
    lastStart = options.now()
    gapTimer = clear(gapTimer)
    safetyTimer = clear(safetyTimer)
    const current = (): boolean => mine === counter && !stopped
    let loading: Promise<T>
    try {
      loading = options.load(controller.signal)
    } catch (error) {
      loading = Promise.reject(error)
    }
    loading
      .then(
        (value) => {
          if (current()) options.apply(value)
        },
        (error: unknown) => {
          if (current()) options.fail(error)
        }
      )
      .finally(() => {
        if (!current()) return
        inFlight = false
        safetyTimer = options.timers.set(() => {
          safetyTimer = undefined
          refresh()
        }, typeof options.safetyMs === 'number' ? options.safetyMs : options.safetyMs())
        if (queued) {
          queued = false
          refresh()
        }
      })
  }

  function refresh(): void {
    if (stopped) return
    if (inFlight) {
      queued = true
      return
    }
    if (gapTimer !== undefined) return
    const wait = lastStart === undefined ? 0 : lastStart + options.minGapMs - options.now()
    if (wait <= 0) {
      start()
      return
    }
    gapTimer = options.timers.set(() => {
      gapTimer = undefined
      start()
    }, wait)
  }

  return {
    refresh,
    restart() {
      if (stopped) return
      queued = false
      start()
    },
    stop() {
      stopped = true
      queued = false
      controller?.abort()
      gapTimer = clear(gapTimer)
      safetyTimer = clear(safetyTimer)
    }
  }
}
