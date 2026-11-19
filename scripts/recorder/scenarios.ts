// What is recorded from a release, in order. Every request goes through a tape, and every
// launch through `launch`, which refuses anything but the recorder's own workflows.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isSameOrInside } from './home.ts'
import type { Answer } from './http.ts'
import { field, text } from '../shape.ts'
import type { StreamReader, Tape } from './recording.ts'
import type { Session } from './session.ts'
import { sleep } from './wait.ts'
import { assertLaunchable, assertReadWithoutAgent, RECORDER_WORKFLOWS, type WorkflowDefinition } from './workflows.ts'

export interface RecordingContext {
  /** The throwaway project's folder. */
  projectFolder: string
  /** The throwaway Archon home, read for `server.json`. */
  archonHome: string
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** An id as one path segment. */
const segment = (id: string): string => encodeURIComponent(id)

const TERMINAL: readonly string[] = ['completed', 'failed', 'cancelled']

/** Runs one scenario and answers what it answers. A scenario that fails is noted as a gap and answers null. */
async function recordOrNull<T>(session: Session, what: string, scenario: () => Promise<T | null>): Promise<T | null> {
  try {
    return await scenario()
  } catch (error) {
    session.missing(what, error instanceof Error ? error.message : String(error))
    return null
  }
}

/** Runs one scenario. A scenario that fails is noted as a gap and the next one still runs. */
async function attempt(session: Session, what: string, scenario: () => Promise<void>): Promise<void> {
  await recordOrNull(session, what, async () => {
    await scenario()
    return null
  })
}

/** One request, kept as its own fixture. */
async function single(session: Session, name: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const tape = session.tape()
  const answer = await tape.call(method, path, body)
  session.save(name, `${method} ${path.split('?')[0] ?? path}`, tape)
  return answer
}

interface Project {
  id: string
  cwd: string
}

interface Conversation {
  /** The database id. */
  id: string
  /** The platform id: what the launch route and the stream route take. */
  conversationId: string
}

async function createConversation(tape: Tape, project: Project): Promise<Conversation> {
  const answer = await tape.call('POST', '/api/conversations', { codebaseId: project.id })
  const id = text(field(answer.body, 'id'))
  const conversationId = text(field(answer.body, 'conversationId'))
  if (id === undefined || conversationId === undefined) {
    throw new Error(`No conversation was created: ${answer.status} ${JSON.stringify(answer.body)}`)
  }
  return { id, conversationId }
}

/**
 * The one place a launch is sent. It refuses any workflow that is not the recorder's own and
 * read from the throwaway project, and checks Archon's own reading of it for an agent first.
 */
async function launch(tape: Tape, project: Project, workflow: WorkflowDefinition, body: Record<string, unknown>): Promise<Answer> {
  assertLaunchable(workflow.name)
  const loaded = await tape.peek('GET', `/api/workflows/${segment(workflow.name)}?cwd=${encodeURIComponent(project.cwd)}`)
  if (field(loaded.body, 'source') !== 'project') throw new Error(`${workflow.name} is not read from the throwaway project.`)
  assertReadWithoutAgent(field(loaded.body, 'workflow'))
  tape.note('launch-sent', { workflow: workflow.name })
  const answer = await tape.call('POST', `/api/workflows/${segment(workflow.name)}/run`, body)
  tape.note('launch-answered', { status: answer.status })
  return answer
}

async function runsOf(tape: Tape, project: Project): Promise<unknown[]> {
  const answer = await tape.peek('GET', `/api/dashboard/runs?codebaseId=${segment(project.id)}&limit=50`)
  return list(field(answer.body, 'runs'))
}

const belongsTo = (run: unknown, conversation: Conversation): boolean =>
  field(run, 'parent_conversation_id') === conversation.id || field(run, 'parent_platform_id') === conversation.conversationId

/**
 * Calls `probe` every `everyMs` until it answers something other than undefined, and answers
 * that. Answers undefined when `forMs` has passed on `now` first.
 */
async function pollUntil<T>(now: () => number, forMs: number, everyMs: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
  const until = now() + forMs
  while (now() < until) {
    const found = await probe()
    if (found !== undefined) return found
    await sleep(everyMs)
  }
  return undefined
}

/** Polls the project's runs until one belongs to the conversation, or the time is up. */
async function waitForRun(tape: Tape, project: Project, conversation: Conversation, forMs: number): Promise<string | null> {
  let polls = 0
  const id = await pollUntil(tape.at, forMs, 200, async () => {
    const pollSentMs = tape.at()
    const run = (await runsOf(tape, project)).find((row) => belongsTo(row, conversation))
    polls += 1
    const found = text(field(run, 'id'))
    if (found !== undefined) tape.note('run-found', { pollSentMs, polls, run })
    return found
  })
  if (id === undefined) tape.note('run-not-found', { polls, waitedMs: forMs })
  return id ?? null
}

async function statusOf(tape: Tape, runId: string): Promise<string | undefined> {
  const answer = await tape.peek('GET', `/api/workflows/runs/${segment(runId)}`)
  return text(field(answer.body, 'run', 'status'))
}

/** Polls a run until its status is one of `statuses`, noting each change. Answers the last status seen. */
async function waitForStatus(tape: Tape, runId: string, statuses: readonly string[], forMs: number): Promise<string | undefined> {
  let last: string | undefined
  const reached = await pollUntil(tape.at, forMs, 250, async () => {
    const status = await statusOf(tape, runId)
    if (status !== last) {
      tape.note('run-status', { status: status ?? null, was: last ?? null })
      last = status
    }
    return status !== undefined && statuses.includes(status) ? status : undefined
  })
  if (reached !== undefined) return reached
  tape.note('run-status-timeout', { waitedFor: statuses, waitedMs: forMs })
  return last
}

/** The run's row in the attention queue, once it is there. */
async function waitForAttention(tape: Tape, runId: string, forMs: number): Promise<unknown> {
  const row = await pollUntil(tape.at, forMs, 250, async () =>
    (await attentionRows(tape)).find((run) => field(run, 'id') === runId && field(run, 'attention') != null)
  )
  if (row === undefined) throw new Error('The run never reached the attention queue.')
  return row
}

/** Every row of the attention queue, including the ones it would not show. */
async function attentionRows(tape: Tape): Promise<unknown[]> {
  const answer = await tape.peek('GET', '/api/runs/attention?all=true')
  return list(field(answer.body, 'runs'))
}

async function waitFor(test: () => boolean, forMs: number): Promise<boolean> {
  const passed = await pollUntil(() => performance.now(), forMs, 50, async () => (test() ? true : undefined))
  return passed ?? test()
}

const sawUnlock = (reader: StreamReader): boolean =>
  reader.frames.some((frame) => field(frame.data, 'type') === 'conversation_lock' && field(frame.data, 'locked') === false)

async function readBack(tape: Tape, conversation: Conversation): Promise<void> {
  await tape.call('GET', `/api/conversations/${segment(conversation.conversationId)}`)
  await tape.call('GET', `/api/conversations/${segment(conversation.conversationId)}/messages?limit=50`)
}

// ---------------------------------------------------------------------------------------------
// Answers that cost nothing: reads, and writes to the throwaway home's own config.
// ---------------------------------------------------------------------------------------------

async function recordServerFile(session: Session, context: RecordingContext): Promise<void> {
  const file = join(context.archonHome, 'server.json')
  if (!existsSync(file)) {
    session.missing('server.json', 'this release wrote no server.json into its Archon home')
    return
  }
  session.saveText('server.json', "the release's own server.json, from its Archon home", readFileSync(file, 'utf8'))
}

async function recordEmpty(session: Session): Promise<void> {
  await single(session, 'codebases-empty', 'GET', '/api/codebases')
  const runs = session.tape()
  await runs.call('GET', '/api/dashboard/runs?limit=50&offset=0')
  await runs.call('GET', '/api/dashboard/runs?limit=1')
  session.save('dashboard-runs-empty', 'GET /api/dashboard/runs, before any run', runs)
  await single(session, 'attention-empty', 'GET', '/api/runs/attention')
  await single(session, 'conversations-empty', 'GET', '/api/conversations?platform=web')
}

async function registerProject(session: Session, context: RecordingContext): Promise<Project> {
  const tape = session.tape()
  const made = await tape.call('POST', '/api/codebases', { path: context.projectFolder })
  const id = text(field(made.body, 'id'))
  const cwd = text(field(made.body, 'default_cwd'))
  if (id === undefined || cwd === undefined) throw new Error(`The throwaway project was not registered: ${made.status}.`)
  await tape.call('GET', '/api/codebases')
  await tape.call('GET', `/api/codebases/${segment(id)}`)
  session.save('codebases', 'POST /api/codebases for the throwaway project, then the list and the one project', tape)
  return { id, cwd }
}

/** A bundled workflow and the name of the file the release keeps it in. */
interface BundledWorkflow {
  name: string
  filename: string | undefined
}

async function recordWorkflows(session: Session, project: Project): Promise<BundledWorkflow[]> {
  const cwd = encodeURIComponent(project.cwd)
  const listed = await single(session, 'workflows', 'GET', `/api/workflows?cwd=${cwd}`)
  const bundled: BundledWorkflow[] = []
  for (const entry of list(field(listed.body, 'workflows'))) {
    const name = text(field(entry, 'workflow', 'name'))
    if (name === undefined || field(entry, 'source') !== 'bundled') continue
    await attempt(session, `the load answer of ${name}`, async () => {
      const tape = session.tape()
      const loaded = await tape.call('GET', `/api/workflows/${segment(name)}?cwd=${cwd}`)
      session.save(`workflows/${name}`, `GET /api/workflows/${name}`, tape)
      bundled.push({ name, filename: text(field(loaded.body, 'filename')) })
    })
  }
  return bundled
}

/**
 * The YAML of every bundled workflow, as the release holds it. The API does not serve the file,
 * but a run keeps a copy of the workflow files it was started with inside the Archon home, and
 * that copy holds the bundled ones. Each is read from the copy of the accepted run.
 */
function recordBundledYaml(session: Session, context: RecordingContext, bundled: readonly BundledWorkflow[], run: unknown): void {
  const captured = text(field(run, 'metadata', 'workflow_source', 'root'))
  if (captured === undefined || !isSameOrInside(captured, context.archonHome) || !existsSync(join(captured, 'bundled'))) {
    session.missing('the YAML of the bundled workflows', "the run kept no copy of the bundled workflow files inside the throwaway Archon home")
    return
  }
  const files = (readdirSync(join(captured, 'bundled'), { recursive: true }) as string[]).filter((file) => /\.ya?ml$/.test(file))
  for (const workflow of bundled) {
    const matches = files.filter((file) => basename(file) === workflow.filename)
    const [file] = matches
    if (file === undefined || matches.length !== 1) {
      session.missing(`workflows/${workflow.name}.yaml`, `the run's copy holds ${matches.length} files named ${workflow.filename ?? 'nothing'}`)
      continue
    }
    session.saveText(`workflows/${workflow.name}.yaml`, `the YAML of ${workflow.name} as the release holds it`, readFileSync(join(captured, 'bundled', file), 'utf8'))
  }
}

async function recordValidate(session: Session): Promise<void> {
  const tape = session.tape()
  await tape.call('POST', '/api/workflows/validate', { definition: RECORDER_WORKFLOWS.gate })
  await tape.call('POST', '/api/workflows/validate', {
    definition: { name: 'orchon-recorder-invalid', description: 'Depends on a step that does not exist.', nodes: [{ id: 'a', bash: 'true', depends_on: ['missing'] }] }
  })
  await tape.call('POST', '/api/workflows/validate', {})
  session.save('validate', 'POST /api/workflows/validate: a valid definition, an invalid one and a malformed request', tape)
}

async function recordAuth(session: Session, paths: unknown): Promise<void> {
  const tape = session.tape()
  for (const [path, methods] of Object.entries((paths as Record<string, unknown> | undefined) ?? {})) {
    if (path.startsWith('/api/auth/') && !path.includes('{') && field(methods, 'get') !== undefined) await tape.call('GET', path)
  }
  session.save('auth', 'every /api/auth/* path that the path list gives a GET and no parameter', tape)
}

async function recordMissing(session: Session): Promise<void> {
  await single(session, 'missing-path', 'GET', '/api/orchon-recorder-missing')
  const metrics = session.tape()
  await metrics.call('GET', '/api/metric-views')
  await metrics.call('GET', '/api/metrics')
  session.save('metrics', 'GET /api/metric-views and /api/metrics, which a release before 0.14.0 answers with its HTML page', metrics)
}

async function recordConfigWrites(session: Session): Promise<void> {
  const providers = await session.client.request('GET', '/api/providers')
  const ids = list(field(providers.body, 'providers')).map((provider) => text(field(provider, 'id')))
  const provider = ids.includes('claude') ? 'claude' : (ids[0] ?? 'claude')
  const entry = { provider, model: 'orchon-recorded-model' }

  const assistants = session.tape()
  await assistants.call('PATCH', '/api/config/assistants', { assistants: { [provider]: { model: 'orchon-recorded-model' } } })
  await assistants.call('GET', '/api/config')
  await assistants.call('PATCH', '/api/config/assistants', { assistant: 'orchon-recorder-no-such-provider' })
  await assistants.call('PATCH', '/api/config/assistants', { assistant: '' })
  session.save('config-assistants', 'PATCH /api/config/assistants: a merge, the config after it, and two refused requests', assistants)
  session.missing(
    'a null removal on PATCH /api/config/assistants',
    "the release's UpdateAssistantConfigBody in openapi.json takes an object for each assistant and never null, so there is no removal to record; the tiers and aliases routes record theirs"
  )

  const tiers = session.tape()
  await tiers.call('PATCH', '/api/config/tiers', { tiers: { small: entry } })
  await tiers.call('GET', '/api/config')
  await tiers.call('PATCH', '/api/config/tiers', { tiers: { small: null } })
  await tiers.call('GET', '/api/config')
  await tiers.call('PATCH', '/api/config/tiers', {})
  await tiers.call('PATCH', '/api/config/tiers', { tiers: { small: { provider: 'orchon-recorder-no-such-provider', model: 'x' } } })
  session.save('config-tiers', 'PATCH /api/config/tiers: a merge, a null removal, the config after each, and two refused requests', tiers)

  const aliases = session.tape()
  await aliases.call('PATCH', '/api/config/aliases', { aliases: { '@orchon-recorded': entry } })
  await aliases.call('GET', '/api/config')
  await aliases.call('PATCH', '/api/config/aliases', { aliases: { '@orchon-recorded': null } })
  await aliases.call('GET', '/api/config')
  await aliases.call('PATCH', '/api/config/aliases', {})
  await aliases.call('PATCH', '/api/config/aliases', { aliases: { 'no-at-sign': entry } })
  session.save('config-aliases', 'PATCH /api/config/aliases: a merge, a null removal, the config after each, and two refused requests', aliases)
}

// ---------------------------------------------------------------------------------------------
// Launches of the recorder's own workflows, which have no agent.
// ---------------------------------------------------------------------------------------------

/** The run an accepted launch started, and the conversation it was launched from. */
interface AcceptedRun {
  runId: string
  conversation: Conversation
}

/** A launch that starts a run, with the dashboard stream and the conversation's stream open from before it. */
async function recordAcceptedLaunch(session: Session, project: Project): Promise<AcceptedRun | null> {
  const tape = session.tape()
  const conversation = await createConversation(tape, project)
  const dashboard = await tape.stream('dashboard', '/api/stream/__dashboard__')
  const first = await tape.stream('first', `/api/stream/${segment(conversation.conversationId)}`)
  await sleep(500)
  await launch(tape, project, RECORDER_WORKFLOWS.echo, {
    conversationId: conversation.conversationId,
    message: 'Recording a launch for Orchon: one shell step.'
  })
  const runId = await waitForRun(tape, project, conversation, 60_000)
  if (runId !== null) await waitForStatus(tape, runId, TERMINAL, 120_000)
  tape.note('lock-released-seen', { seen: await waitFor(() => sawUnlock(first), 20_000) })
  await sleep(3000)
  await readBack(tape, conversation)
  // One reader per conversation: a second reader ends the first reader's stream.
  const second = await tape.stream('second', `/api/stream/${segment(conversation.conversationId)}`)
  tape.note('first-reader-ended-after-second-opened', { ended: await waitFor(() => first.hasEnded(), 5000) })
  await sleep(1000)
  await second.close()
  await first.close()
  await dashboard.close()
  // The title is written by a small-model call that outlives the launch.
  await sleep(15_000)
  await tape.call('GET', `/api/conversations/${segment(conversation.conversationId)}`)
  session.save('launch-accepted', 'a launch that starts a run: every request, answer and stream frame, in order', tape)
  return runId === null ? null : { runId, conversation }
}

/** A launch with an input name the workflow may not declare, the stream open from before it. */
async function recordUndeclaredInput(session: Session, project: Project, name: string, workflow: WorkflowDefinition, holds: string): Promise<void> {
  const tape = session.tape()
  const conversation = await createConversation(tape, project)
  const first = await tape.stream('first', `/api/stream/${segment(conversation.conversationId)}`)
  await sleep(500)
  await launch(tape, project, workflow, {
    conversationId: conversation.conversationId,
    message: 'Recording a launch for Orchon: an input the workflow may not declare.',
    inputs: { not_declared: 'x', ...(workflow.inputs === undefined ? {} : { item: 'recorded' }) }
  })
  const runId = await waitForRun(tape, project, conversation, 10_000)
  if (runId !== null) await waitForStatus(tape, runId, TERMINAL, 120_000)
  tape.note('lock-released-seen', { seen: await waitFor(() => sawUnlock(first), 10_000) })
  await sleep(1000)
  await readBack(tape, conversation)
  await first.close()
  session.save(name, holds, tape)
}

/** A launch that leaves out a required input, the stream opened three seconds late. */
async function recordMissingRequired(session: Session, project: Project): Promise<void> {
  const tape = session.tape()
  const conversation = await createConversation(tape, project)
  await launch(tape, project, RECORDER_WORKFLOWS.inputs, {
    conversationId: conversation.conversationId,
    message: 'Recording a refused launch for Orchon: a required input left out.'
  })
  await sleep(3000)
  // Opened only now: anything that arrives was held back for a late reader.
  const late = await tape.stream('late', `/api/stream/${segment(conversation.conversationId)}`)
  const runId = await waitForRun(tape, project, conversation, 7000)
  if (runId !== null) await waitForStatus(tape, runId, TERMINAL, 120_000)
  await sleep(2000)
  await readBack(tape, conversation)
  await late.close()
  session.save('launch-missing-required', 'a launch refused after a 200: a required input left out, the stream opened late', tape)
}

/** A launch with an empty message, which is refused with a 400, and the delete of its conversation. */
async function recordEmptyMessage(session: Session, project: Project): Promise<void> {
  const tape = session.tape()
  const conversation = await createConversation(tape, project)
  const first = await tape.stream('first', `/api/stream/${segment(conversation.conversationId)}`)
  await sleep(500)
  await launch(tape, project, RECORDER_WORKFLOWS.echo, { conversationId: conversation.conversationId, message: '' })
  await sleep(1000)
  await tape.call('GET', `/api/conversations?platform=web&codebaseId=${segment(project.id)}`)
  await tape.call('DELETE', `/api/conversations/${segment(conversation.conversationId)}`)
  await tape.call('GET', `/api/conversations?platform=web&codebaseId=${segment(project.id)}`)
  await tape.call('GET', `/api/conversations/${segment(conversation.conversationId)}`)
  tape.note('stream-after-delete', { ended: await waitFor(() => first.hasEnded(), 2000) })
  await first.close()
  session.save('launch-empty-message', 'a launch refused with a 400, then the delete of its conversation', tape)
}

/** The reads of a finished run. Answers the run as its detail gave it. */
async function recordRunReads(session: Session, project: Project, runId: string, conversation: Conversation): Promise<unknown> {
  const detail = await single(session, 'run-detail', 'GET', `/api/workflows/runs/${segment(runId)}`)
  const worker = text(field(detail.body, 'run', 'worker_platform_id'))
  if (worker === undefined) session.missing('run-by-worker', 'the run row has no worker_platform_id')
  else await single(session, 'run-by-worker', 'GET', `/api/workflows/runs/by-worker/${segment(worker)}`)
  await single(session, 'run-provider-events', 'GET', `/api/workflows/runs/${segment(runId)}/provider-events?step=write`)

  const artifacts = session.tape()
  const listed = await artifacts.call('GET', `/api/runs/${segment(runId)}/artifacts`)
  const file = list(field(listed.body, 'files'))
    .map((entry) => text(field(entry, 'path')))
    .find((path) => path?.endsWith('.md'))
  if (file === undefined) session.missing('an artifact text file', 'the run listed no Markdown artifact')
  else await artifacts.call('GET', `/api/artifacts/${segment(runId)}/${file.split('/').map(segment).join('/')}`)
  await artifacts.call('GET', `/api/artifacts/${segment(runId)}/orchon-recorder-missing.md`)
  session.save('artifacts', "a run's artifact list, one text file and a file that does not exist", artifacts)

  const runs = session.tape()
  await runs.call('GET', '/api/dashboard/runs?limit=50&offset=0')
  await runs.call('GET', '/api/dashboard/runs?limit=1')
  await runs.call('GET', `/api/dashboard/runs?codebaseId=${segment(project.id)}&limit=50&offset=0`)
  await runs.call('GET', '/api/dashboard/runs?status=completed&limit=50&offset=0')
  session.save('dashboard-runs', 'GET /api/dashboard/runs with runs: all, one, one project and one status', runs)

  const conversations = session.tape()
  await conversations.call('GET', '/api/conversations?platform=web')
  await conversations.call('GET', `/api/conversations?platform=web&codebaseId=${segment(project.id)}`)
  await readBack(conversations, conversation)
  session.save('conversations', 'the conversation list, all and for one project, then one conversation and its messages', conversations)
  return field(detail.body, 'run')
}

/** Launches a workflow and waits until its run waits for a person. Answers the run id and its attention row. */
async function launchUntilWaiting(tape: Tape, project: Project, workflow: WorkflowDefinition, message: string): Promise<{ runId: string; row: unknown }> {
  const conversation = await createConversation(tape, project)
  await launch(tape, project, workflow, { conversationId: conversation.conversationId, message })
  const runId = await waitForRun(tape, project, conversation, 60_000)
  if (runId === null) throw new Error(`No run of ${workflow.name} appeared.`)
  return { runId, row: await waitForAttention(tape, runId, 60_000) }
}

/** Reads the queue and the run while it waits: what the plugin shows for a question. */
async function recordWaiting(session: Session, name: string, holds: string, runId: string): Promise<void> {
  const tape = session.tape()
  await tape.call('GET', '/api/runs/attention')
  await tape.call('GET', `/api/runs/${segment(runId)}/attention`)
  await tape.call('GET', `/api/workflows/runs/${segment(runId)}`)
  await tape.call('GET', '/api/dashboard/runs?limit=1')
  session.save(name, holds, tape)
}

/** Waits until the run's attention row is of `kind`. */
async function waitForAttentionKind(tape: Tape, runId: string, kind: string): Promise<unknown> {
  const row = await pollUntil(tape.at, 60_000, 250, async () => {
    const found = (await attentionRows(tape)).find((run) => field(run, 'id') === runId)
    return field(found, 'attention', 'kind') === kind ? found : undefined
  })
  if (row === undefined) throw new Error(`The run never waited with attention kind ${kind}.`)
  return row
}

/** The two ids that name an open gate: the step, and the pause Archon gave it. */
function gateOf(row: unknown): { nodeId: string; pauseId: string } {
  const nodeId = text(field(row, 'metadata', 'approval', 'nodeId')) ?? text(field(row, 'attention', 'respondTo', 'nodeId'))
  const pauseId = text(field(row, 'metadata', 'approval', 'pauseId')) ?? text(field(row, 'attention', 'occurrence'))
  if (nodeId === undefined || pauseId === undefined) throw new Error('The waiting gate reported no step id or no pause id.')
  return { nodeId, pauseId }
}

/** One run through the gate and the attention wait: every refusal first, then the answer that is taken. */
async function recordGateAndWait(session: Session, project: Project): Promise<void> {
  const respond = session.tape()
  const { runId, row } = await launchUntilWaiting(respond, project, RECORDER_WORKFLOWS.gate, 'Recording a gate for Orchon: answered, then the wait answered.')
  await recordWaiting(session, 'attention-gate', 'the attention queue, the run and the dashboard count while a run waits at an approval gate', runId)
  const gate = gateOf(row)
  respond.note('gate-seen', gate)
  const run = `/api/workflows/runs/${segment(runId)}`
  await respond.call('POST', `${run}/respond`, { decision: 'approve', expectedGate: { nodeId: 'orchon-recorder-other-step', pauseId: gate.pauseId } })
  await respond.call('POST', `${run}/respond`, { decision: 'approve', expectedGate: { nodeId: gate.nodeId, pauseId: 'orchon-recorder-other-pause' } })
  await respond.call('POST', `${run}/respond`, { decision: 'approve', expectedGate: 'orchon-recorder-other-step' })
  // The string form names a gate that has no pause id. This gate has one.
  const asString = await respond.call('POST', `${run}/respond`, { decision: 'approve', expectedGate: gate.nodeId })
  if (asString.status !== 200) {
    session.missing(
      'respond accepted with a string expectedGate',
      `the gate this release paused at has a pause id, and the node id alone answered ${asString.status}; that answer is in respond.json`
    )
  } else {
    session.missing('respond with both ids', 'the node id alone was accepted first, so the gate was closed before both ids could be sent')
  }
  await respond.call('POST', `${run}/respond`, { decision: 'orchon-recorder-no-such-decision', expectedGate: gate })
  await respond.call('POST', `${run}/respond`, { expectedGate: gate })
  await respond.call('POST', `${run}/respond`, { decision: 'approve', text: 'Recorded approval.', expectedGate: gate })
  await respond.call('POST', `${run}/respond`, { decision: 'approve', expectedGate: gate })
  session.save('respond', 'POST respond on a gate: mismatches of each id, the node id alone, an unknown and a missing decision, an approval guarded by both ids, and the same approval again', respond)

  const answer = session.tape()
  const waiting = await waitForAttentionKind(answer, runId, 'attention')
  await recordWaiting(session, 'attention-wait', 'the attention queue, the run and the dashboard count while a run waits at an attention wait', runId)
  const occurrence = text(field(waiting, 'attention', 'occurrence'))
  if (occurrence === undefined) throw new Error('The attention wait reported no occurrence.')
  answer.note('wait-seen', { occurrence })
  await answer.call('POST', `${run}/answer`, { occurrence: 'orchon-recorder-other-occurrence', choose: ['first'] })
  await answer.call('POST', `${run}/answer`, { occurrence, choose: ['orchon-recorder-no-such-option'] })
  await answer.call('POST', `${run}/answer`, { occurrence })
  await answer.call('POST', `${run}/answer`, { choose: ['first'] })
  await answer.call('POST', `${run}/respond`, { decision: 'approve', expectedGate: { nodeId: 'ask', pauseId: occurrence } })
  await answer.call('POST', `${run}/answer`, { occurrence, choose: ['first'], text: 'Recorded answer.' })
  await answer.call('POST', `${run}/answer`, { occurrence, choose: ['first'] })
  await waitForStatus(answer, runId, TERMINAL, 120_000)
  await answer.call('GET', run)
  session.save('answer', 'POST answer on an attention wait: a wrong occurrence, an unknown option, no choice, no occurrence, a respond sent to the wait, the answer with its occurrence, the same answer again, and the finished run', answer)
}

/** A run that waits for a person: cancel and resume are tried, then it is abandoned. */
async function recordPausedControl(session: Session, project: Project): Promise<void> {
  const tape = session.tape()
  const { runId } = await launchUntilWaiting(tape, project, RECORDER_WORKFLOWS.gate, 'Recording run control for Orchon: a run that waits at a gate.')
  const run = `/api/workflows/runs/${segment(runId)}`
  await tape.call('POST', `${run}/cancel`)
  await tape.call('POST', `${run}/resume`)
  await tape.call('GET', run)
  await tape.call('POST', `${run}/abandon`)
  await waitForStatus(tape, runId, TERMINAL, 30_000)
  await tape.call('GET', run)
  await tape.call('POST', `${run}/abandon`)
  await tape.call('POST', `${run}/respond`, { decision: 'approve' })
  session.save('run-control-paused', 'a run that waits at a gate: cancel, resume, abandon, the run after it, abandon again and a late respond', tape)
}

/** A run with live work: it is cancelled while its one step sleeps. */
async function recordRunningControl(session: Session, project: Project): Promise<void> {
  const tape = session.tape()
  const conversation = await createConversation(tape, project)
  const dashboard = await tape.stream('dashboard', '/api/stream/__dashboard__')
  await launch(tape, project, RECORDER_WORKFLOWS.slow, {
    conversationId: conversation.conversationId,
    message: 'Recording run control for Orchon: a run that is cancelled while it works.'
  })
  const runId = await waitForRun(tape, project, conversation, 60_000)
  if (runId === null) throw new Error('No slow run appeared.')
  const run = `/api/workflows/runs/${segment(runId)}`
  await waitForStatus(tape, runId, ['running', ...TERMINAL], 60_000)
  await sleep(1500)
  await tape.call('GET', run)
  await tape.call('GET', '/api/dashboard/runs?limit=1')
  await tape.call('POST', `${run}/resume`)
  await tape.call('POST', `${run}/cancel`)
  await waitForStatus(tape, runId, TERMINAL, 60_000)
  await tape.call('GET', run)
  await tape.call('POST', `${run}/cancel`)
  await tape.call('POST', `${run}/resume`)
  await tape.call('POST', `${run}/abandon`)
  await sleep(1000)
  await dashboard.close()
  session.save('run-control-running', 'a run with live work: the run while it works, resume, cancel, the run after it, then cancel, resume and abandon on the cancelled run, with the dashboard stream throughout', tape)
}

/** A run whose one step fails: resume starts it again, and it is abandoned after it fails again. */
async function recordFailedRun(session: Session, project: Project): Promise<string | null> {
  const tape = session.tape()
  const conversation = await createConversation(tape, project)
  await launch(tape, project, RECORDER_WORKFLOWS.fail, {
    conversationId: conversation.conversationId,
    message: 'Recording a failed run for Orchon.'
  })
  const runId = await waitForRun(tape, project, conversation, 60_000)
  if (runId === null) throw new Error('No failing run appeared.')
  const run = `/api/workflows/runs/${segment(runId)}`
  await waitForStatus(tape, runId, TERMINAL, 120_000)
  await tape.call('GET', run)
  await tape.call('GET', '/api/runs/attention')
  await tape.call('GET', '/api/dashboard/runs?status=failed&limit=50&offset=0')
  await tape.call('POST', `${run}/cancel`)
  await tape.call('POST', `${run}/resume`)
  await sleep(5000)
  await waitForStatus(tape, runId, TERMINAL, 120_000)
  await tape.call('GET', run)
  await tape.call('POST', `${run}/abandon`)
  await tape.call('GET', run)
  await tape.call('POST', `${run}/abandon`)
  session.save('run-failed', 'a run whose one step fails: the run, the queue and the failed filter, then cancel, resume, the run after it, and abandon twice', tape)
  return runId
}

async function recordUnknownRun(session: Session): Promise<void> {
  const tape = session.tape()
  const run = '/api/workflows/runs/orchon-recorder-no-such-run'
  await tape.call('GET', run)
  for (const action of ['cancel', 'resume', 'abandon']) await tape.call('POST', `${run}/${action}`)
  await tape.call('POST', `${run}/respond`, { decision: 'approve' })
  await tape.call('POST', `${run}/answer`, { occurrence: 'x' })
  await tape.call('GET', '/api/runs/orchon-recorder-no-such-run/artifacts')
  session.save('run-unknown', 'every run route for a run id that does not exist', tape)
}

async function recordDeletes(session: Session, project: Project, runId: string | null): Promise<void> {
  const tape = session.tape()
  if (runId !== null) {
    await tape.call('DELETE', `/api/workflows/runs/${segment(runId)}`)
    await tape.call('GET', `/api/workflows/runs/${segment(runId)}`)
  }
  await tape.call('DELETE', `/api/codebases/${segment(project.id)}`)
  await tape.call('GET', '/api/codebases')
  session.save('deletes', 'DELETE of a run and of the throwaway project, with a read after each', tape)
}

export async function recordRelease(session: Session, context: RecordingContext): Promise<void> {
  await single(session, 'health', 'GET', '/api/health')
  const openapi = await single(session, 'openapi', 'GET', '/api/openapi.json')
  const paths = field(openapi.body, 'paths')
  await recordServerFile(session, context)
  await attempt(session, 'the empty lists', () => recordEmpty(session))
  await attempt(session, 'config', async () => void (await single(session, 'config', 'GET', '/api/config')))
  await attempt(session, 'providers', async () => void (await single(session, 'providers', 'GET', '/api/providers')))
  await attempt(session, 'update-check', async () => void (await single(session, 'update-check', 'GET', '/api/update-check')))
  await attempt(session, 'the /api/auth/* answers', () => recordAuth(session, paths))
  await attempt(session, 'a missing path and the metrics paths', () => recordMissing(session))
  await attempt(session, 'validate', () => recordValidate(session))

  const project = await registerProject(session, context)
  const bundled = (await recordOrNull(session, 'the workflow list and the bundled workflows', () => recordWorkflows(session, project))) ?? []

  const started = await recordOrNull(session, 'launch-accepted', () => recordAcceptedLaunch(session, project))
  if (started === null) {
    session.missing('the reads of a finished run', 'no accepted launch produced a run')
    session.missing('the YAML of the bundled workflows', 'no accepted launch produced a run to read them from')
  } else {
    await attempt(session, 'the reads of a finished run', async () => {
      const run = await recordRunReads(session, project, started.runId, started.conversation)
      recordBundledYaml(session, context, bundled, run)
    })
  }
  await attempt(session, 'launch-undeclared-no-inputs-block', () =>
    recordUndeclaredInput(session, project, 'launch-undeclared-no-inputs-block', RECORDER_WORKFLOWS.echo, 'a launch with an input name sent to a workflow that declares no inputs')
  )
  await attempt(session, 'launch-undeclared', () =>
    recordUndeclaredInput(session, project, 'launch-undeclared', RECORDER_WORKFLOWS.inputs, 'a launch refused after a 200: an input name the workflow does not declare')
  )
  await attempt(session, 'launch-missing-required', () => recordMissingRequired(session, project))
  await attempt(session, 'launch-empty-message', () => recordEmptyMessage(session, project))
  await attempt(session, 'the gate and the attention wait', () => recordGateAndWait(session, project))
  await attempt(session, 'run-control-paused', () => recordPausedControl(session, project))
  await attempt(session, 'run-control-running', () => recordRunningControl(session, project))
  let failed: string | null = null
  await attempt(session, 'run-failed', async () => {
    failed = await recordFailedRun(session, project)
  })
  await attempt(session, 'run-unknown', () => recordUnknownRun(session))
  await attempt(session, 'the config writes', () => recordConfigWrites(session))
  await attempt(session, 'the deletes', () => recordDeletes(session, project, failed))
}
