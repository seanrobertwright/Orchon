// Calibrations, worked in the worker: the report over 365 days the Metrics read asks Archon for
// after the window's, and what a calibration in it says about a ratio card's share. A
// calibration is a score metric that `calibrates` a count, one record per hand-labelled case
// scored 1 when the judge caught it and 0 when it missed. It counts only at exactly the
// numerator's headline identity, and only with a mean between 0 and 1.
//
// The rules and words are those of Archon's console at 0.14.0 (commit
// 8def159a6b2c23e832a5283b4131cfffd9af9344): `calibrationOf`, `declaredCalibration` and
// `calibrationSentence` in `packages/web/src/experiments/console/routes/metrics/model.ts`,
// `CalibrationPill` and `RatioBody` in `MetricsOverview.tsx`, `MeasuredBox` and
// `UnmatchedCalibrations` in `MetricsDetails.tsx` beside it. The console's model, excerpted:
//
//   const calibrator = find(calibrations.report, declared.metric);
//   const score =
//     calibrator?.calibrates === numerator ? instrumentAt(calibrator, identity) : undefined;
//   if (score === undefined || score.value < 0 || score.value > 1) {
//     return { state: 'not_calibrated' };
//   }
//
// Two differences from the console: the sentence that explains "rough" is said only in a metric's
// view, never on a card, and Overview gives no reason when the report failed, since a badge
// carries no tooltip.
import type { Client, ClientFailure } from './client'
import {
  CALIBRATION_LINES_CAP,
  CALIBRATION_LOADING_TEXT,
  CALIBRATION_UNAVAILABLE_TEXT,
  NOT_CALIBRATED_TEXT,
  ROUGH_TEXT,
  type MetricCalibrations,
  type MetricsCalibrationsPost
} from './calibration-view'
import { cutAt } from './cutter'
import { formatShare, METRICS_TEXT_CAP, sameIdentity, type Identity, type InstrumentFigures } from './metric-figures'
import { formatFigure, METRICS_PATH, parseReport, type Metric, type Report } from './metrics'
import type { MetricsView } from './metrics-view'
import { readFailureText } from './read-failure'
import { isRecord, isText, own } from './records'

/** Calibrations are recorded when a pack calibrates its judge, not every week, so they are read from a year of records. */
export const CALIBRATION_SINCE = '365d'

/** The sentence a calibration report that could not be read says. */
const UNREADABLE_TEXT = "Archon's metrics answer could not be read."

/** What a ratio card declares of its calibration, as `metricViewSchema` names it. */
export type DeclaredCalibration = { metric: string; label: string; roughBelow: number }

/** The year of calibration records: it loads apart from the window, so cards that need none never wait. */
export type Calibrations = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'loaded'; report: Report }

export const CALIBRATIONS_LOADING: Calibrations = { state: 'loading' }

export type Calibration =
  | { state: 'calibrated'; label: string; caught: number; of: number; rough: boolean; roughBelow: number }
  | { state: 'not_calibrated' }
  | { state: 'loading' }
  | { state: 'unavailable'; message: string }

/** A metric's figures at one judge version, the first of that identity in Archon's order. */
function figuresAt(metric: Metric | undefined, identity: Identity): InstrumentFigures | undefined {
  if (metric === undefined || metric.kind === 'unknown') return undefined
  const { headline, others } = metric.figures
  return [headline, ...others].find((each) => sameIdentity(each, identity))
}

/** How far the calibration a ratio card declares vouches for its numerator, at the numerator's headline identity. */
export function calibrationOf(numerator: string, declared: DeclaredCalibration, identity: Identity, calibrations: Calibrations): Calibration {
  if (calibrations.state === 'loading') return { state: 'loading' }
  if (calibrations.state === 'failed') return { state: 'unavailable', message: calibrations.message }
  const calibrator = calibrations.report.metrics.find((metric) => metric.name === declared.metric)
  const score = calibrator?.calibrates === numerator ? figuresAt(calibrator, identity) : undefined
  // A calibration scores each labelled case 1 or 0; a mean outside 0-1 breaks that contract.
  if (score === undefined || score.value < 0 || score.value > 1) return { state: 'not_calibrated' }
  return {
    state: 'calibrated',
    label: declared.label,
    caught: Math.round(score.value * score.n),
    of: score.n,
    rough: score.value < declared.roughBelow,
    roughBelow: declared.roughBelow
  }
}

/** A ratio card's warning badge, or undefined when its calibration holds, as the console's `CalibrationPill`. */
export function calibrationBadge(calibration: Calibration): string | undefined {
  switch (calibration.state) {
    case 'calibrated':
      return calibration.rough ? ROUGH_TEXT : undefined
    case 'not_calibrated':
      return NOT_CALIBRATED_TEXT
    case 'loading':
      return CALIBRATION_LOADING_TEXT
    case 'unavailable':
      return CALIBRATION_UNAVAILABLE_TEXT
  }
}

/** What a ratio card's line adds, such as " · judge catches 9 of 10", or nothing. */
export const calibrationCatches = (calibration: Calibration): string =>
  calibration.state === 'calibrated' ? ` · ${calibration.label} ${String(calibration.caught)} of ${String(calibration.of)}` : ''

/** What "rough" means, from the declared threshold, as the console's `calibrationSentence`. */
export function calibrationSentence(calibration: Extract<Calibration, { state: 'calibrated' }>): string {
  const { label, caught, of, roughBelow } = calibration
  const sentence = `${label} ${String(caught)} of ${String(of)} labelled cases (${formatShare(caught / of)}); below ${formatShare(roughBelow)} the share is rough.`
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** The year-long report for the scope: only `since` and the scope are ever sent. */
export function calibrationPath(codebaseId: string | undefined): string {
  const query = new URLSearchParams({ since: CALIBRATION_SINCE })
  if (codebaseId !== undefined) query.set('codebaseId', codebaseId)
  return `${METRICS_PATH}?${query.toString()}`
}

/** Archon's own message on an error answer, or the plugin's sentence for the failure. */
function failureText(failure: ClientFailure): string {
  if (failure.kind === 'status' && isRecord(failure.body)) {
    const error = own(failure.body, 'error')
    if (isText(error)) return cutAt(error, METRICS_TEXT_CAP)
  }
  return readFailureText(failure)
}

/** Reads the year-long report under the report timeout. It never throws: a failure is a state. */
export async function readCalibrations(client: Client, baseUrl: string, codebaseId: string | undefined, signal: AbortSignal): Promise<Calibrations> {
  const answer = await client.request({ baseUrl, signal, errorBody: true, path: calibrationPath(codebaseId), timeout: 'report' })
  if (!answer.ok) return { state: 'failed', message: failureText(answer.failure) }
  const report = parseReport(answer.value)
  return report === null ? { state: 'failed', message: UNREADABLE_TEXT } : { state: 'loaded', report }
}

/** One ratio card that declares a calibration: what it counts, and the calibration it declares. */
export type CalibratedRatio = { numerator: string; calibration: DeclaredCalibration }

/**
 * A metric's calibrations for its view: one line per score of the year that calibrates it, read
 * at the metric's headline identity in the window, and the sentence that explains "rough" when
 * the first ratio a pack declares for it carries a calibration that counts.
 */
export function metricCalibrations(
  metric: Metric,
  calibrations: Calibrations,
  ratios: readonly CalibratedRatio[],
  names: ReadonlyMap<string, string>
): MetricCalibrations {
  if (calibrations.state === 'loading') return { state: 'loading' }
  if (calibrations.state === 'failed') return { state: 'unavailable', message: calibrations.message }
  if (metric.kind === 'unknown') return { state: 'loaded', lines: [], more: 0, sentence: null }
  const identity = metric.figures.headline
  const lines = calibrations.report.metrics
    .filter((other) => other.calibrates === metric.name)
    .map((calibrator) => {
      const score = figuresAt(calibrator, identity)
      const name = names.get(calibrator.name) ?? calibrator.name
      return score === undefined || calibrator.kind === 'unknown'
        ? `${name}: not calibrated for this version`
        : `${name}: ${formatFigure(score.value, calibrator.unit)} from ${String(score.n)} records`
    })
  const declared = ratios.find((ratio) => ratio.numerator === metric.name)
  const calibration = declared === undefined ? undefined : calibrationOf(metric.name, declared.calibration, identity, calibrations)
  return {
    state: 'loaded',
    lines: lines.slice(0, CALIBRATION_LINES_CAP),
    more: Math.max(0, lines.length - CALIBRATION_LINES_CAP),
    sentence: calibration?.state === 'calibrated' ? calibrationSentence(calibration) : null
  }
}

/**
 * The calibrations in the window's report whose metric has no records in it, for the lines under
 * the Details table, at most `CALIBRATION_LINES_CAP`, as the console's `UnmatchedCalibrations`.
 */
export function uncalibratedLines(report: Report): { lines: string[]; more: number } {
  const recorded = new Set(report.metrics.map((metric) => metric.name))
  const lines = report.metrics.flatMap((metric) => {
    if (metric.calibrates === null || recorded.has(metric.calibrates)) return []
    const figure =
      metric.kind === 'unknown' ? '.' : `: ${formatFigure(metric.figures.headline.value, metric.unit)} from ${String(metric.figures.headline.n)} records.`
    return [`${metric.name} calibrates ${metric.calibrates}, which has no records in this window${figure}`]
  })
  return { lines: lines.slice(0, CALIBRATION_LINES_CAP), more: Math.max(0, lines.length - CALIBRATION_LINES_CAP) }
}

/** The post that carries a read's cards again with their calibration markers, for the report it follows. */
export function calibrationsPost(view: Extract<MetricsView, { kind: 'ready' }>): MetricsCalibrationsPost {
  const post: MetricsCalibrationsPost = { window: view.window, fetchedAt: view.fetchedAt, overview: view.overview }
  if (view.codebaseId !== undefined) post.codebaseId = view.codebaseId
  return post
}
