// One metric's full figures as Archon reports them, read by hand: every judge version's value,
// interval, cost with its gaps, latest record and daily series. The Details table's validator in
// `metrics.ts` calls this for each metric of a known kind, so a report whose figures fail is
// unreadable as a whole, and the worker holds the figures for a metric's view without reading
// Archon again.
//
// The shape is `metricInstrumentReportSchema` in `packages/workflows/src/schemas/metric.ts` of
// Archon 0.14.0 (commit 8def159a6b2c23e832a5283b4131cfffd9af9344).
import { parseInstant } from './dates'
import { isRecord, own } from './records'

/** Archon's UTC day: `YYYY-MM-DD` (`metricSeriesPointSchema`). It is kept as text and never read as a time. */
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/

export type Identity = { instrument: string | null; measuredBy: string[] }

export type InstrumentFigures = Identity & {
  value: number
  n: number
  interval: { low: number; high: number } | null
  cost: {
    usd: number | null
    inputTokens: number | null
    outputTokens: number | null
    runs: number
    withoutCost: number
    withoutTokens: number
    partialCost: number
    missing: number
  }
  /** `at` is null when Archon's time does not parse: the value and subject still show. */
  latest: { value: number; at: number | null; subject: string | null }
  /** Archon's order: oldest day first. */
  series: { day: string; value: number; n: number }[]
}

/** A metric's headline judge version and the other versions it hides, in Archon's order. */
export type MetricFigures = { headline: InstrumentFigures; others: InstrumentFigures[] }

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isCount = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= 0
const isNullableNumber = (value: unknown): value is number | null => value === null || isFiniteNumber(value)
const isNullableText = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

export const sameIdentity = (a: Identity, b: Identity): boolean =>
  a.instrument === b.instrument && a.measuredBy.length === b.measuredBy.length && a.measuredBy.every((model, i) => model === b.measuredBy[i])

function parseInterval(value: unknown): InstrumentFigures['interval'] | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const low = own(value, 'low')
  const high = own(value, 'high')
  return isFiniteNumber(low) && isFiniteNumber(high) ? { low, high } : undefined
}

function parseCost(value: unknown): InstrumentFigures['cost'] | null {
  if (!isRecord(value)) return null
  const usd = own(value, 'usd')
  const inputTokens = own(value, 'input_tokens')
  const outputTokens = own(value, 'output_tokens')
  const counts = ['runs', 'runs_without_cost', 'runs_without_tokens', 'runs_partial_cost', 'runs_missing'].map((key) => own(value, key))
  if (!isNullableNumber(usd) || !isNullableNumber(inputTokens) || !isNullableNumber(outputTokens) || !counts.every(isCount)) return null
  const [runs, withoutCost, withoutTokens, partialCost, missing] = counts as [number, number, number, number, number]
  return { usd, inputTokens, outputTokens, runs, withoutCost, withoutTokens, partialCost, missing }
}

function parseLatest(value: unknown): InstrumentFigures['latest'] | null {
  if (!isRecord(value)) return null
  const figure = own(value, 'value')
  const at = own(value, 'at')
  const subject = own(value, 'subject')
  if (!isFiniteNumber(figure) || typeof at !== 'string' || !isNullableText(subject)) return null
  return { value: figure, at: parseInstant(at), subject }
}

function parseDay(value: unknown): InstrumentFigures['series'][number] | null {
  if (!isRecord(value)) return null
  const day = own(value, 'day')
  const figure = own(value, 'value')
  const n = own(value, 'n')
  if (typeof day !== 'string' || !UTC_DAY.test(day) || !isFiniteNumber(figure) || !isCount(n)) return null
  return { day, value: figure, n }
}

function parseInstrument(value: unknown): InstrumentFigures | null {
  if (!isRecord(value)) return null
  const instrument = own(value, 'instrument')
  const measuredBy = own(value, 'measured_by')
  const figure = own(value, 'value')
  const n = own(value, 'n')
  const interval = parseInterval(own(value, 'interval'))
  const cost = parseCost(own(value, 'cost'))
  const latest = parseLatest(own(value, 'latest'))
  const series = own(value, 'series')
  if (!isNullableText(instrument) || !isTextList(measuredBy) || !isFiniteNumber(figure) || !isCount(n)) return null
  if (interval === undefined || cost === null || latest === null || !Array.isArray(series)) return null
  const days = series.map(parseDay)
  if (!days.every((day) => day !== null)) return null
  // Archon reports one point per UTC day, and the "By day" table keys its rows by the day.
  if (new Set(days.map((day) => day.day)).size !== days.length) return null
  return { instrument, measuredBy, value: figure, n, interval, cost, latest, series: days }
}

/**
 * The figures of one metric of a known kind, or null when any of them fails, or when Archon does
 * not report the headline judge version among the metric's instruments.
 */
export function parseMetricFigures(metric: Record<string, unknown>): MetricFigures | null {
  const instrument = own(metric, 'headline_instrument')
  const measuredBy = own(metric, 'headline_measured_by')
  const instruments = own(metric, 'instruments')
  if (!isNullableText(instrument) || !isTextList(measuredBy) || !Array.isArray(instruments)) return null
  const parsed = instruments.map(parseInstrument)
  if (!parsed.every((each) => each !== null)) return null
  const identity = { instrument, measuredBy }
  const headline = parsed.find((each) => sameIdentity(each, identity))
  if (headline === undefined) return null
  return { headline, others: parsed.filter((each) => each !== headline) }
}
