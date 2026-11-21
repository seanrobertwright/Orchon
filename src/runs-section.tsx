// The Runs section of the panel: a filter row, the "runs need you" callout, the runs table, a
// count line and a read-only preview of the selected run. The filter row's New run opens the
// Launch section. It draws only the worker's view model and fetches it under the shared per-view
// fetch rules, under the project scope of
// `scope-section.tsx`. The callout and the "Needs you" filter come from the worker's snapshot, in
// the same answer as the table.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Link,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  shell,
  Spinner,
  Stack,
  Table,
  Text,
  type OrcaNode,
  type PanelContext,
  type TableCell,
  type TableColumn,
  type TableRow
} from 'orca'
import type { Connected, ConnectionView } from './connection-view'
import { formatDuration, now } from './dates'
import { factList, type FactItem } from './fact-list'
import { frameTimers } from './frame-timers'
import type { RunsHint } from './hint-view'
import { clearRunDetail, openRunDetail, openRunId, restartRunDetail, runDetailHasData, runDetailSection } from './run-detail-section'
import { worktreeLine } from './worktree-line'
import { FILTER_ORDER, filterWord, runsNeedYou, STATUS_GLYPH, STATUS_TONE, STATUS_WORD, statusText, waitingUnread } from './run-status-words'
import {
  ROWS_CAP,
  ROWS_STEP,
  type NeedsYouView,
  type RunRow,
  type RunsAnswer,
  type RunsRequest,
  type RunsView,
  type TableFilter,
  type Waiting
} from './runs-view'
import { restartScope, scopeChoice, scopedProjectId, scopeNotice, scopeSettled, scopeSwitch } from './scope-section'
import { createViewFetch, LIVE_OFF_REFETCH_MS, RUNS_TABLE_GAP_MS, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { problemLine, type ReadProblem } from './view-notices'
import { offersTryAgain, troubleText } from './worker-words'

type Ready = Extract<RunsView, { kind: 'ready' }>

/** The status filter's least width in pixels: room for its longest choice, "Needs you" with a count. */
const FILTER_MIN_WIDTH = 140

const filter = atom<TableFilter>('all')
/** How many rows the table asks for: rows 0 to N. */
const requested = atom<number>(ROWS_STEP)
const loaded = atom<Ready | null>(null)
const problem = atom<ReadProblem | null>(null)
const lastGood = atom<number | null>(null)
const selected = atom<string | null>(null)

/** What the section reads from the rest of the panel. */
export type RunsSectionHooks = {
  connection(): ConnectionView | null
  /** Whether the Runs section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** New run: shows the Launch section. */
  newRun?(): void
}

/** The section's fetch rules for this panel run: the one handle every restart goes through. */
let fetcher: ViewFetch | undefined
let newRun: (() => void) | undefined

function report(message: string, tryAgain = true): void {
  set(problem, { message, lastGood: read(lastGood), tryAgain })
}

function apply(answer: RunsAnswer | null, hooks: RunsSectionHooks): void {
  if (answer === null) return
  hooks.keep(answer.connection)
  const { runs } = answer
  if (runs.kind === 'ready') {
    set(loaded, runs)
    set(problem, null)
    set(lastGood, now())
  } else if (runs.kind === 'failed') {
    report(runs.message)
  }
}

/** Starts the section's fetch rules for this panel run. They stop when the panel closes. */
export function startRunsSection(ctx: PanelContext, given: RunsSectionHooks): void {
  const view = createViewFetch<RunsAnswer | null>({
    load(signal) {
      // The table waits for the scope, so it never reads one project and then another.
      // While a run is open its detail shows in place of the table, which is read again on the way back.
      if (given.connection()?.kind !== 'connected' || !given.showing() || !scopeSettled() || openRunId() !== null) {
        return Promise.resolve(null)
      }
      const request: RunsRequest = { status: read(filter), rows: read(requested) }
      const codebaseId = scopedProjectId()
      return plugin.request('runs.read', codebaseId === undefined ? request : { ...request, codebaseId }, { signal })
    },
    apply: (answer) => apply(answer, given),
    // Worker unreachable, said by the shared fetch rules; a rate-limited read says nothing.
    fail(_error, trouble) {
      if (trouble !== null) report(troubleText(trouble), offersTryAgain(trouble))
    },
    minGapMs: RUNS_TABLE_GAP_MS,
    safetyMs: () => {
      const state = given.connection()
      return state?.kind === 'connected' && !state.live ? LIVE_OFF_REFETCH_MS : SAFETY_REFETCH_MS
    },
    now,
    timers: frameTimers
  })
  fetcher = view
  newRun = given.newRun
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Whether the table holds an answer to show, as Searching keeps it under its banner. */
export function runsHaveData(): boolean {
  return openRunId() === null ? read(loaded) !== null : runDetailHasData()
}

/** A different Archon store: what the section held, chosen and loaded belongs to the old one. */
export function clearRuns(): void {
  set(filter, 'all')
  set(requested, ROWS_STEP)
  set(loaded, null)
  set(problem, null)
  set(lastGood, null)
  set(selected, null)
  clearRunDetail()
}

/** Reads the table again at once, as a person's action does. Nothing happens before the section starts. */
export function restartRuns(): void {
  fetcher?.restart()
}

/**
 * A hint that runs changed: on `workflow_status` the table (counts and the whole loaded range)
 * is read again under its fetch rules, once the minimum gap allows. `dag_node` changes nothing
 * the table shows.
 */
export function hintRuns(hint: RunsHint): void {
  if (hint.types.includes('workflow_status')) fetcher?.refresh()
}

/** Reads the table again once the minimum gap allows, as a hint does. */
export function refreshRuns(): void {
  fetcher?.refresh()
}

/** Sets the filter to "Needs you", as the callout's last row and a press of "Orchon: Show runs" do. */
export function showNeedsYou(): void {
  chooseFilter('needs-you')
}

/** Reads the whole Runs view again: the project scope, then the table under it. */
export function restartRunsView(): void {
  restartScope()
  restartRuns()
  restartRunDetail()
}

/** The project the table is filtered by changed: it reads from the newest run again. */
export function rescopeRuns(): void {
  set(requested, ROWS_STEP)
  set(selected, null)
  restartRuns()
}

function chooseFilter(value: string): void {
  const next = FILTER_ORDER.find((option) => option === value)
  if (next === undefined) return
  set(filter, next)
  set(requested, ROWS_STEP)
  set(selected, null)
  restartRuns()
}

function loadMore(): void {
  set(requested, Math.min(read(requested) + ROWS_STEP, ROWS_CAP))
  restartRuns()
}

const COLUMNS: readonly TableColumn[] = [
  { key: 'run', label: 'Run', minWidth: 'sm' },
  { key: 'status', label: 'Status', width: 'sm', hideBelow: 'sm' },
  { key: 'started', label: 'Started', width: 'sm' },
  { key: 'ranFor', label: 'Ran for', width: 'sm', hideBelow: 'md' }
]

/** Under "All projects" the table also names each run's project, from 480 px. */
const ALL_PROJECTS_COLUMNS: readonly TableColumn[] = [
  ...COLUMNS.slice(0, 3),
  { key: 'project', label: 'Project', width: 'md', hideBelow: 'md' },
  ...COLUMNS.slice(3)
]

/** How long a run ran: a duration that keeps counting while it has not ended. */
function ranFor(run: RunRow): TableCell {
  if (run.startedAt === null) return ''
  if (run.endedAt === null) return { type: 'relative', at: run.startedAt, format: 'duration' }
  return formatDuration(run.endedAt - run.startedAt)
}

function tableRow(run: RunRow): TableRow {
  return {
    key: run.id,
    cells: {
      run: `${STATUS_GLYPH[run.status]} ${run.workflow}`,
      status: statusText(run.status),
      started: run.startedAt === null ? '' : { type: 'relative', at: run.startedAt, format: 'short' },
      project: run.project ?? '',
      ranFor: ranFor(run)
    }
  }
}

/** The count line under the table, or the line saying where loading stopped. */
function countLine(runs: Ready): string {
  if (runs.rows.length >= ROWS_CAP && runs.total > ROWS_CAP) {
    return `Showing the newest ${String(ROWS_CAP)} of ${String(runs.total)} runs. Choose a status to narrow the list, or open Archon's console for the rest.`
  }
  return `${String(runs.rows.length)} of ${String(runs.total)} loaded.`
}

function unreadableLine(count: number): string {
  return count === 1 ? '1 run could not be read and is not shown.' : `${String(count)} runs could not be read and are not shown.`
}

function preview(run: RunRow): OrcaNode {
  const facts: FactItem[] = [{ label: 'Project', value: run.project ?? 'No project' }]
  if (run.workingPath !== null) facts.push({ label: 'Worktree', value: run.workingPath, code: true })
  return (
    <Card title={run.workflow}>
      <Stack gap="sm">
        <Row gap="sm" wrap align="center">
          <Badge tone={STATUS_TONE[run.status]}>{STATUS_WORD[run.status]}</Badge>
          {run.startedAt === null ? null : (
            <Text muted>
              Started <RelativeTime at={run.startedAt} />
            </Text>
          )}
        </Row>
        {run.waiting === undefined ? null : <Text>{waitingText(run.waiting)}</Text>}
        {run.message === '' ? null : <Text>{run.message}</Text>}
        {factList('Run facts', facts)}
        {worktreeLine(run)}
        <Row>
          <Button size="sm" onPress={() => openRunDetail(run.id)}>
            Open run
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

function emptyText(status: TableFilter): string {
  if (status === 'all') return 'No runs.'
  if (status === 'needs-you') return 'No runs need you.'
  return `No ${filterWord(status).toLowerCase()} runs.`
}

/** What a run that needs you waits for, on one line: its question, or where to look. */
function waitingText(waiting: Waiting): string {
  return waiting.kind === 'unreadable' ? "Needs a look in Archon's console" : waiting.question
}

/**
 * The "runs need you" callout: a row per run in Archon's order, which the worker caps at
 * `CALLOUT_CAP`, then a last row that sets the filter to "Needs you", then a line for the waiting
 * runs that could not be read. A row opens the run. Hidden when nothing needs you and nothing
 * waiting went unread, when the count is unavailable, and while the filter is "Needs you".
 */
function needsYouCallout(needsYou: NeedsYouView | undefined, status: TableFilter): OrcaNode {
  if (needsYou?.kind !== 'ready' || (needsYou.total === 0 && needsYou.unreadable === 0) || status === 'needs-you') return null
  const allProjects = scopeChoice() === 'all'
  const shown = needsYou.rows
  const more = needsYou.total - shown.length
  const unread = needsYou.unreadable
  const title = needsYou.total > 0 ? runsNeedYou(needsYou.total) : 'Waiting runs could not be read'
  return (
    <Callout tone="warning" icon="bell" title={title}>
      <Stack gap="sm">
        {shown.map((run) => (
          <Stack key={run.id} gap="none">
            <Row gap="sm" wrap align="center">
              <Link onPress={() => openRunDetail(run.id)}>{run.workflow}</Link>
              {allProjects && run.project !== null ? (
                <Text muted size="sm">
                  {run.project}
                </Text>
              ) : null}
            </Row>
            {run.waiting === undefined ? null : (
              <Text truncate size="sm">
                {waitingText(run.waiting)}
              </Text>
            )}
          </Stack>
        ))}
        {more > 0 ? <Link onPress={showNeedsYou}>{`and ${String(more)} more`}</Link> : null}
        {unread > 0 ? (
          <Text muted size="sm">
            {`${waitingUnread(unread)} and ${unread === 1 ? 'is' : 'are'} not shown.`}
          </Text>
        ) : null}
      </Stack>
    </Callout>
  )
}

function table(runs: Ready, status: TableFilter): OrcaNode {
  const wanted = read(requested)
  const chosen = read(selected)
  const run = chosen === null ? undefined : runs.rows.find((row) => row.id === chosen)
  const hasMore = wanted < ROWS_CAP && runs.rows.length >= wanted && runs.rows.length < runs.total
  return (
    <>
      <Table
        label="Runs"
        columns={scopeChoice() === 'all' ? ALL_PROJECTS_COLUMNS : COLUMNS}
        rows={runs.rows.map(tableRow)}
        selectionMode="single"
        selected={run === undefined ? [] : [run.id]}
        hasMore={hasMore}
        maxHeight="lg"
        emptyText={emptyText(status)}
        onSelectionChange={({ keys }) => set(selected, keys[0] ?? null)}
        onRowAction={({ key }) => openRunDetail(key)}
        onLoadMore={loadMore}
      />
      <Text muted size="sm">
        {countLine(runs)}
      </Text>
      {run === undefined ? null : preview(run)}
    </>
  )
}

/** The section while connected or under the Searching banner. `writable` is false when its controls that write are off. */
export function runsSection(state: Connected, writable: boolean): OrcaNode {
  if (openRunId() !== null) return runDetailSection(writable)
  const status = read(filter)
  const runs = read(loaded)
  const held = read(problem)
  const counts = runs?.counts
  const needsYou = runs?.needsYou
  const options = FILTER_ORDER.map((value) => {
    if (value === 'needs-you') {
      // The count comes from the snapshot; without it the option has no count.
      const label = needsYou?.kind === 'ready' ? `${filterWord(value)} (${String(needsYou.total)})` : filterWord(value)
      return { value, label }
    }
    return { value, label: counts === undefined ? filterWord(value) : `${filterWord(value)} (${String(counts[value])})` }
  })
  const openConsole = (): void => {
    shell.openExternal(`${state.baseUrl}/console`).catch(() => {})
  }
  let body: OrcaNode
  if (runs === null) body = held === null ? <Spinner label="Loading runs…" /> : null
  else if (runs.counts.all === 0) body = <EmptyState title="No runs yet" description="Runs started in Archon appear here." />
  else body = table(runs, status)
  return (
    <Stack gap="sm">
      {scopeSwitch()}
      {scopeNotice(writable)}
      {/* The row wraps and the filter keeps a floor, so a narrow panel moves New run down a line
          rather than squeezing the filter until its value cannot be read. */}
      <Row gap="sm" align="center" wrap>
        <Box minWidth={FILTER_MIN_WIDTH}>
          <Select label="Status" labelHidden value={status} options={options} onChange={chooseFilter} />
        </Box>
        <IconButton icon="refresh" label="Refresh runs" onPress={() => restartRuns()} />
        {newRun === undefined ? null : (
          <Button size="sm" variant="outline" onPress={newRun}>
            New run
          </Button>
        )}
      </Row>
      {held === null ? null : problemLine(held, runs !== null, () => restartRuns())}
      {needsYouCallout(needsYou, status)}
      {body}
      {runs !== null && runs.unreadable > 0 ? (
        <Text muted size="sm">
          {unreadableLine(runs.unreadable)}
        </Text>
      ) : null}
      <Link onPress={openConsole}>Open in Archon console</Link>
    </Stack>
  )
}
