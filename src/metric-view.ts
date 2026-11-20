// A metric's view as a frame gets it: the request a panel sends when a row of the Details table
// is selected, and the trimmed view model the worker answers. It is types and constants only, so
// the panel and the worker read one contract and none of Archon's report crosses to the panel.
// The Details rows stay small (`metrics-view.ts`); one metric's figures and its "By day" rows
// travel only on this request.
import type { ConnectionAnswer } from './connection-view'
import type { MetricsWindow } from './metrics-view'

/** How many older judge versions a metric's view lists at most, in Archon's order. */
export const OLDER_VERSIONS_CAP = 5

/** How many days the "By day" table holds at most, newest first: a 90 day window touches 91 UTC days. */
export const BY_DAY_CAP = 91

/**
 * What a panel sends: the dotted name of the selected row and the scope and window of the report
 * on screen. The worker answers from the report it holds for that scope and window, and reads
 * Archon for that one metric by `name` only when it holds none, as after a restart.
 */
export type MetricRequest = { name: string; window: MetricsWindow; codebaseId?: string }

/** One day of the "By day" table. */
export type MetricDay = {
  /** Archon's UTC day, `YYYY-MM-DD`, exactly as Archon gave it. */
  day: string
  /** The day's value in the metric's unit. */
  value: string
  records: number
}

/** One metric's figures at its headline judge version, written as the console writes them. */
export type MetricDetail = {
  /** The dotted name, Archon's own. */
  name: string
  /** The headline judge version, such as "judge-v2 on claude-opus", or null when the records name no instrument. */
  judgeVersion: string | null
  /** The window's value with its unit, such as "4 items" or "70%". */
  value: string
  /** The 95% interval, such as "20% – 120%", or null when Archon reports none. */
  interval: string | null
  /** How many records the value is based on. */
  records: number
  /** "≥ $1.42", or "none recorded" when no run recorded a cost. */
  knownCost: string
  /** How many runs produced the records. */
  runs: number
  /** The runs whose cost the known cost leaves out or covers only in part. */
  gaps: { withoutCost: number; withoutTokens: number; partialCost: number; missing: number }
  /** "1,200 in / 300 out tokens", or "no tokens recorded". */
  tokens: string
  latest: {
    /** The latest record's value in the metric's unit. */
    value: string
    /** When it was recorded, in milliseconds since the epoch, or null when Archon's time does not parse. */
    at: number | null
    /** What it was recorded about, or null when Archon names nothing. */
    subject: string | null
  }
  /** The other judge versions the headline hides, in Archon's order, at most `OLDER_VERSIONS_CAP`. */
  olderVersions: string[]
  /** How many older judge versions past the cap are not listed. */
  olderMore: number
  /** The daily figures, newest first, at most `BY_DAY_CAP`. */
  byDay: MetricDay[]
  /** How many days past the cap are not shown. */
  byDayMore: number
}

export type MetricView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /** The server has no metrics: its path list lacks them, or it answered with its HTML page. */
  | { kind: 'missing'; message: string }
  | { kind: 'ready'; metric: MetricDetail }
  /** The report has no metric of that name. */
  | { kind: 'absent' }
  /** A metric of a kind this version of Orchon does not know: it has no figures to show. */
  | { kind: 'unknown-kind' }
  /** The read failed: the same failures, and the same words, as the Details table's. */
  | { kind: 'timeout' }
  | { kind: 'too-large' }
  | { kind: 'unreadable' }
  | { kind: 'failed'; message: string }

export type MetricAnswer = ConnectionAnswer & { metric: MetricView }
