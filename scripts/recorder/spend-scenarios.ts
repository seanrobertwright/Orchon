// What spend mode records: one scenario, chosen by name. Every request goes through a tape, as in
// the recording that spends nothing, and a scenario that calls a model is watched against its
// ceilings from the moment it is started.
import { field, text } from '../shape.ts'
import { createCeilingGuard, watchRun, type CeilingGuard, type Crossing } from './ceiling.ts'
import type { Frame } from './frames.ts'
import type { SyntheticLog } from './log.ts'
import type { StreamReader, Tape } from './recording.ts'
import type { Session } from './session.ts'
import { SPEND_SCENARIOS, type SpendScenarioName } from './spend.ts'
import { sleep as wait } from './wait.ts'
import {
  AGENT_STEP,
  assertAgentStepAsRead,
  assertReadWithoutAgent,
  CHAT_TURN_MESSAGE,
  LaunchRefused,
  RECORDER_WORKFLOWS,
  emptyStoreDescription,
  possiblySyntheticDescription,
  SMALL_TIER,
  SYNTHETIC_METRIC_NAMES,
  SYNTHETIC_METRICS,
  syntheticDescription,
  TERMINAL
} from './workflows.ts'

export interface SpendContext {
  /** The throwaway project's folder. */
  projectFolder: string
  /** The token ceiling the run was started with. */
  tokenCeiling: number
  /** The clock and the wait the scenario uses. A test passes ones it moves by hand. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface SpendOutcome {
  /** The tokens Archon reported, each report counted once. */
  tokensSeen: number
  /** The ceiling that was crossed, or null when the run ended under all of them. */
  crossed: Crossing | null
  /** The metrics scenario alone: whether its synthetic pack ran before the reports were read. */
  synthetic?: SyntheticLog
}

/** An agent step that makes more tool calls than this is cancelled. Its prompt needs two or three. */
export const AGENT_STEP_MAX_TOOL_CALLS = 5

/** How often a running scenario is read. */
const POLL_MS = 1000

/** How long a cancelled run is given to end before the release is stopped. */
const CANCEL_GRACE_MS = 30_000

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const segment = (id: string): string => encodeURIComponent(id)

/** The scenario ran into a ceiling it could not cancel through Archon: the release must be stopped. */
export class StopTheRelease extends Error {
  override name = 'StopTheRelease'
  /** What the scenario saw before it gave up, for the log. */
  readonly outcome: SpendOutcome

  constructor(message: string, outcome: SpendOutcome) {
    super(message)
    this.outcome = outcome
  }
}

interface Project {
  id: string
  cwd: string
}

interface Conversation {
  id: string
  conversationId: string
}

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/**
 * Whether the release runs the small tier, and Claude's chat, on Haiku, as the throwaway home's
 * config says. The answer is recorded, so the log shows the model the run was meant to use.
 */
async function runsOnHaiku(tape: Tape): Promise<string | null> {
  const answer = await tape.call('GET', '/api/config')
  const config = field(answer.body, 'config')
  const small = field(config, 'tiers', SMALL_TIER) ?? field(config, 'tierDefaults', SMALL_TIER)
  const tierModel = text(field(small, 'model')) ?? ''
  const chatModel = text(field(config, 'assistants', 'claude', 'model')) ?? ''
  if (field(small, 'provider') !== 'claude' || !/haiku/i.test(tierModel)) {
    return `the release runs the ${SMALL_TIER} tier on ${tierModel || 'no model'}, not Claude Haiku, so nothing was spent`
  }
  if (!/haiku/i.test(chatModel)) return `the release runs Claude's chat on ${chatModel || 'its default model'}, not Haiku, so nothing was spent`
  return null
}

async function registerProject(tape: Tape, folder: string): Promise<Project> {
  const made = await tape.call('POST', '/api/codebases', { path: folder })
  const id = text(field(made.body, 'id'))
  const cwd = text(field(made.body, 'default_cwd'))
  if (id === undefined || cwd === undefined) throw new Error(`The throwaway project was not registered: ${made.status}.`)
  return { id, cwd }
}

async function createConversation(tape: Tape, project: Project): Promise<Conversation> {
  const answer = await tape.call('POST', '/api/conversations', { codebaseId: project.id })
  const id = text(field(answer.body, 'id'))
  const conversationId = text(field(answer.body, 'conversationId'))
  if (id === undefined || conversationId === undefined) throw new Error(`No conversation was created: ${answer.status}.`)
  return { id, conversationId }
}

const belongsTo = (run: unknown, conversation: Conversation): boolean =>
  field(run, 'parent_conversation_id') === conversation.id || field(run, 'parent_platform_id') === conversation.conversationId

async function runsOf(tape: Tape, project: Project, conversation: Conversation): Promise<unknown[]> {
  const answer = await tape.peek('GET', `/api/dashboard/runs?codebaseId=${segment(project.id)}&limit=50`)
  return list(field(answer.body, 'runs')).filter((run) => belongsTo(run, conversation))
}

/** The id of the run the conversation started, or null when none appeared before a ceiling was crossed. */
async function waitForRun(tape: Tape, project: Project, conversation: Conversation, guard: CeilingGuard, clock: Clock): Promise<string | null> {
  while (guard.check() === null) {
    const id = text(field((await runsOf(tape, project, conversation))[0], 'id'))
    if (id !== undefined) {
      tape.note('run-found', { runId: id })
      return id
    }
    await clock.sleep(POLL_MS)
  }
  return null
}

const sawUnlockSince = (reader: StreamReader, from: number): boolean =>
  reader.frames.slice(from).some((frame: Frame) => field(frame.data, 'type') === 'conversation_lock' && field(frame.data, 'locked') === false)

async function readBack(tape: Tape, conversation: Conversation): Promise<void> {
  await tape.call('GET', `/api/conversations/${segment(conversation.conversationId)}`)
  await tape.call('GET', `/api/conversations/${segment(conversation.conversationId)}/messages?limit=50`)
}

/** Ends the scenario's tape: the spend it saw, then the fixture. */
function finish(session: Session, name: SpendScenarioName, holds: string, tape: Tape, guard: CeilingGuard, context: SpendContext): void {
  tape.note('spend-total', { tokens: guard.tokens(), tokenCeiling: context.tokenCeiling, wallClockMs: SPEND_SCENARIOS[name].wallClockMs })
  session.save(name, holds, tape)
}

// ---------------------------------------------------------------------------------------------
// agent-step: one agent step on the small tier, with its tool calls and provider events.
// ---------------------------------------------------------------------------------------------

async function recordAgentStep(session: Session, context: SpendContext, clock: Clock): Promise<SpendOutcome> {
  const tape = session.tape()
  const refusal = await runsOnHaiku(tape)
  if (refusal !== null) {
    session.missing('agent-step', refusal)
    return { tokensSeen: 0, crossed: null }
  }
  const project = await registerProject(tape, context.projectFolder)
  const loaded = await tape.peek('GET', `/api/workflows/${segment(AGENT_STEP.name)}?cwd=${encodeURIComponent(project.cwd)}`)
  if (field(loaded.body, 'source') !== 'project') throw new LaunchRefused(`${AGENT_STEP.name} is not read from the throwaway project.`)
  assertAgentStepAsRead(field(loaded.body, 'workflow'))
  const conversation = await createConversation(tape, project)
  const dashboard = await tape.stream('dashboard', '/api/stream/__dashboard__')
  const stream = await tape.stream('conversation', `/api/stream/${segment(conversation.conversationId)}`)
  const guard = createCeilingGuard({
    tokenCeiling: context.tokenCeiling,
    wallClockMs: SPEND_SCENARIOS['agent-step'].wallClockMs,
    maxToolCalls: AGENT_STEP_MAX_TOOL_CALLS,
    now: clock.now
  })
  tape.note('launch-sent', { workflow: AGENT_STEP.name })
  await tape.call('POST', `/api/workflows/${segment(AGENT_STEP.name)}/run`, {
    conversationId: conversation.conversationId,
    message: 'Recording an agent step for Orchon.'
  })
  const runId = await waitForRun(tape, project, conversation, guard, clock)
  let crossed: Crossing | null = guard.check()
  if (runId === null) session.missing('agent-step', 'no run of the agent step appeared before its wall-clock ceiling')
  else {
    const outcome = await watchRun(tape, runId, 'list', guard, { sleep: clock.sleep, pollMs: POLL_MS, cancelGraceMs: CANCEL_GRACE_MS })
    crossed = outcome.ended === 'finished' ? null : outcome.crossed
    if (outcome.ended === 'cancel-failed') {
      finish(session, 'agent-step', 'one agent step, cancelled at a ceiling; the cancel did not end it', tape, guard, context)
      throw new StopTheRelease(`The agent step crossed its ${outcome.crossed.by} ceiling and the cancel did not end it.`, {
        tokensSeen: guard.tokens(),
        crossed: outcome.crossed
      })
    }
    const run = `/api/workflows/runs/${segment(runId)}`
    await tape.call('GET', run)
    await tape.call('GET', `${run}/provider-events`)
    const events = await tape.call('GET', `${run}/provider-events?step=list`)
    const first = list(field(events.body, 'events'))[0]
    const attemptId = text(field(first, 'attemptId'))
    const seq = field(first, 'seq')
    if (attemptId === undefined || typeof seq !== 'number') session.missing('the provider-events cursor', 'the step reported no event with an attempt id')
    else await tape.call('GET', `${run}/provider-events?step=list&attemptId=${segment(attemptId)}&afterSeq=${seq}`)
  }
  await readBack(tape, conversation)
  await stream.close()
  await dashboard.close()
  finish(session, 'agent-step', 'one agent step on the small tier: the launch, its streams, its run and its provider events by step and by cursor', tape, guard, context)
  return { tokensSeen: guard.tokens(), crossed }
}

// ---------------------------------------------------------------------------------------------
// chat-turn: one web chat turn that asks Archon to run the recorder's shell-step workflow.
// ---------------------------------------------------------------------------------------------

async function recordChatTurn(session: Session, context: SpendContext, clock: Clock): Promise<SpendOutcome> {
  const tape = session.tape()
  const refusal = await runsOnHaiku(tape)
  if (refusal !== null) {
    session.missing('chat-turn', refusal)
    return { tokensSeen: 0, crossed: null }
  }
  const project = await registerProject(tape, context.projectFolder)
  const conversation = await createConversation(tape, project)
  const dashboard = await tape.stream('dashboard', '/api/stream/__dashboard__')
  const stream = await tape.stream('conversation', `/api/stream/${segment(conversation.conversationId)}`)
  const guard = createCeilingGuard({ tokenCeiling: context.tokenCeiling, wallClockMs: SPEND_SCENARIOS['chat-turn'].wallClockMs, now: clock.now })
  const sentAt = stream.frames.length
  await tape.call('POST', `/api/conversations/${segment(conversation.conversationId)}/message`, { message: CHAT_TURN_MESSAGE })
  const cancelled = new Set<string>()
  const cancel = async (runId: string): Promise<void> => {
    if (cancelled.has(runId)) return
    cancelled.add(runId)
    await tape.call('POST', `/api/workflows/runs/${segment(runId)}/cancel`)
  }
  let observed = 0
  let runIds: string[]
  for (;;) {
    for (const frame of stream.frames.slice(observed)) guard.observe(frame.data)
    observed = stream.frames.length
    runIds = (await runsOf(tape, project, conversation)).map((run) => text(field(run, 'id'))).filter((id): id is string => id !== undefined)
    let open = false
    for (const runId of runIds) {
      const detail = await tape.peek('GET', `/api/workflows/runs/${segment(runId)}`)
      guard.observe(detail.body)
      const workflow = text(field(detail.body, 'run', 'workflow_name'))
      const status = text(field(detail.body, 'run', 'status'))
      if (status === undefined || !TERMINAL.includes(status)) open = true
      // The chat may start only the recorder's own shell-step workflow. Anything else is stopped at once.
      if (workflow !== RECORDER_WORKFLOWS.echo.name && !cancelled.has(runId)) {
        tape.note('unexpected-workflow', { runId, workflow: workflow ?? null })
        await cancel(runId)
      }
    }
    if (!open && sawUnlockSince(stream, sentAt)) break
    const crossed = guard.check()
    if (crossed !== null) {
      tape.note('ceiling-crossed', { ...crossed })
      for (const runId of runIds) await cancel(runId)
      await stream.close()
      await dashboard.close()
      finish(session, 'chat-turn', 'one web chat turn, stopped at a ceiling', tape, guard, context)
      throw new StopTheRelease(`The chat turn crossed its ${crossed.by} ceiling. No route of the release cancels a chat turn, so the release is stopped.`, {
        tokensSeen: guard.tokens(),
        crossed
      })
    }
    await clock.sleep(POLL_MS)
  }
  if (runIds.length === 0) session.missing('the workflow a chat turn starts', 'the chat turn started no workflow run')
  await readBack(tape, conversation)
  for (const runId of runIds) await tape.call('GET', `/api/workflows/runs/${segment(runId)}`)
  await stream.close()
  await dashboard.close()
  finish(session, 'chat-turn', 'one web chat turn asking to run the shell-step workflow: the message, every stream frame, the saved messages and the run it started', tape, guard, context)
  return { tokensSeen: guard.tokens(), crossed: null }
}

// ---------------------------------------------------------------------------------------------
// metrics: the reports and the views, which spend nothing. The release never sees the login.
// ---------------------------------------------------------------------------------------------

/** Why no pack that emits real metrics is run: what `archon-metrics-prs` says it needs. */
export const METRICS_PACK_GAP =
  "archon-metrics-prs was not run: its own description says it needs a forge plugin whose pr.view reports pull request timestamps, which is a GitHub login, and it counts only pull requests the build queue opened, which a throwaway home has none of. The recorder handles no GitHub credential"

/** How long the synthetic pack has, from its launch, to run and have its records reported. */
export const SYNTHETIC_WAIT_MS = 60_000

/** What the fixture says it is when the synthetic pack ran before the reports were read. */
export const SYNTHETIC_LABEL = `SYNTHETIC: ${syntheticDescription()}`

/** Calls `probe` every poll until it answers something, or `until` passes on the clock. */
async function pollFor<T>(clock: Clock, until: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
  while (clock.now() < until) {
    const found = await probe()
    if (found !== undefined) return found
    await clock.sleep(POLL_MS)
  }
  return undefined
}

/**
 * Runs the synthetic pack the throwaway project holds and waits until Archon reports its records.
 * It is launched only when Archon reads it from the project as steps with no agent. When it was
 * never launched the reports are read over an empty store. Once Archon has accepted the launch,
 * the run may have printed its records, so a failure after that answers `possibly-synthetic`.
 */
async function runSyntheticPack(tape: Tape, project: Project, guard: CeilingGuard, clock: Clock): Promise<SyntheticLog> {
  const name = SYNTHETIC_METRICS.name
  const loaded = await tape.call('GET', `/api/workflows/${segment(name)}?cwd=${encodeURIComponent(project.cwd)}`)
  if (field(loaded.body, 'source') !== 'project') return { records: 'none', why: `Archon does not read ${name} from the throwaway project: it answered ${loaded.status}` }
  try {
    assertReadWithoutAgent(field(loaded.body, 'workflow'))
  } catch (error) {
    if (error instanceof LaunchRefused) return { records: 'none', why: error.message }
    throw error
  }
  const conversation = await createConversation(tape, project)
  const until = clock.now() + SYNTHETIC_WAIT_MS
  const seconds = SYNTHETIC_WAIT_MS / 1000
  tape.note('launch-sent', { workflow: name })
  const launched = await tape.call('POST', `/api/workflows/${segment(name)}/run`, {
    conversationId: conversation.conversationId,
    message: 'Recording synthetic metrics for Orchon: one shell step, made-up numbers.'
  })
  if (launched.status < 200 || launched.status >= 300) return { records: 'none', why: `the launch of ${name} answered ${launched.status}` }
  const runId = await pollFor(clock, until, async () => text(field((await runsOf(tape, project, conversation))[0], 'id')))
  if (runId === undefined) return { records: 'possibly-synthetic', why: `no run of ${name} appeared within ${seconds} seconds` }
  tape.note('run-found', { runId })
  const run = `/api/workflows/runs/${segment(runId)}`
  const status = await pollFor(clock, until, async () => {
    const detail = await tape.peek('GET', run)
    guard.observe(detail.body)
    const now = text(field(detail.body, 'run', 'status'))
    return now !== undefined && TERMINAL.includes(now) ? now : undefined
  })
  if (status === undefined) {
    await tape.call('POST', `${run}/cancel`)
    return { records: 'possibly-synthetic', why: `the run of ${name} had not ended within ${seconds} seconds of its launch, so it was cancelled` }
  }
  await tape.call('GET', run)
  if (status !== 'completed') return { records: 'possibly-synthetic', why: `the run of ${name} ended ${status}` }
  const found = await pollFor(clock, until, async () => {
    const answer = await tape.peek('GET', `/api/metrics?since=365d&codebaseId=${segment(project.id)}`)
    const names = list(field(answer.body, 'metrics')).map((entry) => text(field(entry, 'name')))
    return SYNTHETIC_METRIC_NAMES.every((wanted) => names.includes(wanted)) ? true : undefined
  })
  if (found === undefined) return { records: 'possibly-synthetic', why: `Archon did not report the records of ${name} for the project within ${seconds} seconds of its launch` }
  tape.note('records-found', { names: SYNTHETIC_METRIC_NAMES })
  return { records: 'synthetic' }
}

async function recordMetrics(session: Session, context: SpendContext, clock: Clock): Promise<SpendOutcome> {
  const tape = session.tape()
  // It spends nothing, so its token ceiling is 0, and like every scenario it has a wall clock.
  const guard = createCeilingGuard({ tokenCeiling: 0, wallClockMs: SPEND_SCENARIOS.metrics.wallClockMs, now: clock.now })
  const project = await registerProject(tape, context.projectFolder)
  const synthetic = await runSyntheticPack(tape, project, guard, clock)
  tape.note('synthetic-data', synthetic.records === 'synthetic' ? { records: synthetic.records, label: SYNTHETIC_LABEL } : { records: synthetic.records, why: synthetic.why })
  const paths = [
    '/api/metric-views',
    `/api/metric-views?codebaseId=${segment(project.id)}`,
    '/api/metrics',
    '/api/metrics?since=7d',
    '/api/metrics?since=365d',
    `/api/metrics?since=365d&codebaseId=${segment(project.id)}`
  ]
  for (const path of paths) {
    const started = tape.at()
    const answer = await tape.call('GET', path)
    tape.note('query-took', { path, ms: tape.at() - started })
    guard.observe(answer.body)
    const crossed = guard.check()
    if (crossed !== null) {
      tape.note('ceiling-crossed', { ...crossed })
      session.save('metrics', 'the metrics reports read before a ceiling was crossed', tape)
      throw new StopTheRelease(`The metrics scenario crossed its ${crossed.by} ceiling.`, { tokensSeen: guard.tokens(), crossed, synthetic })
    }
  }
  const read = 'GET /api/metric-views and /api/metrics over the default window, 7 days and 365 days, and for the project, with the time each query took'
  if (synthetic.records === 'synthetic') {
    session.missing('a metrics report after a real pack that emits metrics has run', `${METRICS_PACK_GAP}, so the records come from the recorder's synthetic pack instead`)
    session.save('metrics', `${SYNTHETIC_LABEL}. ${read}, after the synthetic pack ran`, tape)
  } else if (synthetic.records === 'possibly-synthetic') {
    const possibly = possiblySyntheticDescription(synthetic.why)
    session.missing('a metrics report after a pack that emits metrics has run', `${METRICS_PACK_GAP}, and ${possibly}: the reports may hold them`)
    session.save('metrics', `POSSIBLY SYNTHETIC: ${possibly}. ${read}, after the synthetic pack was launched`, tape)
  } else {
    const empty = emptyStoreDescription(synthetic.why)
    session.missing('a metrics report after a pack that emits metrics has run', `${METRICS_PACK_GAP}, and ${empty}`)
    session.save('metrics', `${read}: ${empty}`, tape)
  }
  return { tokensSeen: 0, crossed: null, synthetic }
}

/** Records one scenario. A scenario whose ceiling Archon could not enforce throws `StopTheRelease`. */
export async function recordSpendScenario(session: Session, name: SpendScenarioName, context: SpendContext): Promise<SpendOutcome> {
  const clock: Clock = { now: context.now ?? (() => performance.now()), sleep: context.sleep ?? wait }
  if (name === 'agent-step') return recordAgentStep(session, context, clock)
  if (name === 'chat-turn') return recordChatTurn(session, context, clock)
  return recordMetrics(session, context, clock)
}
