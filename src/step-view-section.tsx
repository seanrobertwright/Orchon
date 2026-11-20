// The step view, the third level of the Runs section: what happened inside one step. It draws
// only the worker's view model: the step's facts, its output as plain text in blocks, and a page
// of its activity, which the worker folded from Archon's provider events. It is fetched under the
// shared per-view fetch rules, on its own request apart from run detail's, and again on a hint
// that names its run or its step. Selecting an item asks the worker for that item at that moment.
// Nothing here writes.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  env,
  KeyValue,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  Tree,
  type KeyValueItem,
  type OrcaNode,
  type PanelContext,
  type TreeItem
} from 'orca'
import { sizeText } from './artifacts-section'
import type { ConnectionView } from './connection-view'
import { BLOCK_LIMIT } from './cutter'
import { formatClock, formatDateTime, formatDuration, now } from './dates'
import { frameTimers } from './frame-timers'
import type { RunsHint } from './hint-view'
import { stepWords, ranTimes } from './step-tree'
import {
  ACTIVITY_PAGE,
  ACTIVITY_PAGES_CAP,
  STEP_EVENTS_CAP_BYTES,
  STEP_ID_CAP,
  STEP_OUTPUT_CAP,
  STEP_POLL_MS,
  TOOL_STATE_WORDS,
  type ActivityView,
  type CutText,
  type ItemView,
  type StepAnswer,
  type StepFacts,
  type StepHint,
  type StepOutput,
  type StepRequest
} from './step-view'
import { createViewFetch, LIVE_OFF_REFETCH_MS, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { problemLine, type ReadProblem } from './view-notices'
import { offersTryAgain, troubleText } from './worker-words'

/** The least time between two reads of the step view that no person asked for. */
export const STEP_VIEW_GAP_MS = 1_000

/** The open step, kept per workspace because Orca unmounts a hidden panel. Parsed on every read. */
const openStep = atom<unknown>('openStep', null, { persist: 'workspace' })

type Loaded = Extract<StepAnswer['step'], { kind: 'ready' }>
const loaded = atom<Loaded | null>(null)
/** What the view shows when Archon has no such run or step, or null. */
const missing = atom<'gone' | 'no-step' | null>(null)
const problem = atom<ReadProblem | null>(null)
const lastGood = atom<number | null>(null)
/** How many pages of activity show. */
const pages = atom(1)
const factsOpen = atom(false)
const outputOpen = atom(false)
const activityOpen = atom(true)
/** The attempts whose open state the person changed: every attempt is open by default. */
const flipped = atom<readonly string[]>([])
const selectedItem = atom<string | null>(null)
/** The selected item as the worker answered it, for the key it was asked for. */
const preview = atom<{ key: string; item: ItemView } | null>(null)

/** The open step's id, or null when run detail shows. */
export function openStepId(): string | null {
  const value = read(openStep)
  return typeof value === 'string' && value !== '' && value.length <= STEP_ID_CAP ? value : null
}

export type StepViewHooks = {
  connection(): ConnectionView | null
  showing(): boolean
  keep(view: ConnectionView): void
  /** The open run's id. */
  runId(): string | null
  /** The way back: run detail shows again, the step selected. */
  back(stepId: string): void
}

let fetcher: ViewFetch | undefined
let hooks: StepViewHooks | undefined
/** Rises with every item asked for, so only the newest answer is shown. */
let itemRequest = 0

function report(message: string, tryAgain = true): void {
  set(problem, { message, lastGood: read(lastGood), tryAgain })
}

function apply(answer: StepAnswer | null): void {
  if (answer === null) return
  hooks?.keep(answer.connection)
  const { step } = answer
  if (step.kind === 'ready') {
    if (step.facts.id !== openStepId()) return
    set(loaded, step)
    set(missing, null)
    set(problem, null)
    set(lastGood, now())
  } else if (step.kind === 'gone' || step.kind === 'no-step') {
    set(loaded, null)
    set(missing, step.kind)
    set(problem, null)
  } else if (step.kind === 'failed') {
    report(step.message)
  }
}

/** Tells the worker a step's view closed, so it stops polling the step. */
function close(runId: string | null, stepId: string | null): void {
  if (runId === null || stepId === null) return
  plugin.request('step.close', { runId, stepId }).catch(() => {})
}

/** Starts the view's fetch rules for this panel run. They stop, and the worker is told, when the panel closes. */
export function startStepView(ctx: PanelContext, given: StepViewHooks): void {
  hooks = given
  const view = createViewFetch<StepAnswer | null>({
    load(signal) {
      const runId = given.runId()
      const stepId = openStepId()
      if (runId === null || stepId === null || given.connection()?.kind !== 'connected' || !given.showing()) return Promise.resolve(null)
      const shown = read(pages)
      const request: StepRequest = shown === 1 ? { runId, stepId } : { runId, stepId, pages: shown }
      return plugin.request('step.read', request, { signal })
    },
    apply,
    fail(_error, trouble) {
      if (trouble !== null) report(troubleText(trouble), offersTryAgain(trouble))
    },
    minGapMs: STEP_VIEW_GAP_MS,
    safetyMs: () => {
      const state = given.connection()
      return state?.kind === 'connected' && !state.live ? LIVE_OFF_REFETCH_MS : SAFETY_REFETCH_MS
    },
    now,
    timers: frameTimers
  })
  fetcher = view
  ctx.subscriptions.push(plugin.on('step.changed', hintStep))
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
      close(given.runId(), openStepId())
    }
  })
  if (openStepId() !== null) view.restart()
}

/** A step shows as it first opens: Facts and Output shut, Activity open, its newest page, nothing selected. */
function resetView(): void {
  set(loaded, null)
  set(missing, null)
  set(problem, null)
  set(lastGood, null)
  set(pages, 1)
  set(factsOpen, false)
  set(outputOpen, false)
  set(activityOpen, true)
  set(flipped, [])
  set(selectedItem, null)
  set(preview, null)
}

/** Opens a step of the open run in place of run detail. */
export function openStepView(stepId: string): void {
  const before = openStepId()
  if (before !== null && before !== stepId) close(hooks?.runId() ?? null, before)
  set(openStep, stepId)
  resetView()
  fetcher?.restart()
}

/** A different run or store: no step is open. */
export function clearStepView(): void {
  set(openStep, null)
  resetView()
}

/** Reads the open step again at once, as a person's action does. */
export function restartStepView(): void {
  if (openStepId() !== null) fetcher?.restart()
}

/** A hint that runs changed: read again, once the gap allows, when it names the open run. */
export function hintStepRun(hint: RunsHint): void {
  const runId = hooks?.runId() ?? null
  if (openStepId() !== null && runId !== null && (hint.runs === 'many' || hint.runs.includes(runId))) fetcher?.refresh()
}

/** A hint from the worker's poll that the open step's activity changed. */
function hintStep(hint: StepHint): void {
  if (hint.stepId === openStepId() && hint.runId === hooks?.runId()) fetcher?.refresh()
}

/** Whether the step view holds an answer, as Searching keeps it under its banner. */
export function stepViewHasData(): boolean {
  return read(loaded) !== null
}

function back(): void {
  const stepId = openStepId()
  close(hooks?.runId() ?? null, stepId)
  set(openStep, null)
  resetView()
  if (stepId !== null) hooks?.back(stepId)
}

function header(facts: StepFacts | null): OrcaNode {
  return (
    <Row gap="sm" align="center" wrap>
      <Button size="sm" variant="ghost" tooltip="Back to run detail" onPress={back}>
        Run
      </Button>
      <Button size="sm" variant="outline" disabled={facts?.previous == null} onPress={() => facts?.previous == null || openStepView(facts.previous)}>
        Previous
      </Button>
      <Button size="sm" variant="outline" disabled={facts?.next == null} onPress={() => facts?.next == null || openStepView(facts.next)}>
        Next
      </Button>
    </Row>
  )
}

/** The facts as run detail's step row sees them, so the badge says the same word. */
function badge(facts: StepFacts): OrcaNode {
  const { word, tone } = stepWords({ ...facts, durationMs: facts.durationMs }, facts.runStatus)
  return <Badge tone={tone}>{word}</Badge>
}

/** "Step 3 of 6 · inner step of implement · ran 2 times". */
function positionLine(facts: StepFacts): string {
  const parts = [`Step ${String(facts.position)} of ${String(facts.count)}`, facts.loop === null ? null : `inner step of ${facts.loop}`, ranTimes(facts)]
  return parts.filter((part) => part !== null).join(' · ')
}

/** Why Archon skipped a step, in words, or Archon's own word for a reason this version does not know. */
const SKIP_WORDS: Record<string, string> = {
  prior_success: 'it succeeded in an earlier run',
  when_condition: 'its condition was false',
  when_condition_parse_error: 'its condition could not be read',
  trigger_rule: 'of its trigger rule',
  timeout: 'it timed out',
  skipped: 'Archon gave no reason'
}

function skipLines(facts: StepFacts): OrcaNode {
  if (facts.skip === null || facts.state !== 'skipped') return null
  const reason = Object.hasOwn(SKIP_WORDS, facts.skip.reason) ? SKIP_WORDS[facts.skip.reason] : facts.skip.reason
  return (
    <Stack gap="xs">
      <Text>{`Skipped because ${reason ?? facts.skip.reason}.`}</Text>
      {facts.skip.condition === null ? null : <Text muted>{`Condition: ${facts.skip.condition}`}</Text>}
    </Stack>
  )
}

function costText(cost: number | null): string | null {
  if (cost === null) return null
  if (cost > 0 && cost < 0.005) return 'Under $0.01'
  return `$${cost.toFixed(2)}`
}

/** The Facts fold, shut. */
function factsFold(facts: StepFacts): OrcaNode {
  const items: KeyValueItem[] = [{ label: 'Kind', value: facts.kind ?? 'Not known' }]
  const add = (label: string, value: string | null): void => {
    if (value !== null && value !== '') items.push({ label, value })
  }
  add('Started', facts.startedAt === null ? null : formatDateTime(facts.startedAt, env.locale))
  add('Ended', facts.endedAt === null ? null : formatDateTime(facts.endedAt, env.locale))
  add('Duration', facts.durationMs === null ? null : formatDuration(facts.durationMs))
  add('Cost', costText(facts.costUsd))
  add('Tokens', facts.tokens === null ? null : `${facts.tokens.input.toLocaleString('en-US')} in · ${facts.tokens.output.toLocaleString('en-US')} out`)
  add('Model', facts.model)
  add('Provider', facts.provider)
  add('Turns', facts.turns === null ? null : String(facts.turns))
  add('Stop reason', facts.stopReason)
  const summary = [facts.durationMs === null ? null : formatDuration(facts.durationMs), costText(facts.costUsd)].filter((part) => part !== null && part !== '').join(' · ')
  return (
    <Collapsible title="Facts" {...(summary === '' ? {} : { description: summary })} open={read(factsOpen)} onChange={(open) => set(factsOpen, open)}>
      <KeyValue label="Step facts" items={items} />
    </Collapsible>
  )
}

/** The output's blocks, each keyed by where it starts in the output. */
function blocksOf(blocks: readonly string[]): OrcaNode[] {
  let at = 0
  return blocks.map((block) => {
    const key = `output:${String(at)}`
    at += block.length
    return <Text key={key}>{block}</Text>
  })
}

/** The Output fold, shut: plain text in blocks, and a line when the rest is not shown. */
function outputFold(output: StepOutput | null): OrcaNode {
  return (
    <Collapsible title="Output" open={read(outputOpen)} onChange={(open) => set(outputOpen, open)}>
      {output === null ? (
        <Text muted>The step gave no output.</Text>
      ) : (
        <Stack gap="xs">
          {blocksOf(output.blocks)}
          {output.notShown > 0 ? (
            <Text muted size="sm">
              {`The output is cut at ${sizeText(STEP_OUTPUT_CAP)}: the last ${output.notShown.toLocaleString('en-US')} characters are not shown.`}
            </Text>
          ) : null}
        </Stack>
      )}
    </Collapsible>
  )
}

/** The activity tree of the answer last shown, so a render does not build it again. */
let built: { activity: ActivityView; items: TreeItem[]; attempts: string[] } | undefined

function treeOf(activity: Extract<ActivityView, { kind: 'ready' }>): { items: TreeItem[]; attempts: string[] } {
  if (built?.activity !== activity) {
    const items = activity.attempts.map((attempt) => ({
      key: attempt.key,
      label: `Attempt ${String(attempt.number)}`,
      children: attempt.rows.map((row) => {
        const time = row.at === null ? '' : formatClock(row.at, env.locale)
        return { key: row.key, label: row.label === '' ? row.detail : row.label, description: [row.detail, time].filter((part) => part !== '').join(' · ') }
      })
    }))
    built = { activity, items, attempts: activity.attempts.map((attempt) => attempt.key) }
  }
  return built
}

function toggle(key: string): void {
  const held = read(flipped)
  set(flipped, held.includes(key) ? held.filter((other) => other !== key) : [...held, key])
}

const count = (value: number, one: string, many: string): string => (value === 1 ? one : many.replace('N', value.toLocaleString('en-US')))

async function selectItem(runId: string, stepId: string, key: string): Promise<void> {
  set(selectedItem, key)
  set(preview, null)
  itemRequest += 1
  const mine = itemRequest
  try {
    const answer = await plugin.request('step.item', { runId, stepId, key })
    hooks?.keep(answer.connection)
    if (mine === itemRequest && openStepId() === stepId) set(preview, { key, item: answer.item })
  } catch {
    if (mine === itemRequest && openStepId() === stepId) set(preview, { key, item: { kind: 'failed', message: "Orchon's background process did not answer." } })
  }
}

/** A text of the preview, and the line saying it was cut. */
function cutBlock(label: string, text: CutText | null, empty: string): OrcaNode {
  return (
    <Stack gap="xs">
      <Text weight="semibold">{label}</Text>
      {text === null || text.text === '' ? <Text muted>{empty}</Text> : <Text>{text.text}</Text>}
      {text?.cut === true ? (
        <Text muted size="sm">
          {`The text is cut at ${sizeText(BLOCK_LIMIT)}.`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** The selected item, under the tree. */
function previewOf(item: ItemView): OrcaNode {
  switch (item.kind) {
    case 'not-connected':
      return <Text muted>Orchon is not connected to Archon.</Text>
    case 'not-found':
      return <Text muted>This item is no longer in the step's activity.</Text>
    case 'failed':
      return <Text>{item.message}</Text>
    case 'text':
      return cutBlock('Agent text', item.text, 'No text.')
    case 'thinking':
      return cutBlock('Thinking', item.text, 'No text.')
    case 'warning':
      return cutBlock(item.code === null ? 'Warning' : `Warning ${item.code}`, item.text, 'No message.')
    case 'subtask':
      return (
        <Stack gap="xs">
          <Text weight="semibold">{item.description ?? 'Subtask'}</Text>
          <Text muted>{`Status: ${item.status}`}</Text>
          {cutBlock('Summary', item.summary, 'No summary.')}
        </Stack>
      )
    case 'hook':
      return (
        <Stack gap="xs">
          <Text weight="semibold">{`Hook ${item.name} failed`}</Text>
          {item.event === null ? null : <Text muted>{`Fired on ${item.event}`}</Text>}
          {item.exitCode === null ? null : <Text muted>{`Exit code ${String(item.exitCode)}`}</Text>}
        </Stack>
      )
    case 'tool':
      return (
        <Stack gap="sm">
          <Row gap="sm" align="center" wrap>
            <Text weight="semibold">{item.title === null || item.title === '' ? item.name : `${item.name}: ${item.title}`}</Text>
            <Text muted>{TOOL_STATE_WORDS[item.state]}</Text>
            {item.exitCode === null ? null : <Text muted>{`Exit code ${String(item.exitCode)}`}</Text>}
          </Row>
          {cutBlock('Input', item.input, 'No input.')}
          {cutBlock('Output', item.output, item.state === 'running' ? 'No output yet.' : 'No output.')}
          {item.outputTruncated ? (
            <Text muted size="sm">
              Archon stored only part of this output.
            </Text>
          ) : null}
        </Stack>
      )
  }
}

function showEarlier(): void {
  set(pages, Math.min(read(pages) + 1, ACTIVITY_PAGES_CAP))
  fetcher?.restart()
}

function activityBody(runId: string, stepId: string, activity: ActivityView): OrcaNode {
  if (activity.kind === 'too-large') {
    return (
      <Callout tone="warning">
        <Text>{`This step's activity is larger than ${sizeText(STEP_EVENTS_CAP_BYTES)}, so Orchon does not show it. Open Archon's console to look at it.`}</Text>
      </Callout>
    )
  }
  if (activity.kind === 'failed') return <Text>{activity.message}</Text>
  const tree = treeOf(activity)
  const changed = read(flipped)
  const chosen = read(selectedItem)
  const shown = read(preview)
  return (
    <Stack gap="sm">
      {activity.live ? <Text muted size="sm">{`The step is running: new activity is read every ${String(STEP_POLL_MS / 1_000)} seconds.`}</Text> : null}
      {activity.total === 0 ? (
        <Text muted>No activity was recorded for this step.</Text>
      ) : (
        <Tree
          label="Activity"
          items={tree.items}
          maxHeight="lg"
          expanded={tree.attempts.filter((key) => !changed.includes(key))}
          {...(chosen === null ? {} : { selected: chosen })}
          onToggle={({ key }) => toggle(key)}
          onSelect={({ key }) => {
            if (!tree.attempts.includes(key)) void selectItem(runId, stepId, key)
          }}
        />
      )}
      {activity.total === 0 ? null : (
        <Text muted size="sm">
          {`${activity.loaded.toLocaleString('en-US')} of ${count(activity.total, '1 item loaded.', 'N items loaded.')}`}
        </Text>
      )}
      {activity.earlier > 0 ? (
        <Row>
          <Button size="sm" variant="outline" onPress={showEarlier}>
            {`Show earlier (${activity.earlier.toLocaleString('en-US')} more)`}
          </Button>
        </Row>
      ) : null}
      {activity.pastCap > 0 ? (
        <Text muted size="sm">
          {count(
            activity.pastCap,
            `The list stops at ${(ACTIVITY_PAGE * ACTIVITY_PAGES_CAP).toLocaleString('en-US')} items: 1 earlier item is not shown.`,
            `The list stops at ${(ACTIVITY_PAGE * ACTIVITY_PAGES_CAP).toLocaleString('en-US')} items: N earlier items are not shown.`
          )}
        </Text>
      ) : null}
      {activity.hidden > 0 ? (
        <Text muted size="sm">
          {count(
            activity.hidden,
            '1 event is not listed: a hook that did not fail, a state update or a kind Orchon does not list.',
            'N events are not listed: hooks that did not fail, state updates and kinds Orchon does not list.'
          )}
        </Text>
      ) : null}
      {activity.unreadable > 0 ? (
        <Text muted size="sm">
          {count(activity.unreadable, '1 event could not be read and is not listed.', 'N events could not be read and are not listed.')}
        </Text>
      ) : null}
      {chosen === null ? null : shown?.key === chosen ? previewOf(shown.item) : <Spinner label="Loading the item…" />}
    </Stack>
  )
}

function body(runId: string, step: Loaded): OrcaNode {
  const { facts } = step
  return (
    <>
      <Row gap="sm" align="center" wrap>
        <Text weight="semibold">{facts.name}</Text>
        {badge(facts)}
      </Row>
      <Text muted>{positionLine(facts)}</Text>
      {facts.error === null ? null : (
        <Callout tone="danger" title="The step failed">
          <Text>{facts.error}</Text>
        </Callout>
      )}
      {skipLines(facts)}
      {factsFold(facts)}
      {outputFold(step.output)}
      <Collapsible title="Activity" open={read(activityOpen)} onChange={(open) => set(activityOpen, open)}>
        {activityBody(runId, facts.id, step.activity)}
      </Collapsible>
    </>
  )
}

/** The step view while connected or under the Searching banner. Nothing in it writes. */
export function stepViewSection(): OrcaNode {
  const runId = hooks?.runId() ?? null
  const step = read(loaded)
  const held = read(problem)
  const gone = read(missing)
  let content: OrcaNode
  if (gone !== null) {
    content = <Text>{gone === 'gone' ? 'This run no longer exists.' : 'This run has no such step any more.'}</Text>
  } else if (step !== null && runId !== null) content = body(runId, step)
  else content = held === null ? <Spinner label="Loading the step…" /> : null
  return (
    <Stack gap="sm">
      {header(step?.facts ?? null)}
      {held === null ? null : problemLine(held, step !== null, () => restartStepView())}
      {content}
    </Stack>
  )
}
