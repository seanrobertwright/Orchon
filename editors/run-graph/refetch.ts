// The tab's fetch rules, the same as run detail's in the panel (#13, part 5): one read in flight
// and at most one more queued, at least a second between the starts of two reads nobody asked
// for, a person's action that reads at once, a safety read after each one, and every timer
// cleared when the tab closes. The panel's own module, src/view-fetch.ts, cannot be loaded here:
// the editors compile on their own and import nothing from src/. It keeps no clock: the gap is a
// timer.

export type TabTimers = {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export type RefetchOptions = {
  /** Reads the view once; it settles when the answer has been drawn or dropped. */
  load(): Promise<void>
  /** The least time between the starts of two reads nobody asked for. */
  gapMs: number
  /** How long after a read ended the next safety read starts, asked each time. */
  safetyMs(): number
  timers: TabTimers
}

export type Refetch = {
  /** A hint or a timer: reads once the gap allows; while one is in flight, queues one more. */
  refresh(): void
  /** A person's action: reads at once. */
  restart(): void
  /** The tab closed: no timer is left, and nothing reads again. */
  stop(): void
}

export function createRefetch(options: RefetchOptions): Refetch {
  let inFlight = 0
  let queued = false
  let gapOpen = true
  let gapTimer: unknown
  let safetyTimer: unknown
  let stopped = false

  const clear = (timer: unknown): undefined => {
    if (timer !== undefined) options.timers.clear(timer)
    return undefined
  }

  function start(): void {
    if (stopped) return
    queued = false
    gapOpen = false
    gapTimer = clear(gapTimer)
    gapTimer = options.timers.set(() => {
      gapTimer = undefined
      gapOpen = true
      if (queued && inFlight === 0) start()
    }, options.gapMs)
    safetyTimer = clear(safetyTimer)
    inFlight += 1
    void options
      .load()
      .catch(() => {})
      .finally(() => {
        inFlight -= 1
        if (stopped || inFlight > 0) return
        safetyTimer = clear(safetyTimer)
        safetyTimer = options.timers.set(() => {
          safetyTimer = undefined
          refresh()
        }, options.safetyMs())
        if (queued && gapOpen) start()
      })
  }

  function refresh(): void {
    if (stopped) return
    if (inFlight > 0 || !gapOpen) queued = true
    else start()
  }

  return {
    refresh,
    restart: start,
    stop() {
      stopped = true
      gapTimer = clear(gapTimer)
      safetyTimer = clear(safetyTimer)
    }
  }
}
