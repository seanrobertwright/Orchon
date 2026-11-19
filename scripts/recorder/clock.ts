// The recorder's one reading of the time: when a recording was made, for its log.

/** Now, as an ISO 8601 time in UTC to the second. */
export function nowIso(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`
}
