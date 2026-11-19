// The recorder's one reading of the time: when a recording was made, for its log.
//
// It is not `src/dates.ts`. That helper serves the shipped plugin: it reads the clock and parses
// and formats instants for what Orca shows, and has no UTC stamp. Adding one there would put code
// in the shipped plugin that only this script calls. The README's date ban names the scripts as
// its exception, and inside the recorder this file is the one clock.

/** Now, as an ISO 8601 time in UTC to the second. */
export function nowIso(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`
}
