// Run detail, the second level of the Runs section: what one run is and how far it got. It draws
// only the worker's view model and fetches it under the shared per-view fetch rules, refetching
// on a hint that names the run, at most once a second, and on the safety refetch. The answer
// block, the action row and the row of small buttons come with their own tickets.
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
  type PanelContext,
  type Tone
} from 'orca'
import type { ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import { formatClock, formatDateTime, formatDuration, now } from './dates'
import { frameTimers } from './frame-timers'
import type { RunsHint } from './hint-view'
import { RUN_ID_CAP, type RunDetail, type RunDetailAnswer, type RunDetailRequest, type Step, type ChildRow, type Waiting } from './run-detail-view'
import { STATUS_GLYPH, STATUS_TONE, STATUS_WORD, statusText } from './run-status-words'
import { buildStepTree, NOT_REACHED_KEY, ranTimes, stepWords, type StepTree } from './step-tree'
import { createViewFetch, LIVE_OFF_REFETCH_MS, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { warningLine } from './view-notices'
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

/**
 * A read that failed: what to say, when the last good answer came, if one did, and whether it
 * offers "Try again".
 */
type Problem = { message: string; lastGood: number | null; tryAgain: boolean }
const problem = atom<Problem | null>(null)
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

function problemLine(held: Problem, hasData: boolean): OrcaNode {
  const at = hasData && held.lastGood !== null ? formatClock(held.lastGood, env.locale) : ''
  const when = at === '' ? '' : ` Last good answer at ${at}.`
  return warningLine(`${held.message}${when}`, held.tryAgain ? () => restartRunDetail() : null)
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
            The launch message is cut at 2,000 characters.
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
  set(problem, null)
  set(lastGood, null)
  set(factsOpen, false)
  set(messageOpen, false)
  set(flipped, [])
  set(selectedStep, null)
  set(shown, 'steps')
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

const STEP_TONE: Partial<Record<string, Tone>> = {
  Running: 'accent',
  Waiting: 'warning',
  Completed: 'success',
  Failed: 'danger'
}

/** The line under the tree about the selected step. */
function stepLine(step: Step, detail: RunDetail): OrcaNode {
  const { word } = stepWords(step, detail.status)
  const parts = [step.name, step.kind, step.loop === null ? null : `inner step of ${step.loop}`, ranTimes(step)]
  return (
    <Row gap="sm" wrap align="center">
      <Badge tone={STEP_TONE[word] ?? 'neutral'}>{word}</Badge>
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
          {countLine(hidden, 'The list stops at 500 steps: 1 step is not shown.', 'The list stops at 500 steps: N steps are not shown.')}
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
  if (value === 'steps' || value === 'artifacts') set(shown, value)
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

/** The waiting callout: what a run waits for, besides a question. */
function waitingCallout(waiting: Waiting | null): OrcaNode {
  if (waiting === null) return null
  if (waiting.kind === 'children') {
    const count = waiting.children.length + waiting.more
    return (
      <Callout tone="warning">
        <Stack gap="xs">
          <Text>{count === 1 ? 'Waiting for a sub-run.' : `Waiting for ${String(count)} sub-runs.`}</Text>
          <List label="Sub-runs">{waiting.children.map(childRow)}</List>
          {waiting.more > 0 ? (
            <Text muted size="sm">
              {`and ${String(waiting.more)} more`}
            </Text>
          ) : null}
        </Stack>
      </Callout>
    )
  }
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

function body(detail: RunDetail): OrcaNode {
  const showing = read(shown)
  // The answer block, which takes the waiting callout's place for a question, and the action row
  // go above the folds; the row of small buttons (Open graph, Open workflow in builder, Open
  // conversation) goes under them.
  return (
    <>
      {waitingCallout(detail.waiting)}
      {factsFold(detail)}
      {messageFold(detail)}
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
      {showing === 'steps' ? stepsBody(detail) : <Text muted>Artifacts are not shown in this version of Orchon.</Text>}
    </>
  )
}

/** Run detail while connected or under the Searching banner. It has no control that writes yet. */
export function runDetailSection(): OrcaNode {
  const detail = read(loaded)
  const held = read(problem)
  let content: OrcaNode
  if (read(gone)) content = <Text>This run no longer exists.</Text>
  else if (detail !== null) content = body(detail)
  else content = held === null ? <Spinner label="Loading the run…" /> : null
  return (
    <Stack gap="sm">
      {header(detail)}
      {held === null ? null : problemLine(held, detail !== null)}
      {content}
    </Stack>
  )
}
