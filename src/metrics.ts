// The Metrics section's read: a frame sends the scope and the window, and the worker reads the
// card declarations and the window's report from Archon, in that order, validates them by hand
// and answers the Overview cards of `overview-cards.ts` and the Details rows of `metrics-view.ts`,
// never Archon's report. Once the declarations answer it posts their titles as `metrics.cards`.
// Once it has answered, it reads the year-long report for calibrations (`calibrations.ts`), one
// request at a time, and posts the cards again with their markers as `metrics.calibrations`.
// It keeps the last report it read, in memory only, so a return to the section within
// `METRICS_MAX_AGE_MS` asks Archon nothing and a metric's view (`metric-detail.ts`) answers from
// it, and it keeps the person's window in plugin storage.
//
// The report's shape is `metricsReportSchema` in `packages/workflows/src/schemas/metric.ts` of
// Archon 0.14.0 (commit 8def159a6b2c23e832a5283b4131cfffd9af9344); the declarations' `names` are
// read from `metricViewsListingSchema` beside it. The figures are written as Archon's console
// writes them (`formatValue`, `formatFigure` and `formatUsd` in the console's metrics `model.ts`).
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { CALIBRATIONS_LOADING, calibrationsPost, readCalibrations, unmatchedCalibrations, type CalibratedRatio, type Calibrations } from './calibrations'
import type { Client, ClientFailure, Timers } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { cutAt } from './cutter'
import { parseInstant } from './dates'
import {
  formatNumber,
  formatShare,
  isMetricName,
  METRICS_TEXT_CAP,
  need,
  parseMetricFigures,
  readable,
  type MetricFigures
} from './metric-figures'
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
import { calibratedRatios, cardReportOf, cardsPost, overviewOf, parseCardDeclarations, unknownsLine, type CardDeclarations } from './overview-cards'
import { readFailureText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { PROJECT_ID_CAP } from './scope-view'

export const METRICS_PATH = '/api/metrics'
export const METRIC_VIEWS_PATH = '/api/metric-views'

/** Where the person's window is kept in plugin storage. */
export const WINDOW_STORAGE_KEY = 'metrics-window'
/** How long a chosen window waits before it is written, so quick presses write once. */
export const WINDOW_WRITE_PAUSE_MS = 1_000

/** A plain name or a unit longer than this is not read as one. */
const LABEL_CAP = 200

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

/**
 * A metric as the table, the cards and a metric's view read it: unknown kinds carry nothing but
 * their name and the metric they calibrate, or null.
 */
export type Metric =
  | { name: string; kind: 'count' | 'score'; unit: string; calibrates: string | null; figures: MetricFigures }
  | { name: string; kind: 'unknown'; calibrates: string | null }

function parseMetric(value: unknown): Metric {
  need(isRecord(value))
  const name = own(value, 'name')
  const kind = own(value, 'kind')
  const calibrates = own(value, 'calibrates')
  need(isMetricName(name) && isText(kind))
  // A calibration names the metric it calibrates; one whose kind Orchon does not know is still one.
  need(calibrates === undefined || calibrates === null || isMetricName(calibrates))
  const target = typeof calibrates === 'string' ? calibrates : null
  if (kind !== 'count' && kind !== 'score') return { name, kind: 'unknown', calibrates: target }
  const unit = own(value, 'unit')
  need(isCappedText(unit, LABEL_CAP) && calibrates !== undefined)
  // Every judge version's figures, the headline's among them: a part that fails fails the whole answer.
  const figures = parseMetricFigures(value)
  need(figures !== null)
  return { name, kind, unit, calibrates: target, figures }
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
  return readable(() => {
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
  })
}

/** A value in its unit's terms: a `ratio` is a percentage, anything else a plain number. */
export const formatFigure = (value: number, unit: string): string => (unit === 'ratio' ? formatShare(value) : formatNumber(value))
/** `prs` is the guide's own example unit; other units read with their underscores as spaces. */
const UNIT_WORDS: ReadonlyMap<string, string> = new Map([['prs', 'PRs']])
/** A value with its unit: a `ratio`'s percentage says its own unit, anything else adds the unit's word. */
export function formatValue(value: number, unit: string): string {
  const figure = formatFigure(value, unit)
  return unit === 'ratio' ? figure : `${figure} ${UNIT_WORDS.get(unit) ?? unit.replaceAll('_', ' ')}`
}

/** A known cost as the console writes it: at least the dollars recorded, or none recorded. */
export const formatKnownCost = (usd: number | null): string => (usd === null ? 'none recorded' : `≥ $${formatNumber(usd)}`)

/** The Details table: by name, calibrations left out, at most `DETAILS_ROWS_CAP` rows. */
export function detailsRows(report: Report, names: ReadonlyMap<string, string>): { rows: MetricRow[]; more: number } {
  const all = report.metrics
    .filter((metric) => metric.calibrates === null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((metric): MetricRow => {
      const label = names.get(metric.name) ?? metric.name
      if (metric.kind === 'unknown') return { name: metric.name, label, state: 'unknown-kind' }
      const { unit } = metric
      const { headline } = metric.figures
      return {
        name: metric.name,
        label,
        state: 'shown',
        value: formatValue(headline.value, unit),
        records: headline.n,
        knownCost: formatKnownCost(headline.cost.usd),
        latest: formatFigure(headline.latest.value, unit)
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

/**
 * The last report the worker read: which server, scope and window it is for, and when, with the
 * declarations it was read with and the year-long report for calibrations as it stands.
 */
type Held = {
  key: string
  view: Extract<MetricsView, { kind: 'ready' }>
  report: Report
  cards: CardDeclarations
  names: ReadonlyMap<string, string>
  /** The ratio cards of `cards` that declare a calibration, worked out once for the read. */
  ratios: CalibratedRatio[]
  calibrations: Calibrations
}

/** What a metric's view reads of the held report beside the report itself. */
export type HeldCalibrations = { calibrations: Calibrations; names: ReadonlyMap<string, string>; ratios: readonly CalibratedRatio[] }

/**
 * The metrics reads, and the report the worker holds for a key of `reportKey`, if it holds that
 * one, with its calibrations.
 */
export type Metrics = Disposable & { held(key: string): Report | undefined; calibrations(key: string): HeldCalibrations | undefined }

/** Answers the frames' `metrics.read`. */
export function startMetrics(orca: OrcaWorkerApi, ports: MetricsPorts): Metrics {
  let held: Held | undefined
  let chosen: Promise<MetricsWindow> | undefined
  let window: MetricsWindow = DEFAULT_WINDOW
  let pending: unknown
  /** The year-long report in flight, which a new read of Archon stops, so one request runs at a time. */
  let calibrationRead: AbortController | undefined

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
    calibrationRead?.abort()
    const call = { baseUrl: connection.baseUrl, signal, errorBody: true } as const
    const views = await ports.client.request({ ...call, path: viewsPath(request.codebaseId), timeout: 'read' })
    const failed = (failure: ClientFailure): MetricsView => failedView(failure, connection)
    if (!views.ok) return failed(views.failure)
    const names = parseNames(views.value)
    const cards = parseCardDeclarations(views.value)
    if (names === null || cards === null) return { kind: 'unreadable' }
    // The titles go out now, so a panel shows them over skeletons while the report is read.
    orca.panels.post('metrics.cards', cardsPost(request.codebaseId, requestedWindow, cards))
    const answer = await ports.client.request({ ...call, path: reportPath(requestedWindow, request.codebaseId), timeout: 'report' })
    if (!answer.ok) return failed(answer.failure)
    const report = parseReport(answer.value)
    if (report === null) return { kind: 'unreadable' }
    const cardReport = cardReportOf(report)
    const unknowns = unknownsLine(cards, cardReport)
    if (unknowns !== null) orca.log(unknowns)
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
      refusedTotal: report.refusedTotal,
      overview: overviewOf(cards, cardReport, names, CALIBRATIONS_LOADING),
      ...unmatchedCalibrations(report)
    }
    if (request.codebaseId !== undefined) view.codebaseId = request.codebaseId
    const thisRead: Held = { key, view, report, cards, names, ratios: calibratedRatios(cards), calibrations: CALIBRATIONS_LOADING }
    held = thisRead
    // After the window's report, the year's: the cards go out again with their calibration markers.
    const controller = new AbortController()
    calibrationRead = controller
    void readCalibrations(ports.client, connection.baseUrl, request.codebaseId, controller.signal).then((calibrations) => {
      if (controller.signal.aborted) return
      if (calibrationRead === controller) calibrationRead = undefined
      thisRead.calibrations = calibrations
      thisRead.view = { ...thisRead.view, overview: overviewOf(cards, cardReport, names, calibrations) }
      orca.panels.post('metrics.calibrations', calibrationsPost(thisRead.view))
    })
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
    calibrations: (key) => (held?.key === key ? { calibrations: held.calibrations, names: held.names, ratios: held.ratios } : undefined),
    dispose() {
      handle.dispose()
      calibrationRead?.abort()
      // A window that waits for the pause is written now, so the choice outlives the worker.
      flush()
    }
  }
}
