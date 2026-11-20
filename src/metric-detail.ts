// A metric's view: a frame sends the dotted name of the selected Details row with the scope and
// window of the report on screen, and the worker answers that one metric's figures from the
// report it holds (`startMetrics` in `metrics.ts`), asking Archon nothing. Only when it holds no
// report for that scope and window, as after a restart, does it read that one metric from Archon
// by `name`, under the Details read's timeout, read cap and failure words.
//
// The figures are written as Archon's console writes them in its Details row (`MetricRow` and
// `CostCell` in `packages/web/src/experiments/console/routes/metrics/MetricsDetails.tsx`, and
// `identityLabel` in `model.ts` beside it, Archon 0.14.0, commit
// 8def159a6b2c23e832a5283b4131cfffd9af9344). The console's sparkline becomes the "By day" rows.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import type { ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { cutAt } from './cutter'
import { formatNumber, isMetricName, METRICS_TEXT_CAP, type Identity, type InstrumentFigures } from './metric-figures'
import { BY_DAY_CAP, OLDER_VERSIONS_CAP, type MetricAnswer, type MetricDetail, type MetricRequest, type MetricView } from './metric-view'
import {
  failedView,
  formatFigure,
  formatKnownCost,
  formatValue,
  METRICS_PATH,
  parseReport,
  reportKey,
  type Metric,
  type Report
} from './metrics'
import { METRICS_WINDOWS, type MetricsWindow } from './metrics-view'
import { cappedTextRefusal, isCappedText, isRecord, own, refuseOtherKeys, refuseRequest } from './records'
import { PROJECT_ID_CAP } from './scope-view'

/** A frame's request, or a refusal. */
export function parseMetricRequest(input: unknown): MetricRequest {
  if (!isRecord(input)) refuseRequest("A metric's view takes the metric's name, the window and a project id or none.")
  refuseOtherKeys(input, ['name', 'window', 'codebaseId'], "The metric's view request")
  const name = own(input, 'name')
  if (!isMetricName(name)) refuseRequest("The metric's name must be Archon's dotted name.")
  const window = own(input, 'window')
  const chosen = METRICS_WINDOWS.find((each) => each === window)
  if (chosen === undefined) refuseRequest(`The window must be one of ${METRICS_WINDOWS.join(', ')}.`)
  const request: MetricRequest = { name, window: chosen }
  if (Object.hasOwn(input, 'codebaseId')) {
    const codebaseId = own(input, 'codebaseId')
    if (!isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
    request.codebaseId = codebaseId
  }
  return request
}

/** "judge-v2 on claude-opus, gpt-5": an instrument and the models that ran it, as the console names it. */
function identityLabel(identity: Identity): string {
  const instrument = identity.instrument ?? 'no instrument'
  return cutAt(identity.measuredBy.length === 0 ? instrument : `${instrument} on ${identity.measuredBy.join(', ')}`, METRICS_TEXT_CAP)
}

function tokensText(cost: InstrumentFigures['cost']): string {
  return cost.inputTokens === null
    ? 'no tokens recorded'
    : `${formatNumber(cost.inputTokens)} in / ${formatNumber(cost.outputTokens ?? 0)} out tokens`
}

/** One metric's view model, from the metric as the report's validator read it. */
export function metricDetail(metric: Metric): MetricView {
  if (metric.kind === 'unknown') return { kind: 'unknown-kind' }
  const { unit } = metric
  const { headline, others } = metric.figures
  const { cost, latest, interval } = headline
  const days = [...headline.series].reverse()
  const detail: MetricDetail = {
    name: metric.name,
    judgeVersion: headline.instrument === null ? null : identityLabel(headline),
    value: formatValue(headline.value, unit),
    interval: interval === null ? null : `${formatFigure(interval.low, unit)} – ${formatFigure(interval.high, unit)}`,
    records: headline.n,
    knownCost: formatKnownCost(cost.usd),
    runs: cost.runs,
    gaps: { withoutCost: cost.withoutCost, withoutTokens: cost.withoutTokens, partialCost: cost.partialCost, missing: cost.missing },
    tokens: tokensText(cost),
    latest: { value: formatFigure(latest.value, unit), at: latest.at, subject: latest.subject === null ? null : cutAt(latest.subject, METRICS_TEXT_CAP) },
    olderVersions: others.slice(0, OLDER_VERSIONS_CAP).map(identityLabel),
    olderMore: Math.max(0, others.length - OLDER_VERSIONS_CAP),
    byDay: days.slice(0, BY_DAY_CAP).map((day) => ({ day: day.day, value: formatFigure(day.value, unit), records: day.n })),
    byDayMore: Math.max(0, days.length - BY_DAY_CAP)
  }
  return { kind: 'ready', metric: detail }
}

function fromReport(report: Report, name: string): MetricView {
  const metric = report.metrics.find((each) => each.name === name)
  return metric === undefined ? { kind: 'absent' } : metricDetail(metric)
}

/** One metric over the window and scope: only `since`, `name` and the scope are ever sent. */
function onePath(request: MetricRequest): string {
  const query = new URLSearchParams({ since: request.window, name: request.name })
  if (request.codebaseId !== undefined) query.set('codebaseId', request.codebaseId)
  return `${METRICS_PATH}?${query.toString()}`
}

export type MetricDetailPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
  /** The report the Metrics read holds for a key of `reportKey`, if it holds that one. */
  held(key: string): Report | undefined
}

/** Answers the frames' `metric.read`. */
export function startMetricDetail(orca: OrcaWorkerApi, ports: MetricDetailPorts): Disposable {
  async function readView(request: MetricRequest, signal: AbortSignal): Promise<MetricView> {
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { kind: 'not-connected' }
    if (!connection.features.metrics) return { kind: 'missing', message: metricsMissing(connection) }
    const window: MetricsWindow = request.window
    const held = ports.held(reportKey(connection, request.codebaseId, window))
    if (held !== undefined) return fromReport(held, request.name)
    const answer = await ports.client.request({ baseUrl: connection.baseUrl, signal, errorBody: true, path: onePath(request), timeout: 'report' })
    if (!answer.ok) return failedView(answer.failure, connection)
    const report = parseReport(answer.value)
    return report === null ? { kind: 'unreadable' } : fromReport(report, request.name)
  }

  return orca.panels.handle('metric.read', async (input, context): Promise<MetricAnswer> => {
    const request = parseMetricRequest(input)
    const metric = await readView(request, context.signal)
    return { connection: await ports.current(), metric }
  })
}
