// The spend-mode scenarios, against a stand-in release and a clock the test moves: each sends
// only its own requests, launches nothing but what it names, and is cancelled at its ceilings.
import { assert, describe, test } from 'orca/testing'
import type { Frame } from './frames.ts'
import type { Answer, LoopbackClient } from './http.ts'
import { createSession, type Session } from './session.ts'
import { recordSpendScenario, type SpendOutcome } from './spend-scenarios.ts'
import type { SpendScenarioName } from './spend.ts'
import { AGENT_STEP_PROMPT, CHAT_TURN_MESSAGE, SYNTHETIC_METRIC_RECORDS } from './workflows.ts'

const json = (body: unknown, status = 200): Answer => ({ status, contentType: 'application/json', body })

interface StandIn {
  /** The model the release reports for the small tier. */
  smallModel?: string
  /** How many polls of the run it takes to end. Never ends when left out. */
  pollsToEnd?: number
  /** The workflow a chat turn starts. */
  chatStarts?: string
  /** The tokens the run reports once it has ended, or at once when it never ends. */
  tokens?: number
  /** Where the release reads the synthetic metrics pack from, or 'none' when it does not have it. Project when left out. */
  syntheticSource?: 'project' | 'bundled' | 'none'
  /** How the synthetic run ends once it has ended. Completed when left out. */
  syntheticEnds?: 'completed' | 'failed'
}

/** The names the synthetic pack's records carry, once each. */
const SYNTHETIC_NAMES = [...new Set(SYNTHETIC_METRIC_RECORDS.map((record) => String(record.name)))]

/** Archon's own reading of the synthetic pack: one shell step. */
const SYNTHETIC_AS_READ = { nodes: [{ id: 'emit', kind: 'exec', runtime: 'sh', script: 'echo' }] }

const AGENT_STEP_AS_READ = {
  source: 'project',
  workflow: {
    nodes: [{ id: 'list', kind: 'agent', model: 'small', allowed_tools: ['Glob'], source: { kind: 'inline', prompt: AGENT_STEP_PROMPT } }]
  }
}

/** A release that knows one project, one conversation and one run. It keeps every request it was sent. */
function standInRelease(options: StandIn): { client: LoopbackClient; sent: string[] } {
  const sent: string[] = []
  let workflow: string | null = null
  let polls = 0
  const streams: ((frame: Frame) => void)[] = []
  const status = (): string => (options.pollsToEnd !== undefined && polls >= options.pollsToEnd ? 'completed' : 'running')
  const lock = (locked: boolean): void => {
    for (const onFrame of streams) onFrame({ raw: '', data: { type: 'conversation_lock', locked } })
  }
  const spend = () => (options.tokens === undefined ? {} : { execution: { spend: { tokens: { source: 'provider', value: { input: options.tokens, output: 0 } } } } })
  const client: LoopbackClient = {
    port: 41000,
    async request(method, path, body) {
      const route = `${method} ${path.split('?')[0] ?? path}`
      sent.push(`${route}${path.includes('?') ? `?${path.split('?')[1] ?? ''}` : ''}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`)
      if (route === 'GET /api/config') {
        return json({ config: { assistants: { claude: { model: 'haiku' } }, tiers: { small: { provider: 'claude', model: options.smallModel ?? 'haiku' } } } })
      }
      if (route === 'POST /api/codebases') return json({ id: 'project-1', default_cwd: '/tmp/throwaway/project' }, 201)
      if (route === 'POST /api/conversations') return json({ id: 'conversation-1', conversationId: 'web-1' })
      if (route === 'GET /api/workflows/orchon-recorder-agent-step') return json(AGENT_STEP_AS_READ)
      if (route === 'GET /api/workflows/orchon-recorder-synthetic-metrics') {
        const source = options.syntheticSource ?? 'project'
        return source === 'none' ? json({ error: 'Workflow not found' }, 404) : json({ source, workflow: SYNTHETIC_AS_READ })
      }
      if (route === 'POST /api/workflows/orchon-recorder-synthetic-metrics/run') {
        workflow = 'orchon-recorder-synthetic-metrics'
        return json({ accepted: true, status: 'started' })
      }
      if (route === 'POST /api/workflows/orchon-recorder-agent-step/run') {
        workflow = 'orchon-recorder-agent-step'
        return json({ accepted: true, status: 'started' })
      }
      if (route === 'POST /api/conversations/web-1/message') {
        lock(true)
        workflow = options.chatStarts ?? null
        if (workflow === null) lock(false)
        return json({ accepted: true, status: 'processing' })
      }
      if (route === 'GET /api/dashboard/runs') {
        return json({ runs: workflow === null ? [] : [{ id: 'run-1', parent_platform_id: 'web-1', workflow_name: workflow, status: status() }] })
      }
      if (route === 'GET /api/workflows/runs/run-1') {
        polls += 1
        const now = workflow === 'orchon-recorder-synthetic-metrics' && status() === 'completed' ? (options.syntheticEnds ?? 'completed') : status()
        if (now !== 'running') lock(false)
        return json({ run: { id: 'run-1', workflow_name: workflow, status: now, metadata: now === 'running' && options.pollsToEnd !== undefined ? {} : spend() } })
      }
      if (route === 'GET /api/workflows/runs/run-1/provider-events') {
        return json({ events: [{ attemptId: 'attempt-1', seq: 0, event: { type: 'tool_call', toolCallId: 'call-1' } }, { attemptId: 'attempt-1', seq: 1, event: { type: 'agent_message_chunk', text: 'Done.' } }] })
      }
      if (route === 'POST /api/workflows/runs/run-1/cancel') {
        options.pollsToEnd = 0
        return json({ success: true })
      }
      if (route === 'GET /api/conversations/web-1' || route === 'GET /api/conversations/web-1/messages') return json({ messages: [] })
      if (route === 'GET /api/metric-views') return json({ packs: [], errors: [] })
      if (route === 'GET /api/metrics') {
        // The records are there once the synthetic run has completed.
        const recorded = workflow === 'orchon-recorder-synthetic-metrics' && status() === 'completed' && options.syntheticEnds !== 'failed'
        return json({ window: {}, metrics: recorded ? SYNTHETIC_NAMES.map((name) => ({ name, instruments: [] })) : [], refused: [] })
      }
      return json({ error: 'Not found' }, 404)
    },
    async openStream(path, onFrame) {
      if (path.includes('web-1')) streams.push(onFrame)
      let end: () => void = () => undefined
      const ended = new Promise<{ by: 'recorder' }>((resolve) => {
        end = () => resolve({ by: 'recorder' })
      })
      return { status: 200, contentType: 'text/event-stream', ended, close: async () => end() }
    }
  }
  return { client, sent }
}

async function run(name: SpendScenarioName, options: StandIn, tokenCeiling = 150_000): Promise<{ session: Session; sent: string[]; outcome: SpendOutcome }> {
  const { client, sent } = standInRelease(options)
  let time = 0
  const session = createSession('0.14.0', client, () => time)
  const outcome = await recordSpendScenario(session, name, {
    projectFolder: '/tmp/throwaway/project',
    tokenCeiling,
    now: () => time,
    sleep: async (ms) => {
      time += ms
    }
  })
  return { session, sent, outcome }
}

const launches = (sent: readonly string[]): string[] => sent.filter((request) => /^POST \/api\/workflows\/[^/ ]+\/run/.test(request))
const messages = (sent: readonly string[]): string[] => sent.filter((request) => /^POST \/api\/conversations\/[^/]+\/message/.test(request))
const cancels = (sent: readonly string[]): string[] => sent.filter((request) => request.startsWith('POST /api/workflows/runs/run-1/cancel'))

describe('the agent-step scenario', () => {
  test('launches only its own agent step, sends no chat message, and records the provider events with a cursor', async () => {
    const { session, sent, outcome } = await run('agent-step', { pollsToEnd: 3, tokens: 45_000 })
    assert.deepEqual(launches(sent).map((request) => request.split(' ')[1]), ['/api/workflows/orchon-recorder-agent-step/run'])
    assert.deepEqual(messages(sent), [])
    assert.deepEqual(cancels(sent), [])
    assert.ok(sent.includes('GET /api/workflows/runs/run-1/provider-events?step=list&attemptId=attempt-1&afterSeq=0'))
    assert.deepEqual(outcome, { tokensSeen: 45_000, crossed: null })
    assert.deepEqual(session.files.map((file) => file.path), ['agent-step.json'])
  })

  test('is cancelled through the run when it outlives its wall-clock ceiling', async () => {
    const { sent, outcome, session } = await run('agent-step', {})
    assert.equal(cancels(sent).length, 1)
    assert.equal(outcome.crossed?.by, 'time')
    // What was recorded up to the cancel is kept, and the log says why it ended.
    assert.ok(session.files.some((file) => file.path === 'agent-step.json' && file.text.includes('ceiling-crossed')))
  })

  test('is cancelled through the run when the tokens it reports cross the ceiling it was given', async () => {
    const { sent, outcome } = await run('agent-step', { tokens: 20_000 }, 10_000)
    assert.equal(cancels(sent).length, 1)
    assert.deepEqual(outcome.crossed, { by: 'tokens', seen: 20_000, ceiling: 10_000 })
  })

  test('spends nothing when the release does not run the small tier on Haiku', async () => {
    const { sent, session } = await run('agent-step', { smallModel: 'opus', pollsToEnd: 1 })
    assert.deepEqual(launches(sent), [])
    assert.ok(session.gaps.some((gap) => /haiku/i.test(gap.why)))
  })
})

describe('the chat-turn scenario', () => {
  test("sends one chat message, the fixed one, and launches nothing itself", async () => {
    const { sent, session, outcome } = await run('chat-turn', { chatStarts: 'orchon-recorder-echo', pollsToEnd: 2 }, 100_000)
    assert.deepEqual(messages(sent), [`POST /api/conversations/web-1/message ${JSON.stringify({ message: CHAT_TURN_MESSAGE })}`])
    assert.deepEqual(launches(sent), [])
    assert.deepEqual(cancels(sent), [])
    assert.equal(outcome.crossed, null)
    assert.deepEqual(session.files.map((file) => file.path), ['chat-turn.json'])
    assert.ok(sent.includes('GET /api/conversations/web-1/messages?limit=50'))
  })

  test('cancels at once a run of any workflow but the recorder shell-step one', async () => {
    const { sent, session } = await run('chat-turn', { chatStarts: 'archon-metrics-test-value-judge', pollsToEnd: 50 }, 100_000)
    assert.equal(cancels(sent).length, 1)
    assert.ok(session.files.some((file) => file.text.includes('unexpected-workflow')))
  })

  test('when it outlives its wall-clock ceiling, it cancels its run and asks for the release to be stopped', async () => {
    await assert.rejects(run('chat-turn', { chatStarts: 'orchon-recorder-echo', pollsToEnd: 100_000 }, 100_000), /release is stopped/)
  })
})

describe('the metrics scenario', () => {
  /** The requests that matter to the order, without their bodies. */
  const steps = (sent: readonly string[]): string[] =>
    sent
      .map((request) => request.split(' {')[0] ?? request)
      .filter((request, index, all) => index === 0 || request !== all[index - 1])
      .filter((request) => !request.startsWith('GET /api/workflows/runs/') && !request.startsWith('GET /api/dashboard/runs'))

  test('checks the synthetic pack is read from the project, runs it, waits for its records, then reads the reports with their timings', async () => {
    const { sent, session, outcome } = await run('metrics', { pollsToEnd: 3 }, 0)
    assert.deepEqual(launches(sent).map((request) => request.split(' ')[1]), ['/api/workflows/orchon-recorder-synthetic-metrics/run'])
    assert.deepEqual(messages(sent), [])
    const order = steps(sent)
    const at = (request: string): number => order.findIndex((step) => step.startsWith(request))
    const read = at('GET /api/workflows/orchon-recorder-synthetic-metrics?cwd=')
    const launched = at('POST /api/workflows/orchon-recorder-synthetic-metrics/run')
    const views = at('GET /api/metric-views')
    assert.ok(read >= 0 && read < launched, order.join('\n'))
    // Between the launch and the first view, only the wait for the records reads the metrics.
    assert.ok(launched < views, order.join('\n'))
    assert.ok(order.slice(launched + 1, views).every((step) => step.startsWith('GET /api/metrics?since=365d&codebaseId=')), order.join('\n'))
    assert.ok(sent.some((request) => request.startsWith('GET /api/workflows/runs/run-1')))
    for (const path of ['GET /api/metric-views', 'GET /api/metrics', 'GET /api/metrics?since=7d', 'GET /api/metrics?since=365d']) assert.ok(order.slice(views).includes(path), path)
    assert.deepEqual(outcome, { tokensSeen: 0, crossed: null, synthetic: { ran: true } })
    const [file] = session.files
    assert.equal(file?.path, 'metrics.json')
    assert.ok(file.text.includes('query-took'))
  })

  test('labels what it recorded synthetic, in the fixture, its log entry and its gap', async () => {
    const { session } = await run('metrics', { pollsToEnd: 1 }, 0)
    const [file] = session.files
    assert.match(file?.holds ?? '', /^SYNTHETIC: /)
    assert.match(file?.holds ?? '', /orchon-synthetic/)
    const log = (JSON.parse(file?.text ?? '{}') as { log: { kind: string; synthetic?: unknown }[] }).log
    assert.deepEqual(log.filter((entry) => entry.kind === 'synthetic-data').map((entry) => entry.synthetic), [true])
    // The note comes before the first report is read.
    const noted = log.findIndex((entry) => entry.kind === 'synthetic-data')
    const firstRead = log.findIndex((entry) => entry.kind === 'query-took')
    assert.ok(noted >= 0 && noted < firstRead)
    assert.ok(session.gaps.some((gap) => /archon-metrics-prs/.test(gap.why) && /GitHub/.test(gap.why) && /synthetic pack instead/.test(gap.why)))
  })

  for (const [why, options, reason] of [
    ['the release does not have the pack', { syntheticSource: 'none' }, /does not read orchon-recorder-synthetic-metrics from the throwaway project: it answered 404/],
    ['the release reads it from elsewhere', { syntheticSource: 'bundled' }, /does not read orchon-recorder-synthetic-metrics from the throwaway project/],
    ['its run fails', { pollsToEnd: 1, syntheticEnds: 'failed' }, /ended failed/],
    ['its run never ends', {}, /had not ended within 60 seconds of its launch, so it was cancelled/]
  ] as const) {
    test(`falls back to the empty-store reports, saying why, when ${why}`, async () => {
      const { sent, session, outcome } = await run('metrics', options, 0)
      assert.equal(outcome.synthetic?.ran, false)
      assert.match(outcome.synthetic?.ran === false ? outcome.synthetic.why : '', reason)
      for (const path of ['GET /api/metric-views', 'GET /api/metrics', 'GET /api/metrics?since=7d', 'GET /api/metrics?since=365d']) assert.ok(sent.includes(path), path)
      const [file] = session.files
      assert.equal(file?.path, 'metrics.json')
      assert.ok(!/SYNTHETIC/.test(file.holds))
      assert.match(file.holds, /over an empty store: the synthetic pack did not run/)
      assert.ok(session.gaps.some((gap) => /synthetic pack did not run/.test(gap.why) && reason.test(gap.why) && /empty store/.test(gap.why)))
      const log = (JSON.parse(file.text) as { log: { kind: string; synthetic?: unknown }[] }).log
      assert.deepEqual(log.filter((entry) => entry.kind === 'synthetic-data').map((entry) => entry.synthetic), [false])
    })
  }

  test('never launches the pack when the release reads it with an agent step', async () => {
    const { client, sent } = standInRelease({})
    const agentReading: LoopbackClient = {
      ...client,
      request: async (method, path, body) =>
        path.startsWith('/api/workflows/orchon-recorder-synthetic-metrics?')
          ? json({ source: 'project', workflow: { nodes: [{ id: 'emit', kind: 'agent', prompt: 'Make up numbers.' }] } })
          : client.request(method, path, body)
    }
    let time = 0
    const session = createSession('0.14.0', agentReading, () => time)
    const outcome = await recordSpendScenario(session, 'metrics', { projectFolder: '/tmp/p', tokenCeiling: 0, now: () => time, sleep: async (ms) => void (time += ms) })
    assert.deepEqual(launches(sent), [])
    assert.equal(outcome.synthetic?.ran, false)
  })

  test('stops when its queries outlive its wall-clock ceiling', async () => {
    const { client, sent } = standInRelease({})
    // Every reading of the clock is a minute later: each query takes a minute.
    let time = 0
    const now = (): number => (time += 60_000)
    const session = createSession('0.14.0', client, now)
    await assert.rejects(recordSpendScenario(session, 'metrics', { projectFolder: '/tmp/throwaway/project', tokenCeiling: 0, now }), /time ceiling/)
    assert.ok(!sent.includes('GET /api/metrics?since=365d'))
  })
})
