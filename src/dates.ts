// The one date helper. Every "now", every parse of a date and every formatted time in the code
// Orca loads goes through this file: the lint config refuses `Date` and `Intl.DateTimeFormat` in
// the rest of that code, so no other module can read the clock or turn a date into local time by
// accident.

/** Now, in milliseconds since the epoch. */
export function now(): number {
  return Date.now()
}

/** Date, then `T` or a space, then time with optional fraction, then an optional zone. */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/

/** Minutes east of UTC that a zone suffix names, or null when it is out of range. */
function zoneMinutes(zone: string | undefined): number | null {
  if (zone === undefined || zone === 'Z') return 0
  const hours = Number(zone.slice(1, 3))
  const minutes = Number(zone.slice(4, 6))
  if (hours > 23 || minutes > 59) return null
  return (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes)
}

/**
 * The instant a text names, in milliseconds since the epoch, or null when it names none. A text
 * with no zone is read as UTC, never as the machine's local time. A date alone is not an instant.
 */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = INSTANT.exec(value)
  if (match === null) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number
  ]
  const offset = zoneMinutes(match[8])
  if (offset === null || hour > 23 || minute > 59 || second > 59) return null
  const millisecond = Math.floor(Number(`0.${match[7] ?? '0'}`) * 1000)
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  // Date.UTC rolls a day that does not exist into the next month: refuse it instead.
  const check = new Date(utc)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }
  return utc - offset * 60_000
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

/** The furthest instant from the epoch that a date can hold, in milliseconds. */
const LAST_INSTANT = 8.64e15

/**
 * A wall-clock time such as "14:32", in the machine's own zone and written as `locale` writes
 * it. A locale the runtime does not know falls back to the runtime's default. A time that no
 * date can hold (not a finite number, or past the last instant) gives an empty text.
 */
export function formatClock(at: number, locale: string): string {
  if (!Number.isFinite(at) || Math.abs(at) > LAST_INSTANT) return ''
  try {
    return new Intl.DateTimeFormat(locale, CLOCK).format(at)
  } catch {
    return new Intl.DateTimeFormat(undefined, CLOCK).format(at)
  }
}

const UNITS: readonly [string, number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000]
]

/**
 * A length of time in its shortest form: its two largest units, such as "3s", "2m 5s", "1h 4m"
 * or "2d 3h", with a zero second unit left out. A part of a second is dropped. A duration that
 * is negative or not finite gives an empty text.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const first = UNITS.findIndex(([, size]) => ms >= size)
  if (first === -1) return '0s'
  const parts: string[] = []
  let rest = ms
  for (const [unit, size] of UNITS.slice(first, first + 2)) {
    const count = Math.floor(rest / size)
    rest -= count * size
    if (count > 0) parts.push(`${String(count)}${unit}`)
  }
  return parts.join(' ')
}
