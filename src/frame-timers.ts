// The frame's own timers, given to the per-view fetch rules of `view-fetch.ts`.
import type { Timers } from './client'

/** Timers on the frame's clock. Every one is cleared when its view stops. */
export const frameTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}
