// What the Metrics section's worker modules share about Archon's metrics: the cap on Archon's
// free text, the value guards and the all-or-nothing parse of its answers, the metric-name check,
// a judge version's identity, and the number formats of Archon's console (`formatNumber` and
// `formatShare` in the console's metrics `model.ts` of Archon 0.14.0, commit
// 8def159a6b2c23e832a5283b4131cfffd9af9344).

/** Archon's free text is cut here. */
export const METRICS_TEXT_CAP = 500

/** Archon's metric-name pattern and length, from `metricNameSchema`. */
const METRIC_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/
const METRIC_NAME_CAP = 128

export const isMetricName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= METRIC_NAME_CAP && METRIC_NAME.test(value)

export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
export const isCount = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= 0
export const isNullableText = (value: unknown): value is string | null => value === null || typeof value === 'string'
export const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

/** Thrown inside a parse: the whole answer could not be read. */
class Unreadable extends Error {}
export function need(ok: boolean): asserts ok {
  if (!ok) throw new Unreadable()
}
/** The parse's result, or null when it called `need` with a failed check. */
export function readable<T>(parse: () => T): T | null {
  try {
    return parse()
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }
}

/** A judge version of a metric: the instrument and the models that measured it. */
export type Identity = { instrument: string | null; measuredBy: string[] }
export const sameIdentity = (a: Identity, b: Identity): boolean =>
  a.instrument === b.instrument && a.measuredBy.length === b.measuredBy.length && a.measuredBy.every((model, i) => model === b.measuredBy[i])

/** Two decimals, except a nonzero value below 0.01 keeps two significant digits rather than showing 0. */
export function formatNumber(value: number): string {
  return value !== 0 && Math.abs(value) < 0.01
    ? value.toLocaleString('en-US', { maximumSignificantDigits: 2 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** Two significant digits, so a small nonzero share never shows as 0%. */
export const formatShare = (share: number): string => share.toLocaleString('en-US', { style: 'percent', maximumSignificantDigits: 2 })
