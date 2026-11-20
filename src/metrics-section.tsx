// The Metrics section of the panel: a header with the window, Refresh, the status line and the
// Overview and Details tabs, and the Details table of every metric Archon recorded for the scope
// and window, where selecting a row opens that metric's view (`metric-view-section.tsx`) in its
// place. It draws only the worker's view model and fetches it under the shared per-view fetch
// rules with no safety refetch: on opening the section, on a change of scope or window, and on
// Refresh. A return to the section asks the worker, which reads Archon again only when its report
// is older than `METRICS_MAX_AGE_MS`. It ignores run hints. Figures are shown only for the scope
// chosen now. It lands on Overview, the cards of `overview-section.tsx`.
import {
  atom,
  Button,
  Callout,
  EmptyState,
  env,
  IconButton,
  Link,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Tab,
  Table,
  Tabs,
  Text,
  type OrcaNode,
  type PanelContext,
  type TableColumn,
  type TableRow
} from 'orca'
import { calibratedOverview, clearCalibrations, startCalibrationSection, unmatchedLines } from './calibration-section'
import type { Connected, ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { formatDay, now } from './dates'
import { frameTimers } from './frame-timers'
import { closeMetricView, lastDays, metricCalibrated, metricReportChanged, metricViewBody, openMetricName, openMetricView, startMetricView } from './metric-view-section'
import {
  METRICS_REQUEST_TIMEOUT_MS,
  METRICS_WINDOWS,
  type MetricsAnswer,
  type MetricsRequest,
  type MetricsView,
  type MetricsWindow
} from './metrics-view'
import { clearOverview, moreLine, overviewCards, pendingCards, startOverviewSection } from './overview-section'
import { scopedProjectId, scopeNotice, scopeSettled, scopeSwitch } from './scope-section'
import { createViewFetch, type ViewFetch } from './view-fetch'
import { offersTryAgain, troubleText } from './worker-words'

type Ready = Extract<MetricsView, { kind: 'ready' }>

/** What the section says in place of figures, or over the figures it keeps. */
type Problem = { message: string; retry: boolean }

/** The report on screen, kept while a new one loads or a read fails. */
const loaded = atom<Ready | null>(null)
/** The server has no metrics: the sentence that says which release they need. */
const missing = atom<string | null>(null)
const problem = atom<Problem | null>(null)
/** The window the person chose, or the one the worker kept; null until the worker answers. */
const chosen = atom<MetricsWindow | null>(null)
/** The window of the read in flight, or null when none is. */
const loading = atom<MetricsWindow | null>(null)
/** Overview or Details, kept per workspace because Orca unmounts a hidden panel. Overview is the landing view. */
const tab = atom<unknown>('metricsTab', 'overview', { persist: 'workspace' })
/** The metric a card's "Details" link opened Details at, selected in the table. */
const detailsAt = atom<string | null>(null)

type MetricsTab = 'overview' | 'details'
const parseTab = (value: unknown): MetricsTab => (value === 'details' ? 'details' : 'overview')

/** A card's "Details" link: the Details table, at the card's metric when it names one. */
function openDetails(metric?: string): void {
  // The link shows the Details table itself, so a metric's view open there closes.
  closeMetricView()
  set(detailsAt, metric ?? null)
  set(tab, 'details')
}
const overviewHooks = { openDetails }

export const TIMEOUT_TEXT = 'Archon took too long to answer.'
export const TOO_LARGE_TEXT = "Archon's metrics answer is too large to read."
export const UNREADABLE_TEXT = "Archon's metrics answer could not be read."
export const FAILED_TEXT = 'Could not load metrics.'
export const UNKNOWN_KIND_TEXT = 'a kind this version of Orchon does not show'
export const KNOWN_COST_FOOTNOTE =
  "Known cost is the cost of the runs that produced a metric's records. Metrics recorded by the same runs show the same cost, so the column does not add up."

/** The least time between two reads that no person asked for. */
const METRICS_GAP_MS = 2_000

/** What the section reads from the rest of the panel. */
export type MetricsSectionHooks = {
  connection(): ConnectionView | null
  /** Whether the Metrics section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
}

let fetcher: ViewFetch | undefined
/** What the next read adds to the scope: the person's window and whether to read Archon again. */
let next: Omit<MetricsRequest, 'codebaseId'> = {}

/** Whether the section may read: Connected to a server that has the metrics paths. */
export const metricsReadable = (state: ConnectionView | null): state is Connected => state?.kind === 'connected' && state.features.metrics

/** The report on screen when it covers the scope chosen now: another scope's figures are never shown. */
function shownReport(): Ready | null {
  const report = read(loaded)
  return report !== null && report.codebaseId === scopedProjectId() ? report : null
}

function problemOf(view: MetricsView): Problem | null {
  switch (view.kind) {
    case 'timeout':
      return { message: TIMEOUT_TEXT, retry: true }
    case 'too-large':
      return { message: TOO_LARGE_TEXT, retry: true }
    case 'unreadable':
      return { message: UNREADABLE_TEXT, retry: true }
    case 'failed':
      return { message: `${FAILED_TEXT} ${view.message}`, retry: true }
    default:
      return null
  }
}

function apply(answer: MetricsAnswer | null, hooks: MetricsSectionHooks): void {
  set(loading, null)
  if (answer === null) return
  hooks.keep(answer.connection)
  set(chosen, answer.window)
  const { metrics } = answer
  if (metrics.kind === 'ready') {
    set(loaded, metrics)
    metricReportChanged(metrics)
    set(missing, null)
    set(problem, null)
  } else if (metrics.kind === 'missing') {
    set(missing, metrics.message)
    set(problem, null)
  } else if (metrics.kind !== 'not-connected') {
    set(problem, problemOf(metrics))
  }
}

/** Starts the section's fetch rules for this panel run. They stop when the panel closes. */
export function startMetricsSection(ctx: PanelContext, given: MetricsSectionHooks): void {
  const view = createViewFetch<MetricsAnswer | null>({
    load(signal) {
      // The report waits for the scope, so it never reads one project and then another.
      if (!metricsReadable(given.connection()) || !given.showing() || !scopeSettled()) return Promise.resolve(null)
      const codebaseId = scopedProjectId()
      const request: MetricsRequest = { ...next }
      if (codebaseId !== undefined) request.codebaseId = codebaseId
      next = {}
      set(loading, request.window ?? read(chosen) ?? read(loaded)?.window ?? null)
      return plugin.request('metrics.read', request, { signal, timeoutMs: METRICS_REQUEST_TIMEOUT_MS })
    },
    apply: (answer) => apply(answer, given),
    // Worker unreachable, said by the shared fetch rules; a rate-limited read says nothing.
    fail(_error, trouble) {
      set(loading, null)
      if (trouble !== null) set(problem, { message: troubleText(trouble), retry: offersTryAgain(trouble) })
    },
    minGapMs: METRICS_GAP_MS,
    // Exempt from the safety refetch: a metrics query holds Archon until it answers.
    safetyMs: () => null,
    now,
    timers: frameTimers
  })
  fetcher = view
  startOverviewSection(ctx)
  startCalibrationSection(ctx, metricCalibrated)
  startMetricView(ctx, { keep: given.keep })
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Reads again at once, adding `request` to the scope. */
function readNow(request: Omit<MetricsRequest, 'codebaseId'>): void {
  next = request
  fetcher?.restart()
}

/**
 * The section began to show, or Orchon is connected again: the worker answers from its report
 * while that is at most `METRICS_MAX_AGE_MS` old.
 */
export function openMetrics(): void {
  readNow({})
}

/**
 * The scope settled or changed. A change reads the new scope's report from Archon; the first
 * scope after the panel opens takes the worker's report while it is fresh.
 */
export function rescopeMetrics(): void {
  readNow(read(loaded) === null ? {} : { refresh: true })
}

/** Refresh and Retry: the report is read from Archon whatever the worker holds. */
function refreshMetrics(): void {
  const window = read(chosen)
  readNow(window === null ? { refresh: true } : { window, refresh: true })
}

function chooseWindow(value: string): void {
  const window = METRICS_WINDOWS.find((each) => each === value)
  if (window === undefined) return
  set(chosen, window)
  readNow({ window, refresh: true })
}

/** Whether the section holds a report to show, as Searching keeps it under its banner. */
export function metricsHaveData(): boolean {
  return shownReport() !== null
}

/** A different Archon store: what the section loaded belongs to the old one. */
export function clearMetrics(): void {
  closeMetricView()
  set(loaded, null)
  set(missing, null)
  set(problem, null)
  clearOverview()
  clearCalibrations()
}

/**
 * The console's metrics screen for the scope, tab and window, opened in the system browser. From
 * a metric's view it is the Details screen at that metric's row: the console names a row
 * `metric-<name>` (`metricAnchor` in its metrics `model.ts`, Archon 0.14.0) and reads the hash.
 */
function openConsole(state: Connected, view: MetricsTab, window: MetricsWindow): void {
  const projectId = scopedProjectId()
  const base = projectId === undefined ? '/console/metrics' : `/console/p/${encodeURIComponent(projectId)}/metrics`
  const metric = view === 'details' ? openMetricName() : null
  const row = metric === null ? '' : `#${encodeURIComponent(`metric-${metric}`)}`
  const page = `${base}${view === 'details' ? '/details' : ''}?window=${window}${row}`
  shell.openExternal(`${state.baseUrl}${page}`).catch(() => {})
}

function statusLine(report: Ready): OrcaNode {
  const since = formatDay(report.since, env.locale)
  const until = formatDay(report.until, env.locale)
  const dates = since === '' || until === '' ? '' : ` · ${since} – ${until}`
  const last = lastDays(report.window)
  return (
    <Text muted size="sm">
      {`${last.charAt(0).toUpperCase()}${last.slice(1)}${dates} · updated `}
      <RelativeTime at={report.fetchedAt} format="long" />
    </Text>
  )
}

/** The line while a read is in flight over the figures on screen. */
function loadingLine(window: MetricsWindow, report: Ready): OrcaNode {
  const loadingWords = `Loading ${lastDays(window)}…`
  return (
    <Row gap="sm" align="center">
      <Spinner label={loadingWords} labelHidden />
      <Text muted size="sm">{`${loadingWords} Showing ${lastDays(report.window)}`}</Text>
    </Row>
  )
}

function problemCallout(held: Problem): OrcaNode {
  return (
    <Callout tone="warning">
      <Stack gap="xs">
        <Text>{held.message}</Text>
        {held.retry ? (
          <Row>
            <Button size="sm" variant="outline" onPress={refreshMetrics}>
              Retry
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  )
}

const COLUMNS: readonly TableColumn[] = [
  { key: 'metric', label: 'Metric' },
  { key: 'value', label: 'Value' },
  { key: 'records', label: 'Records', width: 'sm', align: 'end', hideBelow: 'sm' },
  { key: 'cost', label: 'Known cost', hideBelow: 'sm' },
  { key: 'latest', label: 'Latest', hideBelow: 'md' }
]

/** The table's rows, built once per report rather than on every render. */
const tableRows = new WeakMap<Ready, TableRow[]>()
function rowsOf(report: Ready): TableRow[] {
  let rows = tableRows.get(report)
  if (rows === undefined) {
    rows = report.rows.map((row) =>
      row.state === 'shown'
        ? { key: row.name, cells: { metric: row.label, value: row.value, records: row.records, cost: row.knownCost, latest: row.latest } }
        : { key: row.name, cells: { metric: row.label, value: UNKNOWN_KIND_TEXT, records: null, cost: null, latest: null } }
    )
    tableRows.set(report, rows)
  }
  return rows
}

const NO_ROWS: readonly string[] = []
const selectedRows = (metric: string | null): readonly string[] => (metric === null ? NO_ROWS : [metric])

/** Selecting a row opens its metric's view; the row a card's link selected is selected no more. */
function openRow(report: Ready, key: string | undefined): void {
  const row = key === undefined ? undefined : report.rows.find((each) => each.name === key)
  if (row === undefined) return
  set(detailsAt, null)
  openMetricView(row.name, row.label, report)
}

/**
 * A new selection opens its row. A press on the row a card's link selected clears the selection
 * rather than changing it, and opens that row too.
 */
const selectionChanged = (report: Ready, keys: readonly string[]): void => openRow(report, keys[0] ?? read(detailsAt) ?? undefined)

function details(report: Ready): OrcaNode {
  if (openMetricName() !== null) return metricViewBody((view) => problemOf(view)?.message ?? null, UNKNOWN_KIND_TEXT)
  if (report.rows.length === 0) {
    return (
      <Stack gap="sm">
        <EmptyState title={`No measurements in the ${lastDays(report.window)}.`} />
        {unmatchedLines(report)}
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      <Table
        label="Metrics"
        columns={COLUMNS}
        rows={rowsOf(report)}
        selectionMode="single"
        selected={selectedRows(read(detailsAt))}
        onSelectionChange={({ keys }) => selectionChanged(report, keys)}
        onRowAction={({ key }) => openRow(report, key)}
      />
      {moreLine(report.more)}
      <Text muted size="sm">
        {KNOWN_COST_FOOTNOTE}
      </Text>
      {unmatchedLines(report)}
    </Stack>
  )
}

/** The section while connected or under the Searching banner. */
export function metricsSection(state: Connected, writable: boolean): OrcaNode {
  // Without its paths the section says which release it needs, and asks Archon nothing.
  const without = state.features.metrics ? read(missing) : metricsMissing(state)
  if (without !== null) return <EmptyState title="Metrics" description={without} />
  const report = shownReport()
  const held = read(problem)
  const inFlight = read(loading)
  const window = read(chosen) ?? report?.window ?? null
  const shownTab = parseTab(read(tab))
  let body: OrcaNode
  if (report === null) body = held === null ? <Spinner label="Loading metrics…" /> : null
  else body = details(report)
  return (
    <Stack gap="sm">
      {scopeSwitch()}
      {scopeNotice(writable)}
      <Row gap="sm" wrap align="center">
        <RadioGroup
          label="Window"
          orientation="horizontal"
          value={window ?? undefined}
          options={METRICS_WINDOWS.map((each) => ({ value: each, label: each }))}
          onChange={chooseWindow}
        />
        <IconButton icon="refresh" label="Refresh" size="sm" variant="ghost" onPress={refreshMetrics} />
      </Row>
      {report === null ? null : statusLine(report)}
      {inFlight !== null && report !== null ? loadingLine(inFlight, report) : null}
      {held === null ? null : problemCallout(held)}
      <Tabs label="Metrics views" value={shownTab} onChange={(value) => set(tab, parseTab(value))}>
        <Tab value="overview" label="Overview">
          {report === null ? (pendingCards(scopedProjectId(), inFlight, overviewHooks) ?? body) : overviewCards(calibratedOverview(report), overviewHooks)}
        </Tab>
        <Tab value="details" label="Details">
          {body}
        </Tab>
      </Tabs>
      {window === null ? null : <Link onPress={() => openConsole(state, shownTab, window)}>Open in Archon console</Link>}
    </Stack>
  )
}
