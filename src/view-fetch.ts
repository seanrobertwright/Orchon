// The per-view fetch rules, one piece every view of the panel and the tabs reuses (#13, part 5):
// a request counter so only the answer to the newest request is applied; one fetch in flight and
// at most one more queued; a minimum gap between the starts of two fetches; a user action that
// aborts the fetch in flight and starts at once; a safety refetch; and every timer cleared when
// the view closes. It also holds what a view does when Orca rejects its request to the worker
// (#22, part 9): a read rejected as `rate_limited` waits `retryAfterMs` and is sent once more,
// and `consent_required` sets no timer. It is pure logic on the clock and timers it is given; the
// words a view says are in `worker-words.ts`, and what it draws is in `view-notices.tsx`.
import type { Timers } from './client'
import type { ConnectionView } from './connection-view'

export type ViewFetchOptions<T> = {
  /** Fetches the view once. The signal aborts when a newer fetch supersedes it or the view closes. */
  load(signal: AbortSignal): Promise<T>
  /** Called with the answer to the newest fetch only. */
  apply(value: T): void
  /**
   * Called when the newest fetch fails. An older fetch's failure is dropped like its answer, and
   * a first `rate_limited` is not reported: the fetch is sent once more instead. `trouble` is
   * what the person is told about the worker, or null when there is nothing to tell.
   */
  fail(error: unknown, trouble: WorkerTrouble | null): void
  /** The least time between the starts of two fetches that were not asked for by the person. */
  minGapMs: number
  /**
   * How long after its last fetch ended the view fetches again, whatever else happened. It is
   * asked each time the timer is set, so the wait can follow whether live updates are on. Null
   * sets no such timer: the view fetches only when it is asked to, as the Metrics section does.
   */
  safetyMs(): number | null
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

/** Waited when a `rate_limited` rejection names no usable `retryAfterMs`. */
export const RATE_LIMIT_WAIT_MS = 1_000

/** How Orca rejected a frame's request to its own worker, as the view acts on it. */
export type Rejection =
  | { kind: 'rate-limited'; retryAfterMs: number }
  /** The plugin is turned off or needs approval: nothing is tried again by itself. */
  | { kind: 'consent' }
  /** `unavailable`, `timeout` and anything else: the background process is not answering. */
  | { kind: 'unreachable' }

/** Reads a rejected request's `code` and `retryAfterMs`, which Orca sets on the error. */
export function rejectionOf(error: unknown, maxWaitMs = 30_000): Rejection {
  if (typeof error !== 'object' || error === null) return { kind: 'unreachable' }
  const code = Object.hasOwn(error, 'code') ? (error as { code: unknown }).code : undefined
  if (code === 'consent_required') return { kind: 'consent' }
  if (code !== 'rate_limited') return { kind: 'unreachable' }
  const wait = Object.hasOwn(error, 'retryAfterMs') ? (error as { retryAfterMs: unknown }).retryAfterMs : undefined
  const usable = typeof wait === 'number' && Number.isFinite(wait) && wait >= 0
  return { kind: 'rate-limited', retryAfterMs: usable ? Math.min(wait, maxWaitMs) : RATE_LIMIT_WAIT_MS }
}

/**
 * Worker unreachable: what a view says when its requests to its own worker fail. It is not a
 * connection state, because the worker is what reports those. `inARow` counts the view's failed
 * fetches since its last answer.
 */
export type WorkerTrouble = { kind: 'unreachable'; inARow: number } | { kind: 'consent' }

/** The trouble after one more failed fetch. A rate-limited one has no message and changes nothing. */
export function nextTrouble(held: WorkerTrouble | null, rejection: Rejection): WorkerTrouble | null {
  if (rejection.kind === 'rate-limited') return held
  if (rejection.kind === 'consent') return { kind: 'consent' }
  return { kind: 'unreachable', inARow: held?.kind === 'unreachable' ? held.inARow + 1 : 1 }
}

/**
 * Whether a view's controls that write are enabled: only while Connected and while its worker
 * answers. Searching, every state screen and Worker unreachable turn them off; reads stay on.
 */
export function canWrite(connection: ConnectionView['kind'] | null, trouble: WorkerTrouble | null): boolean {
  return connection === 'connected' && trouble === null
}

export function createViewFetch<T>(options: ViewFetchOptions<T>): ViewFetch {
  /** Rises with every fetch started: an answer is applied only when it carries the newest number. */
  let counter = 0
  let controller: AbortController | undefined
  let inFlight = false
  let queued = false
  let lastStart: number | undefined
  let gapTimer: unknown
  let safetyTimer: unknown
  /** The wait before a rate-limited fetch is sent once more. */
  let retryTimer: unknown
  /** What the view's failed fetches since its last answer say about the worker. */
  let trouble: WorkerTrouble | null = null
  let stopped = false

  function clear(timer: unknown): undefined {
    if (timer !== undefined) options.timers.clear(timer)
    return undefined
  }

  /** Starts a fetch. `retried` is set on the one sent again after a `rate_limited` rejection. */
  function start(retried = false): void {
    counter += 1
    const mine = counter
    controller?.abort()
    controller = new AbortController()
    inFlight = true
    lastStart = options.now()
    gapTimer = clear(gapTimer)
    safetyTimer = clear(safetyTimer)
    retryTimer = clear(retryTimer)
    const current = (): boolean => mine === counter && !stopped
    /** Set when Orca asks for consent: no timer fetches again, only a person's action. */
    let consent = false
    let loading: Promise<T>
    try {
      loading = options.load(controller.signal)
    } catch (error) {
      loading = Promise.reject(error)
    }
    loading
      .then(
        (value) => {
          if (!current()) return
          trouble = null
          options.apply(value)
        },
        (error: unknown) => {
          if (!current()) return
          const rejection = rejectionOf(error, options.safetyMs() ?? undefined)
          if (rejection.kind === 'rate-limited' && !retried) {
            // Still in flight: a refresh meanwhile queues behind the one sent again.
            retryTimer = options.timers.set(() => {
              retryTimer = undefined
              start(true)
            }, rejection.retryAfterMs)
            return
          }
          consent = rejection.kind === 'consent'
          trouble = nextTrouble(trouble, rejection)
          options.fail(error, rejection.kind === 'rate-limited' ? null : trouble)
        }
      )
      .finally(() => {
        if (!current() || retryTimer !== undefined) return
        inFlight = false
        const safety = consent ? null : options.safetyMs()
        if (safety !== null) {
          safetyTimer = options.timers.set(() => {
            safetyTimer = undefined
            refresh()
          }, safety)
        }
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
      retryTimer = clear(retryTimer)
    }
  }
}
