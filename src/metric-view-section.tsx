// A metric's view, inside the Details tab of the Metrics section: selecting a row of the Details
// table replaces the table with one metric's labelled figures, the older judge versions its
// headline hides, and a collapsed "By day" table that stands in for the console's sparkline, with
// a back control to the table, and its calibrations (`calibration-section.tsx`). It draws only the
// worker's view model, asked for once when the row is selected, again when a new report comes on
// screen and again when the worker posts that report's calibrations; the worker answers from the
// report it holds. Nothing here writes, and no timer runs.
import {
  atom,
  Button,
  Callout,
  Collapsible,
  env,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Table,
  Text,
  type OrcaNode,
  type PanelContext,
  type TableColumn,
  type TableRow
} from 'orca'
import { calibrationsBlock, sameRead } from './calibration-section'
import type { MetricsCalibrationsPost, ReadIdentity } from './calibration-view'
import type { ConnectionView } from './connection-view'
import { formatDateTime } from './dates'
import { factList, type FactItem } from './fact-list'
import type { MetricDetail, MetricRequest, MetricView } from './metric-view'
import { METRICS_REQUEST_TIMEOUT_MS, WINDOW_DAYS, type MetricsView, type MetricsWindow } from './metrics-view'
import { moreLine } from './overview-section'
import { UNREACHABLE_TEXT } from './worker-words'

/** The report on screen, as far as a metric's view reads it. */
type ReportOnScreen = ReadIdentity

/** The open metric: its dotted name and the plain name its row shows. */
type Open = { name: string; label: string }

const open = atom<Open | null>(null)
/** The worker's answer for the open metric, kept while a new report's answer loads. */
const answered = atom<MetricView | null>(null)
/** The worker did not answer. */
const unreachable = atom(false)
const byDayOpen = atom(false)

/** The report the last request was for, which Retry asks about again. */
let shownReport: ReportOnScreen | null = null
/** Rises with every request and on every close, so only the newest answer is shown. */
let latest = 0
let inFlight: AbortController | undefined
let keep: ((view: ConnectionView) => void) | undefined

export type MetricViewHooks = {
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
}

/** Starts a metric's view for this panel run: an answer that arrives after the panel closes is dropped. */
export function startMetricView(ctx: PanelContext, hooks: MetricViewHooks): void {
  keep = hooks.keep
  ctx.subscriptions.push({
    dispose() {
      latest += 1
      inFlight?.abort()
      inFlight = undefined
      if (keep === hooks.keep) keep = undefined
    }
  })
}

function ask(report: ReportOnScreen): void {
  const metric = read(open)
  if (metric === null) return
  shownReport = report
  latest += 1
  const mine = latest
  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller
  const request: MetricRequest = { name: metric.name, window: report.window }
  if (report.codebaseId !== undefined) request.codebaseId = report.codebaseId
  set(unreachable, false)
  plugin
    .request('metric.read', request, { signal: controller.signal, timeoutMs: METRICS_REQUEST_TIMEOUT_MS })
    .then(
      (answer) => {
        if (mine !== latest) return
        keep?.(answer.connection)
        set(answered, answer.metric)
      },
      () => {
        if (mine === latest) set(unreachable, true)
      }
    )
    .finally(() => {
      if (inFlight === controller) inFlight = undefined
    })
}

/** Opens a metric's view of the report on screen in place of the Details table. */
export function openMetricView(name: string, label: string, report: ReportOnScreen): void {
  set(open, { name, label })
  set(answered, null)
  set(byDayOpen, false)
  ask(report)
}

/**
 * A report came on screen. A metric's view that is open asks for its figures in it, unless it is
 * the report the view already shows.
 */
export function metricReportChanged(report: ReportOnScreen): void {
  if (read(open) === null) return
  if (shownReport === null || !sameRead(shownReport, report)) ask(report)
}

/**
 * The worker posted a read's calibrations. A metric's view open on that read's report asks for
 * its figures again, so its calibration lines are those of the year-long report as it now stands.
 */
export function metricCalibrated(post: MetricsCalibrationsPost): void {
  if (read(open) === null || shownReport === null) return
  if (sameRead(post, shownReport)) ask(shownReport)
}

/** The way back, or a different Archon store: the Details table shows again. */
export function closeMetricView(): void {
  latest += 1
  inFlight?.abort()
  inFlight = undefined
  shownReport = null
  set(open, null)
  set(answered, null)
  set(unreachable, false)
}

/** The open metric's dotted name, or null when the Details table shows. */
export function openMetricName(): string | null {
  return read(open)?.name ?? null
}

function retry(): void {
  if (shownReport !== null) ask(shownReport)
}

const BY_DAY_COLUMNS: readonly TableColumn[] = [
  { key: 'day', label: 'Day (UTC)' },
  { key: 'value', label: 'Value' },
  { key: 'records', label: 'Records', align: 'end' }
]

/** The figures and the "By day" rows, built once per answer rather than on every render. */
const built = new WeakMap<MetricDetail, { items: FactItem[]; days: TableRow[] }>()
function buildOf(metric: MetricDetail): { items: FactItem[]; days: TableRow[] } {
  let found = built.get(metric)
  if (found === undefined) {
    const { gaps, latest: last } = metric
    const recorded = last.at === null ? '' : formatDateTime(last.at, env.locale)
    const items: FactItem[] = [
      { label: 'Name', value: metric.name, code: true },
      ...(metric.judgeVersion === null ? [] : [{ label: 'Judge version', value: metric.judgeVersion }]),
      { label: 'Value', value: metric.value },
      { label: '95% interval', value: metric.interval ?? 'none reported' },
      { label: 'Records', value: metric.records },
      { label: 'Known cost', value: metric.knownCost },
      { label: 'Runs', value: metric.runs },
      { label: 'Runs without cost', value: gaps.withoutCost },
      { label: 'Runs without tokens', value: gaps.withoutTokens },
      { label: 'Runs with partial cost', value: gaps.partialCost },
      { label: 'Runs missing', value: gaps.missing },
      { label: 'Tokens', value: metric.tokens },
      { label: 'Latest', value: last.value },
      // A time that does not parse drops the line and keeps the value and subject.
      ...(recorded === '' ? [] : [{ label: 'Latest recorded', value: recorded }]),
      { label: 'Latest subject', value: last.subject ?? 'none' }
    ]
    // Archon's day string is shown as given: it is never read as a time.
    const days = metric.byDay.map((day) => ({ key: day.day, cells: { day: day.day, value: day.value, records: day.records } }))
    found = { items, days }
    built.set(metric, found)
  }
  return found
}

/** A window in the section's words, as in "in the last 7 days". */
export const lastDays = (window: MetricsWindow): string => `last ${String(WINDOW_DAYS[window])} days`

function figures(label: string, metric: MetricDetail): OrcaNode {
  const { items, days } = buildOf(metric)
  return (
    <Stack gap="sm">
      {factList(label, items)}
      {metric.olderVersions.length === 0 ? null : (
        <Stack gap="xs">
          <Text size="sm">Hidden older judge versions</Text>
          {metric.olderVersions.map((version) => (
            <Text key={version} muted size="sm">
              {version}
            </Text>
          ))}
          {moreLine(metric.olderMore)}
        </Stack>
      )}
      {calibrationsBlock(metric.calibrations)}
      <Collapsible title="By day" open={read(byDayOpen)} onChange={(value) => set(byDayOpen, value)}>
        <Stack gap="xs">
          <Table label="By day" columns={BY_DAY_COLUMNS} rows={days} />
          {moreLine(metric.byDayMore)}
        </Stack>
      </Collapsible>
    </Stack>
  )
}


/**
 * A metric's view in place of the Details table, with the way back. `problemText` gives the words
 * the Details table says for a failed read, so both say the same.
 */
export function metricViewBody(problemText: (view: MetricsView) => string | null, unknownKindText: string): OrcaNode {
  const metric = read(open)
  if (metric === null) return null
  const view = read(answered)
  let body: OrcaNode
  if (read(unreachable)) body = failed(UNREACHABLE_TEXT)
  else if (view === null) body = <Spinner label="Loading the metric…" />
  else if (view.kind === 'ready') body = figures(metric.label, view.metric)
  else if (view.kind === 'unknown-kind') body = <Text muted>{`${metric.label}: ${unknownKindText}.`}</Text>
  else if (view.kind === 'absent') {
    const window = shownReport?.window
    body = <Text muted>{`Archon reports no records of this metric in the ${window === undefined ? 'window' : lastDays(window)}.`}</Text>
  } else if (view.kind === 'missing') body = <Text muted>{view.message}</Text>
  else if (view.kind === 'not-connected') body = null
  else body = failed(problemText(view) ?? UNREACHABLE_TEXT)
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center">
        <Button size="sm" variant="ghost" tooltip="Back to the Details table" onPress={closeMetricView}>
          Details
        </Button>
        <Text>{metric.label}</Text>
      </Row>
      {body}
    </Stack>
  )
}

function failed(message: string): OrcaNode {
  return (
    <Callout tone="warning">
      <Stack gap="xs">
        <Text>{message}</Text>
        <Row>
          <Button size="sm" variant="outline" onPress={retry}>
            Retry
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}
