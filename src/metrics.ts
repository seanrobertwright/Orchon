// The Metrics section's read: a frame sends the scope and the window, and the worker reads the
// card declarations and the window's report from Archon, validates them by hand and answers the
// Details rows of `metrics-view.ts`, never Archon's report. It keeps the last report it read, in
// memory only, so a return to the section within `METRICS_MAX_AGE_MS` asks Archon nothing, and it keeps the
// person's window in plugin storage.
//
// The report's shape is `metricsReportSchema` in `packages/workflows/src/schemas/metric.ts` of
// Archon 0.14.0 (commit 8def159a6b2c23e832a5283b4131cfffd9af9344); the declarations' `names` are
// read from `metricViewsListingSchema` beside it. The figures are written as Archon's console
// writes them (`formatValue`, `formatFigure` and `formatUsd` in the console's metrics `model.ts`).
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client, ClientFailure, Timers } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { cutAt } from './cutter'
import { parseInstant } from './dates'
import { parseMetricFigures, type MetricFigures } from './metric-figures'
import {
  DEFAULT_WINDOW,
  DETAILS_ROWS_CAP,
  METRICS_MAX_AGE_MS,
  METRICS_WINDOWS,
  REFUSALS_CAP,
  type MetricRow,
  type MetricsAnswer,
  type MetricsRequest,
  type MetricsView,
  type MetricsWindow,
  type RefusalRow
} from './metrics-view'
import { readFailureText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { PROJECT_ID_CAP } from './scope-view'

export const METRICS_PATH = '/api/metrics'
export const METRIC_VIEWS_PATH = '/api/metric-views'

/** Where the person's window is kept in plugin storage. */
export const WINDOW_STORAGE_KEY = 'metrics-window'
/** How long a chosen window waits before it is written, so quick presses write once. */
export const WINDOW_WRITE_PAUSE_MS = 1_000

/** Archon's metric-name pattern and length, from `metricNameSchema`. */
const METRIC_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/
const METRIC_NAME_CAP = 128
/** Archon's free text is cut here. */
export const METRICS_TEXT_CAP = 500
/** A plain name or a unit longer than this is not read as one. */
const LABEL_CAP = 200

const KNOWN_KINDS = new Set(['count', 'score'])

const isWindow = (value: unknown): value is MetricsWindow => METRICS_WINDOWS.some((window) => window === value)

/** A frame's request, or a refusal. */
export function parseMetricsRequest(input: unknown): MetricsRequest {
  if (input === undefined || input === null) return {}
  if (!isRecord(input)) refuseRequest('The metrics request takes a project id, a window and whether to refresh, or nothing.')
  refuseOtherKeys(input, ['codebaseId', 'window', 'refresh'], 'The metrics request')
  const request: MetricsRequest = {}
  if (Object.hasOwn(input, 'codebaseId')) {
    const codebaseId = own(input, 'codebaseId')
    if (!isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
    request.codebaseId = codebaseId
  }
  if (Object.hasOwn(input, 'window')) {
    const window = own(input, 'window')
    if (!isWindow(window)) refuseRequest(`The window must be one of ${METRICS_WINDOWS.join(', ')}.`)
    request.window = window
  }
  if (Object.hasOwn(input, 'refresh')) {
    if (own(input, 'refresh') !== true) refuseRequest('Refresh is true or left out.')
    request.refresh = true
  }
  return request
}

export const isMetricName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= METRIC_NAME_CAP && METRIC_NAME.test(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isCount = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= 0
const isNullableText = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

/** Thrown inside the report's parse: the whole answer could not be read. */
class Unreadable extends Error {}
function need(ok: boolean): asserts ok {
  if (!ok) throw new Unreadable()
}

/** The plain names every readable pack declares, the first pack's winning, as the console reads them. */
export function parseNames(value: unknown): Map<string, string> | null {
  if (!isRecord(value) || !Array.isArray(own(value, 'packs'))) return null
  const names = new Map<string, string>()
  for (const pack of own(value, 'packs') as unknown[]) {
    if (!isRecord(pack)) continue
    const declared = own(pack, 'names')
    if (!isRecord(declared)) continue
    for (const metric of Object.keys(declared)) {
      const name = own(declared, metric)
      if (isMetricName(metric) && isCappedText(name, LABEL_CAP) && !names.has(metric)) names.set(metric, name)
    }
  }
  return names
}

type Identity = { instrument: string | null; measuredBy: string[] }
const sameIdentity = (a: Identity, b: Identity): boolean =>
  a.instrument === b.instrument && a.measuredBy.length === b.measuredBy.length && a.measuredBy.every((model, i) => model === b.measuredBy[i])

/** One instrument's figures the Details table reads. */
type Figures = { value: number; n: number; usd: number | null; latest: number }

function parseInstrument(value: unknown): Identity & Figures {
  need(isRecord(value))
  const instrument = own(value, 'instrument')
  const measuredBy = own(value, 'measured_by')
  const figure = own(value, 'value')
  const n = own(value, 'n')
  const cost = own(value, 'cost')
  const latest = own(value, 'latest')
  need(isNullableText(instrument) && isTextList(measuredBy) && isFiniteNumber(figure) && isCount(n))
  need(isRecord(cost) && isRecord(latest))
  const usd = own(cost, 'usd')
  const latestValue = own(latest, 'value')
  need((usd === null || isFiniteNumber(usd)) && isFiniteNumber(latestValue))
  return { instrument, measuredBy, value: figure, n, usd, latest: latestValue }
}

/** A metric as the table reads it: unknown kinds carry nothing but their name. */
export type Metric =
  | { name: string; kind: 'known'; unit: string; calibration: boolean; headline: Figures; figures: MetricFigures }
  | { name: string; kind: 'unknown'; calibration: boolean }

function parseMetric(value: unknown): Metric {
  need(isRecord(value))
  const name = own(value, 'name')
  const kind = own(value, 'kind')
  const calibrates = own(value, 'calibrates')
  need(isMetricName(name) && isText(kind))
  // A calibration names the metric it calibrates; one whose kind Orchon does not know is still one.
  need(calibrates === undefined || calibrates === null || isMetricName(calibrates))
  const calibration = typeof calibrates === 'string'
  if (!KNOWN_KINDS.has(kind)) return { name, kind: 'unknown', calibration }
  const unit = own(value, 'unit')
  const headlineInstrument = own(value, 'headline_instrument')
  const headlineMeasuredBy = own(value, 'headline_measured_by')
  const instruments = own(value, 'instruments')
  need(isCappedText(unit, LABEL_CAP) && calibrates !== undefined)
  need(isNullableText(headlineInstrument) && isTextList(headlineMeasuredBy) && Array.isArray(instruments))
  const parsed = instruments.map(parseInstrument)
  // Archon always reports the headline judge version among the metric's instruments.
  const headline = parsed.find((instrument) => sameIdentity(instrument, { instrument: headlineInstrument, measuredBy: headlineMeasuredBy }))
  need(headline !== undefined)
  // The rest of the figures, which a metric's view shows: a part that fails fails the whole answer.
  const figures = parseMetricFigures(value)
  need(figures !== null)
  return { name, kind: 'known', unit, calibration, headline, figures }
}

function parseRefusal(value: unknown): RefusalRow | null {
  if (!isRecord(value)) return null
  const reason = own(value, 'reason')
  const runId = own(value, 'run_id')
  const workflowName = own(value, 'workflow_name')
  const nodeId = own(value, 'node_id')
  if (!isText(reason) || !isText(runId) || !isText(workflowName) || !isText(nodeId)) return null
  return {
    reason: cutAt(reason, METRICS_TEXT_CAP),
    runId: cutAt(runId, METRICS_TEXT_CAP),
    workflowName: cutAt(workflowName, METRICS_TEXT_CAP),
    nodeId: cutAt(nodeId, METRICS_TEXT_CAP)
  }
}

export type Report = { since: number; until: number; metrics: Metric[]; refused: RefusalRow[]; refusedTotal: number }

/** Archon's report, or null when any part the plugin reads fails. */
export function parseReport(value: unknown): Report | null {
  try {
    need(isRecord(value))
    const window = own(value, 'window')
    const metrics = own(value, 'metrics')
    const refused = own(value, 'refused')
    need(isRecord(window) && Array.isArray(metrics) && Array.isArray(refused))
    const since = parseInstant(own(window, 'since'))
    const until = parseInstant(own(window, 'until'))
    need(since !== null && until !== null)
    const rows: RefusalRow[] = []
    for (const refusal of refused as unknown[]) {
      if (rows.length >= REFUSALS_CAP) break
      const row = parseRefusal(refusal)
      if (row !== null) rows.push(row)
    }
    return { since, until, metrics: metrics.map(parseMetric), refused: rows, refusedTotal: refused.length }
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }
}

/** Two decimals, except a nonzero value below 0.01 keeps two significant digits rather than showing 0. */
export function formatNumber(value: number): string {
  return value !== 0 && Math.abs(value) < 0.01
    ? value.toLocaleString('en-US', { maximumSignificantDigits: 2 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
const formatShare = (share: number): string => share.toLocaleString('en-US', { style: 'percent', maximumSignificantDigits: 2 })
/** A value in its unit's terms: a `ratio` is a percentage, anything else a plain number. */
export const formatFigure = (value: number, unit: string): string => (unit === 'ratio' ? formatShare(value) : formatNumber(value))
/** `prs` is the guide's own example unit; other units read with their underscores as spaces. */
const UNIT_WORDS: ReadonlyMap<string, string> = new Map([['prs', 'PRs']])
/** A value with its unit: a `ratio`'s percentage says its own unit, anything else adds the unit's word. */
export function formatValue(value: number, unit: string): string {
  const figure = formatFigure(value, unit)
  return unit === 'ratio' ? figure : `${figure} ${UNIT_WORDS.get(unit) ?? unit.replaceAll('_', ' ')}`
}

/** The Details table: by name, calibrations left out, at most `DETAILS_ROWS_CAP` rows. */
export function detailsRows(report: Report, names: ReadonlyMap<string, string>): { rows: MetricRow[]; more: number } {
  const all = report.metrics
    .filter((metric) => !metric.calibration)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((metric): MetricRow => {
      const label = names.get(metric.name) ?? metric.name
      if (metric.kind === 'unknown') return { name: metric.name, label, state: 'unknown-kind' }
      const { headline, unit } = metric
      return {
        name: metric.name,
        label,
        state: 'shown',
        value: formatValue(headline.value, unit),
        records: headline.n,
        knownCost: headline.usd === null ? 'none recorded' : `≥ $${formatNumber(headline.usd)}`,
        latest: formatFigure(headline.latest, unit)
      }
    })
  return { rows: all.slice(0, DETAILS_ROWS_CAP), more: Math.max(0, all.length - DETAILS_ROWS_CAP) }
}

function viewsPath(codebaseId: string | undefined): string {
  return codebaseId === undefined ? METRIC_VIEWS_PATH : `${METRIC_VIEWS_PATH}?${new URLSearchParams({ codebaseId }).toString()}`
}

/** Only `since` and the scope are ever sent: never `compare`, `byModel` or `subject`. */
function reportPath(window: MetricsWindow, codebaseId: string | undefined): string {
  const query = new URLSearchParams({ since: window })
  if (codebaseId !== undefined) query.set('codebaseId', codebaseId)
  return `${METRICS_PATH}?${query.toString()}`
}

/** Archon's own message on an error answer, or the plugin's sentence for the failure. */
function failureMessage(failure: ClientFailure): string {
  if (failure.kind === 'status' && isRecord(failure.body)) {
    const error = own(failure.body, 'error')
    if (isText(error)) return cutAt(error, METRICS_TEXT_CAP)
  }
  return readFailureText(failure)
}

/** What a failed metrics read shows: the same for the Details table and a metric's view. */
export function failedView(failure: ClientFailure, connection: Connected): Extract<MetricsView, { kind: 'missing' | 'timeout' | 'too-large' | 'failed' }> {
  if (failure.kind === 'timeout') return { kind: 'timeout' }
  if (failure.kind === 'too-large') return { kind: 'too-large' }
  // A release before 0.14.0 answers the metrics routes with its HTML page.
  if (failure.kind === 'not-json') return { kind: 'missing', message: metricsMissing(connection) }
  return { kind: 'failed', message: failureMessage(failure) }
}

/** Which server, store, scope and window a held report is for. */
export function reportKey(connection: Connected, codebaseId: string | undefined, window: MetricsWindow): string {
  return JSON.stringify([connection.baseUrl, connection.storeId, codebaseId ?? null, window])
}

export type MetricsPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
  now(): number
  timers: Timers
}

/** The last report the worker read: which server, scope and window it is for, and when. */
type Held = { key: string; view: Extract<MetricsView, { kind: 'ready' }>; report: Report }

/** The metrics reads, and the report the worker holds for a key of `reportKey`, if it holds that one. */
export type Metrics = Disposable & { held(key: string): Report | undefined }

/** Answers the frames' `metrics.read`. */
export function startMetrics(orca: OrcaWorkerApi, ports: MetricsPorts): Metrics {
  let held: Held | undefined
  let chosen: Promise<MetricsWindow> | undefined
  let window: MetricsWindow = DEFAULT_WINDOW
  let pending: unknown

  function keptWindow(): Promise<MetricsWindow> {
    chosen ??= orca.storage.get(WINDOW_STORAGE_KEY).then(
      (value) => (window = isWindow(value) ? value : DEFAULT_WINDOW),
      () => window
    )
    return chosen.then(() => window)
  }

  function flush(): void {
    if (pending === undefined) return
    ports.timers.clear(pending)
    pending = undefined
    orca.storage.set(WINDOW_STORAGE_KEY, window).catch((error: unknown) => orca.log(`Orchon could not save the metrics window: ${String(error)}`))
  }

  async function choose(next: MetricsWindow): Promise<void> {
    if ((await keptWindow()) === next && pending === undefined) return
    window = next
    if (pending !== undefined) ports.timers.clear(pending)
    pending = ports.timers.set(flush, WINDOW_WRITE_PAUSE_MS)
  }

  async function readView(request: MetricsRequest, requestedWindow: MetricsWindow, signal: AbortSignal): Promise<MetricsView> {
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { kind: 'not-connected' }
    if (!connection.features.metrics) return { kind: 'missing', message: metricsMissing(connection) }
    const key = reportKey(connection, request.codebaseId, requestedWindow)
    if (request.refresh !== true && held?.key === key && ports.now() - held.view.fetchedAt <= METRICS_MAX_AGE_MS) return held.view
    const call = { baseUrl: connection.baseUrl, signal, errorBody: true } as const
    const views = await ports.client.request({ ...call, path: viewsPath(request.codebaseId), timeout: 'read' })
    const failed = (failure: ClientFailure): MetricsView => failedView(failure, connection)
    if (!views.ok) return failed(views.failure)
    const names = parseNames(views.value)
    if (names === null) return { kind: 'unreadable' }
    const answer = await ports.client.request({ ...call, path: reportPath(requestedWindow, request.codebaseId), timeout: 'report' })
    if (!answer.ok) return failed(answer.failure)
    const report = parseReport(answer.value)
    if (report === null) return { kind: 'unreadable' }
    const { rows, more } = detailsRows(report, names)
    const view: Extract<MetricsView, { kind: 'ready' }> = {
      kind: 'ready',
      window: requestedWindow,
      since: report.since,
      until: report.until,
      fetchedAt: ports.now(),
      rows,
      more,
      refused: report.refused,
      refusedTotal: report.refusedTotal
    }
    if (request.codebaseId !== undefined) view.codebaseId = request.codebaseId
    held = { key, view, report }
    return view
  }

  const handle = orca.panels.handle('metrics.read', async (input, context): Promise<MetricsAnswer> => {
    const request = parseMetricsRequest(input)
    if (request.window !== undefined) await choose(request.window)
    const requestedWindow = request.window ?? (await keptWindow())
    const metrics = await readView(request, requestedWindow, context.signal)
    return { connection: await ports.current(), window: requestedWindow, metrics }
  })
  return {
    held: (key) => (held?.key === key ? held.report : undefined),
    dispose() {
      handle.dispose()
      // A window that waits for the pause is written now, so the choice outlives the worker.
      flush()
    }
  }
}
