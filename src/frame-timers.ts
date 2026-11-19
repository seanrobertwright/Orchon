// The panel frames' real timers: what each section's fetch rules wait on in Orca.
import type { Timers } from './client'

/** `setTimeout` and `clearTimeout`, as the fetch rules take them. */
export const frameTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}
