// Run detail, the second level of the Runs section: what one run is and how far it got. It draws
// only the worker's view model and fetches it under the shared per-view fetch rules, refetching
// on a hint that names the run, at most once a second, and on the safety refetch. The action row
// is drawn by `run-actions.tsx`; the answer block and the row of small buttons come with their
// own tickets.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  env,
  KeyValue,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  Tree,
  type KeyValueItem,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { artifactsBody, openArtifacts, resetArtifacts, startArtifactsView } from './artifacts-section'
import type { ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import { formatDateTime, formatDuration, now } from './dates'
import { frameTimers } from './frame-timers'
import type { RunsHint } from './hint-view'
import { actionRow, outcomeCallout, resetRunActions, runActionsRead, type RunActionHooks } from './run-actions'
import { LAUNCH_MESSAGE_CAP, RUN_ID_CAP, STEP_ROWS_CAP, type RunDetail, type RunDetailAnswer, type RunDetailRequest, type StalledCall, type Step, type ChildRow, type Waiting } from './run-detail-view'
import { STATUS_GLYPH, STATUS_TONE, STATUS_WORD, statusText } from './run-status-words'
import { buildStepTree, NOT_REACHED_KEY, ranTimes, stepWords, type StepTree } from './step-tree'
import { createViewFetch, LIVE_OFF_REFETCH_MS, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { problemLine, type ReadProblem } from './view-notices'
import { offersTryAgain, troubleText } from './worker-words'
import { worktreeLine } from './worktree-line'

/** The least time between two reads of run detail that no person asked for. */
export const RUN_DETAIL_GAP_MS = 1_000

/**
 * The run that is open, kept per workspace because Orca unmounts a hidden panel. It is stored as
 * whatever was written, so it is parsed on every read.
 */
const openRun = atom<unknown>('openRun', null, { persist: 'workspace' })
const loaded = atom<RunDetail | null>(null)
/** Set when Archon answered that the open run does not exist. */
const gone = atom(false)

/** Why Open graph is off, as the worker last said, or null when it is on. */
const graphOff = atom<string | null>(null)
/** Why the last press of Open graph opened nothing, or null. */
const graphRefused = atom<string | null>(null)

const problem = atom<ReadProblem | null>(null)
const lastGood = atom<number | null>(null)

function report(message: string, tryAgain = true): void {
  set(problem, { message, lastGood: read(lastGood), tryAgain })
}

/** The open run's id, or null when the runs table shows. */
export function openRunId(): string | null {
  const value = read(openRun)
  return typeof value === 'string' && value !== '' && value.length <= RUN_ID_CAP ? value : null
}

/** What the view reads from the rest of the panel. */
export type RunDetailHooks = {
  connection(): ConnectionView | null
  /** Whether the Runs section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** The way back: the runs table shows again and is read again. */
  back(): void
}

let fetcher: ViewFetch | undefined
let hooks: RunDetailHooks | undefined
/** The run the next read asks for as just opened, so the worker looks its sub-runs up at once. */
let opening: string | null = null

function apply(answer: RunDetailAnswer | null): void {
  if (answer === null) return
  hooks?.keep(answer.connection)
  const { run } = answer
  if (run.kind === 'ready' && run.detail.id === openRunId()) {
    set(loaded, run.detail)
    set(graphOff, answer.graphOff ?? null)
    runActionsRead(run.detail)
    set(gone, false)
    set(problem, null)
    set(lastGood, now())
  } else if (run.kind === 'gone') {
    set(loaded, null)
    set(gone, true)
    set(problem, null)
  } else if (run.kind === 'failed') {
    report(run.message)
  }
}

/** Starts the view's fetch rules for this panel run. They stop when the panel closes. */
export function startRunDetail(ctx: PanelContext, given: RunDetailHooks): void {
  hooks = given
  const view = createViewFetch<RunDetailAnswer | null>({
    load(signal) {
      const runId = openRunId()
      if (runId === null || given.connection()?.kind !== 'connected' || !given.showing()) return Promise.resolve(null)
      const request: RunDetailRequest = opening === runId ? { runId, open: true } : { runId }
      opening = null
      return plugin.request('run.read', request, { signal })
    },
    apply,
    // Worker unreachable, said by the shared fetch rules; a rate-limited read says nothing.
    fail(_error, trouble) {
      if (trouble !== null) report(troubleText(trouble), offersTryAgain(trouble))
    },
    minGapMs: RUN_DETAIL_GAP_MS,
    safetyMs: () => {
      const state = given.connection()
      return state?.kind === 'connected' && !state.live ? LIVE_OFF_REFETCH_MS : SAFETY_REFETCH_MS
    },
    now,
    timers: frameTimers
  })
  fetcher = view
  startArtifactsView(ctx)
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Whether run detail holds an answer to show, as Searching keeps it under its banner. */
export function runDetailHasData(): boolean {
  return read(loaded) !== null
}

/** A different Archon store: the open run belongs to the old one. */
export function clearRunDetail(): void {
  set(openRun, null)
  set(loaded, null)
  resetView()
}

/** Opens a run in place of the runs table. */
export function openRunDetail(runId: string): void {
  set(openRun, runId)
  set(loaded, null)
  resetView()
  opening = runId
  fetcher?.restart()
}

/** Reads the open run again at once, as a person's action does. */
export function restartRunDetail(): void {
  const runId = openRunId()
  if (runId === null) return
  if (read(loaded) === null) opening = runId
  fetcher?.restart()
}

/** A hint that runs changed: read again, once the gap allows, when it names the open run. */
export function hintRunDetail(hint: RunsHint): void {
  const runId = openRunId()
  if (runId !== null && (hint.runs === 'many' || hint.runs.includes(runId))) fetcher?.refresh()
}

function back(): void {
  set(openRun, null)
  set(loaded, null)
  resetView()
  hooks?.back()
}

function header(detail: RunDetail | null): OrcaNode {
  return (
    <Row gap="sm" align="center">
      <Button size="sm" variant="ghost" tooltip="Back to the runs table" onPress={back}>
        Runs
      </Button>
      {detail === null ? null : (
        <>
          <Text weight="semibold" truncate>
            {detail.workflow}
          </Text>
          <Badge tone={STATUS_TONE[detail.status]}>{STATUS_WORD[detail.status]}</Badge>
        </>
      )}
    </Row>
  )
}

/** Whether each fold is open. Both are shut until the person opens them. */
const factsOpen = atom(false)
const messageOpen = atom(false)

/** A cost in US dollars, as the facts show it. */
function costText(cost: number | null): string {
  if (cost === null) return 'No cost reported'
  if (cost > 0 && cost < 0.005) return 'Under $0.01'
  return `$${cost.toFixed(2)}`
}

/** How long a run ran, once it has ended, or null. */
function ranFor(detail: RunDetail): string | null {
  if (detail.startedAt === null || detail.endedAt === null) return null
  const text = formatDuration(detail.endedAt - detail.startedAt)
  return text === '' ? null : text
}

/** The Run facts fold, shut, summarised by duration, cost and project. */
function factsFold(detail: RunDetail): OrcaNode {
  const duration = ranFor(detail)
  const project = detail.project ?? 'No project'
  const summary = [duration, costText(detail.costUsd), project].filter((part) => part !== null).join(' · ')
  const facts: KeyValueItem[] = [
    { label: 'Workflow', value: detail.workflow },
    { label: 'State', value: statusText(detail.status) }
  ]
  if (detail.startedAt !== null) facts.push({ label: 'Started', value: formatDateTime(detail.startedAt, env.locale) })
  if (duration !== null) facts.push({ label: 'Duration', value: duration })
  facts.push({ label: 'Cost', value: costText(detail.costUsd) }, { label: 'Project', value: project })
  facts.push({ label: 'Run id', value: detail.id.slice(0, 8), code: true })
  if (detail.workingPath !== null) facts.push({ label: 'Worktree', value: detail.workingPath, code: true })
  return (
    <Collapsible title="Run facts" description={summary} open={read(factsOpen)} onChange={(open) => set(factsOpen, open)}>
      <Stack gap="sm">
        {detail.endedAt === null && detail.startedAt !== null ? (
          <Text muted>
            Started <RelativeTime at={detail.startedAt} />
          </Text>
        ) : null}
        <KeyValue label="Run facts" items={facts} />
        {worktreeLine(detail)}
      </Stack>
    </Collapsible>
  )
}

/** How much of the launch message the fold's shut line shows. */
const MESSAGE_LINE_CAP = 80

/** The Launch message fold, shut: plain text, and a line when it was cut. */
function messageFold(detail: RunDetail): OrcaNode {
  const firstLine = detail.message.split('\n', 1)[0] ?? ''
  const line = firstLine === '' ? 'No launch message' : cutAt(firstLine, MESSAGE_LINE_CAP)
  return (
    <Collapsible title="Launch message" description={line} open={read(messageOpen)} onChange={(open) => set(messageOpen, open)}>
      <Stack gap="xs">
        {detail.message === '' ? <Text muted>The run was started with no message.</Text> : <Text>{detail.message}</Text>}
        {detail.messageCut ? (
          <Text muted size="sm">
            {`The launch message is cut at ${LAUNCH_MESSAGE_CAP.toLocaleString('en-US')} characters.`}
          </Text>
        ) : null}
      </Stack>
    </Collapsible>
  )
}

/** The tree of the answer last built, so a render does not build it again. */
let built: { detail: RunDetail; tree: StepTree } | undefined

function treeOf(detail: RunDetail): StepTree {
  if (built?.detail !== detail) built = { detail, tree: buildStepTree(detail.steps, detail.status) }
  return built.tree
}

/** The keys whose open state the person changed from the default: loops open, Not reached shut. */
const flipped = atom<readonly string[]>([])
const selectedStep = atom<string | null>(null)
const shown = atom<'steps' | 'artifacts'>('steps')

/** A run opens as it first shows: both folds shut, Steps chosen, every loop open and no step selected. */
function resetView(): void {
  set(gone, false)
  set(graphOff, null)
  set(graphRefused, null)
  set(problem, null)
  set(lastGood, null)
  set(factsOpen, false)
  set(messageOpen, false)
  set(flipped, [])
  set(selectedStep, null)
  set(shown, 'steps')
  resetArtifacts()
  resetRunActions()
}

function toggle(tree: StepTree, key: string, expanded: boolean): void {
  const byDefault = tree.loops.includes(key)
  const others = read(flipped).filter((held) => held !== key)
  set(flipped, expanded === byDefault ? others : [...others, key])
}

function expandedKeys(tree: StepTree): string[] {
  const changed = read(flipped)
  const open = tree.loops.filter((key) => !changed.includes(key))
  return changed.includes(NOT_REACHED_KEY) ? [...open, NOT_REACHED_KEY] : open
}

/** A count line with one wording for one and another, with N for the count, for more. */
const countLine = (count: number, one: string, many: string): string => (count === 1 ? one : many.replace('N', String(count)))

/** The line under the tree about the selected step. */
function stepLine(step: Step, detail: RunDetail): OrcaNode {
  const { word, tone } = stepWords(step, detail.status)
  const parts = [step.name, step.kind, step.loop === null ? null : `inner step of ${step.loop}`, ranTimes(step)]
  return (
    <Row gap="sm" wrap align="center">
      <Badge tone={tone}>{word}</Badge>
      <Text>{parts.filter((part) => part !== null).join(' · ')}</Text>
    </Row>
  )
}

function stepsBody(detail: RunDetail): OrcaNode {
  const tree = treeOf(detail)
  const chosen = read(selectedStep)
  const step = chosen === null ? undefined : tree.byKey.get(chosen)
  const hidden = detail.stepCount - detail.steps.length
  return (
    <Stack gap="sm">
      {tree.items.length === 0 ? (
        <Text muted>This run has no steps yet.</Text>
      ) : (
        <Tree
          label="Steps"
          items={tree.items}
          maxHeight="lg"
          expanded={expandedKeys(tree)}
          {...(step === undefined || chosen === null ? {} : { selected: chosen })}
          onToggle={({ key, expanded }) => toggle(tree, key, expanded)}
          onSelect={({ key }) => set(selectedStep, tree.byKey.has(key) ? key : null)}
        />
      )}
      {hidden > 0 ? (
        <Text muted size="sm">
          {countLine(hidden, `The list stops at ${String(STEP_ROWS_CAP)} steps: 1 step is not shown.`, `The list stops at ${String(STEP_ROWS_CAP)} steps: N steps are not shown.`)}
        </Text>
      ) : null}
      {detail.unreadableSteps > 0 ? (
        <Text muted size="sm">
          {countLine(detail.unreadableSteps, '1 step could not be read and is not shown.', 'N steps could not be read and are not shown.')}
        </Text>
      ) : null}
      {step === undefined ? null : stepLine(step, detail)}
    </Stack>
  )
}

function chooseShown(value: string): void {
  if (value !== 'steps' && value !== 'artifacts') return
  const before = read(shown)
  set(shown, value)
  // The list is asked for only when Artifacts is chosen.
  const runId = openRunId()
  if (value === 'artifacts' && before !== 'artifacts' && runId !== null) openArtifacts(runId)
}

/** A wait's time in the person's locale, or null when Archon's did not parse. */
const untilText = (until: number | null): string | null => {
  const text = until === null ? '' : formatDateTime(until, env.locale)
  return text === '' ? null : text
}

/** One sub-run a parent waits on: a row that opens it, and holds no other control. */
function childRow(child: ChildRow): OrcaNode {
  const title = child.workflow === null ? child.id.slice(0, 8) : `${child.status === null ? '' : `${STATUS_GLYPH[child.status]} `}${child.workflow}`
  return (
    <ListItem
      key={child.id}
      title={title}
      description={child.status === null ? 'State not known' : STATUS_WORD[child.status]}
      onPress={() => openRunDetail(child.id)}
    />
  )
}

/** What a waiting callout says when Orchon cannot tell more: a pointer to Archon's console. */
const CONSOLE_POINTER = "Open Archon's console to look at it."

/** A warning callout holding its lines. */
const warningCallout = (lines: OrcaNode): OrcaNode => (
  <Callout tone="warning">
    <Stack gap="xs">{lines}</Stack>
  </Callout>
)

/** "and N more" under a capped list, or nothing. */
const moreLine = (more: number): OrcaNode =>
  more > 0 ? (
    <Text muted size="sm">
      {`and ${String(more)} more`}
    </Text>
  ) : null

/** One stalled tool call: its name and title, and how long it has not answered. */
function stalledRow(call: StalledCall, index: number): OrcaNode {
  const silent = formatDuration(call.stalledForMs)
  return (
    <ListItem
      key={`${String(index)}:${call.name}`}
      title={call.title === null ? call.name : `${call.name}: ${call.title}`}
      description={silent === '' ? 'No answer yet' : `No answer for ${silent}`}
    />
  )
}

/** The waiting callout: what a run waits for with nothing to answer (#14, part 7). */
function waitingCallout(waiting: Waiting | null): OrcaNode {
  if (waiting === null) return null
  switch (waiting.kind) {
    case 'children': {
      const count = waiting.children.length + waiting.more
      return warningCallout(
        <>
          <Text>{count === 1 ? 'Waiting on 1 sub-run. Answer it in its own run.' : `Waiting on ${String(count)} sub-runs. Answer each one in its own run.`}</Text>
          <List label="Sub-runs">{waiting.children.map(childRow)}</List>
          {moreLine(waiting.more)}
        </>
      )
    }
    case 'usage-limit':
      return warningCallout(
        waiting.resumeAt === null ? (
          <Text>Paused on a provider usage limit. Archon tries again by itself.</Text>
        ) : (
          <Text>
            Paused on a provider usage limit. Archon tries again by itself <RelativeTime at={waiting.resumeAt} />.
          </Text>
        )
      )
    case 'unreadable':
      return warningCallout(
        <>
          <Text>{`Orchon cannot read what this run waits for. ${CONSOLE_POINTER}`}</Text>
          {waiting.detail === '' ? null : <Text muted>{waiting.detail}</Text>}
        </>
      )
    case 'stalled': {
      const count = waiting.calls.length + waiting.more
      return warningCallout(
        <>
          <Text>{count === 1 ? '1 tool call has not returned.' : `${String(count)} tool calls have not returned.`}</Text>
          <List label="Tool calls that have not returned">{waiting.calls.map(stalledRow)}</List>
          {moreLine(waiting.more)}
        </>
      )
    }
    case 'unknown':
      return warningCallout(<Text>{`This run is waiting in a way this version of Orchon does not know. ${CONSOLE_POINTER}`}</Text>)
    case 'time':
    case 'event': {
      const until = untilText(waiting.until)
      const sentence =
        waiting.kind === 'time'
          ? until === null
            ? 'Waiting until a set time.'
            : `Waiting until ${until}.`
          : until === null
            ? `Waiting for the event ${waiting.event}.`
            : `Waiting for the event ${waiting.event}, until ${until} at the latest.`
      return (
        <Callout tone="warning">
          <Text>{sentence}</Text>
        </Callout>
      )
    }
  }
}

/** What the action row reaches in run detail. */
const actionHooks: RunActionHooks = {
  openRunId,
  restart: restartRunDetail,
  openRun: openRunDetail,
  gone() {
    set(loaded, null)
    set(gone, true)
    set(problem, null)
  },
  keep: (view) => hooks?.keep(view)
}

/** What a press of Open graph says when the worker itself does not answer. */
export const GRAPH_UNANSWERED = "The graph tab did not open: Orchon's worker did not answer."

async function openGraph(runId: string): Promise<void> {
  set(graphRefused, null)
  try {
    const answer = await plugin.request('graph.open', { runId })
    if (!answer.opened && openRunId() === runId) set(graphRefused, answer.reason)
  } catch {
    if (openRunId() === runId) set(graphRefused, GRAPH_UNANSWERED)
  }
}

/**
 * Open graph, under the folds. It is off, with the worker's reason beside it, when no local
 * workspace is focused, in a remote one, for a run with no project and after a failed write;
 * and off while Orchon is not connected, which the Searching banner says.
 */
function graphRow(detail: RunDetail): OrcaNode {
  const off = read(graphOff)
  const refused = read(graphRefused)
  const connected = hooks?.connection()?.kind === 'connected'
  return (
    <Stack gap="xs">
      <Row gap="sm" wrap>
        <Button size="sm" variant="outline" disabled={off !== null || !connected} onPress={() => void openGraph(detail.id)}>
          Open graph
        </Button>
      </Row>
      {off === null ? null : (
        <Text muted size="sm">
          {off}
        </Text>
      )}
      {refused === null || off !== null ? null : <Text size="sm">{refused}</Text>}
    </Stack>
  )
}

function body(detail: RunDetail, writable: boolean): OrcaNode {
  const showing = read(shown)
  // The answer block, which takes the waiting callout's place for a question, goes above the
  // action row; the row of small buttons goes under the folds: Open graph, and with their own
  // tickets Open workflow in builder and Open conversation.
  return (
    <>
      {waitingCallout(detail.waiting)}
      {actionRow(detail, writable, actionHooks)}
      {outcomeCallout(detail, actionHooks)}
      {factsFold(detail)}
      {messageFold(detail)}
      {graphRow(detail)}
      <Select
        label="Show"
        labelHidden
        value={showing}
        options={[
          { value: 'steps', label: `Steps (${String(detail.stepCount)})` },
          { value: 'artifacts', label: 'Artifacts' }
        ]}
        onChange={chooseShown}
      />
      {showing === 'steps' ? stepsBody(detail) : artifactsBody(detail.id)}
    </>
  )
}

/** Run detail while connected or under the Searching banner. `writable` is false when its controls that write are off. */
export function runDetailSection(writable: boolean): OrcaNode {
  const detail = read(loaded)
  const held = read(problem)
  let content: OrcaNode
  if (read(gone)) {
    content = (
      <Stack gap="xs">
        <Text>This run no longer exists.</Text>
        <Row>
          <Button size="sm" variant="outline" onPress={back}>
            Back to runs
          </Button>
        </Row>
      </Stack>
    )
  } else if (detail !== null) content = body(detail, writable)
  else content = held === null ? <Spinner label="Loading the run…" /> : null
  return (
    <Stack gap="sm">
      {header(detail)}
      {held === null ? null : problemLine(held, detail !== null, () => restartRunDetail())}
      {content}
    </Stack>
  )
}
