// The Runs section of the panel: a filter row, the runs table, a count line and a read-only
// preview of the selected run. It draws only the worker's view model and fetches it under the
// shared per-view fetch rules, under the project scope of `scope-section.tsx`. The "Needs you"
// option, the callout, New run and run detail come with their own tickets.
import {
  atom,
  Badge,
  Button,
  Card,
  EmptyState,
  env,
  IconButton,
  KeyValue,
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
  type KeyValueItem,
  type OrcaNode,
  type PanelContext,
  type TableCell,
  type TableColumn,
  type TableRow
} from 'orca'
import type { Connected, ConnectionView } from './connection-view'
import { formatClock, formatDuration, now } from './dates'
import { frameTimers } from './frame-timers'
import { FILTER_ORDER, filterWord, STATUS_GLYPH, STATUS_TONE, STATUS_WORD, statusText } from './run-status-words'
import { ROWS_CAP, ROWS_STEP, type RunRow, type RunsAnswer, type RunsRequest, type RunsView, type StatusFilter } from './runs-view'
import { scopeChoice, scopedProjectId, scopeNotice, scopeSettled, scopeSwitch } from './scope-section'
import { createViewFetch, RUNS_TABLE_GAP_MS, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { warningLine } from './view-notices'
import { offersTryAgain, troubleText } from './worker-words'

type Ready = Extract<RunsView, { kind: 'ready' }>

/**
 * A read that failed: what to say, when the last good answer came, if one did, and whether it
 * offers "Try again".
 */
type Problem = { message: string; lastGood: number | null; tryAgain: boolean }

const filter = atom<StatusFilter>('all')
/** How many rows the table asks for: rows 0 to N. */
const requested = atom<number>(ROWS_STEP)
const loaded = atom<Ready | null>(null)
const problem = atom<Problem | null>(null)
const lastGood = atom<number | null>(null)
const selected = atom<string | null>(null)

/** What the section reads from the rest of the panel. */
export type RunsSectionHooks = {
  connection(): ConnectionView | null
  /** Whether the Runs section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
}

/** The section's fetch rules for this panel run: the one handle every restart goes through. */
let fetcher: ViewFetch | undefined

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
      if (given.connection()?.kind !== 'connected' || !given.showing() || !scopeSettled()) return Promise.resolve(null)
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
    safetyMs: SAFETY_REFETCH_MS,
    now,
    timers: frameTimers
  })
  fetcher = view
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Whether the table holds an answer to show, as Searching keeps it under its banner. */
export function runsHaveData(): boolean {
  return read(loaded) !== null
}

/** A different Archon store: what the section held, chosen and loaded belongs to the old one. */
export function clearRuns(): void {
  set(filter, 'all')
  set(requested, ROWS_STEP)
  set(loaded, null)
  set(problem, null)
  set(lastGood, null)
  set(selected, null)
}

/** Reads the table again at once, as a person's action does. Nothing happens before the section starts. */
export function restartRuns(): void {
  fetcher?.restart()
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

/** Opens the workspace a run's folder belongs to. A failed request changes nothing. */
function openInOrca(workspaceId: string): void {
  plugin.request('workspace.open', { workspaceId }).then(
    () => {},
    () => {}
  )
}

/**
 * Under the worktree: **Open in Orca** when Orca lists the run's folder as a workspace, and
 * otherwise the hint about Orca's Non-Orca worktrees setting. Whether the folder exists is not
 * checked: the worker's closed disk list of #32 has no such read.
 */
function worktreeLine(run: RunRow): OrcaNode {
  if (run.workingPath === null) return null
  const { workspaceId } = run
  if (workspaceId !== undefined) {
    return (
      <Row>
        <Button size="sm" variant="outline" onPress={() => openInOrca(workspaceId)}>
          Open in Orca
        </Button>
      </Row>
    )
  }
  return (
    <Text muted size="sm">
      Orca does not show this worktree. To open it in Orca, show it in the project's Non-Orca worktrees setting.
    </Text>
  )
}

function preview(run: RunRow): OrcaNode {
  const facts: KeyValueItem[] = [{ label: 'Project', value: run.project ?? 'No project' }]
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
        {run.message === '' ? null : <Text>{run.message}</Text>}
        <KeyValue label="Run facts" items={facts} />
        {worktreeLine(run)}
      </Stack>
    </Card>
  )
}

function problemLine(held: Problem, hasData: boolean): OrcaNode {
  const when = hasData && held.lastGood !== null ? ` Last good answer at ${formatClock(held.lastGood, env.locale)}.` : ''
  return warningLine(`${held.message}${when}`, held.tryAgain ? () => restartRuns() : null)
}

function table(runs: Ready, status: StatusFilter): OrcaNode {
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
        emptyText={status === 'all' ? 'No runs.' : `No ${filterWord(status).toLowerCase()} runs.`}
        onSelectionChange={({ keys }) => set(selected, keys[0] ?? null)}
        onLoadMore={loadMore}
      />
      <Text muted size="sm">
        {countLine(runs)}
      </Text>
      {run === undefined ? null : preview(run)}
    </>
  )
}

/** The section while connected. */
export function runsSection(state: Connected): OrcaNode {
  const status = read(filter)
  const runs = read(loaded)
  const held = read(problem)
  const counts = runs?.counts
  const options = FILTER_ORDER.map((value) => ({
    value,
    label: counts === undefined ? filterWord(value) : `${filterWord(value)} (${String(counts[value])})`
  }))
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
      {scopeNotice()}
      <Row gap="sm" align="center">
        <Select label="Status" labelHidden value={status} options={options} onChange={chooseFilter} />
        <IconButton icon="refresh" label="Refresh runs" onPress={() => restartRuns()} />
      </Row>
      {held === null ? null : problemLine(held, runs !== null)}
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
