// The spend-mode scenarios, against a stand-in release and a clock the test moves: each sends
// only its own requests, launches nothing but what it names, and is cancelled at its ceilings.
import { assert, describe, test } from 'orca/testing'
import type { Frame } from './frames.ts'
import type { Answer, LoopbackClient } from './http.ts'
import { createSession, type Session } from './session.ts'
import { recordSpendScenario, type SpendOutcome } from './spend-scenarios.ts'
import type { SpendScenarioName } from './spend.ts'
import { AGENT_STEP_PROMPT, CHAT_TURN_MESSAGE } from './workflows.ts'

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
}

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
        const now = status()
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
      if (route === 'GET /api/metric-views' || route === 'GET /api/metrics') return json({ views: [], groups: [] })
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
  test('reads the reports and the views, with the time each took, and launches and sends nothing', async () => {
    const { sent, session, outcome } = await run('metrics', {}, 0)
    assert.deepEqual(launches(sent), [])
    assert.deepEqual(messages(sent), [])
    for (const path of ['GET /api/metric-views', 'GET /api/metrics', 'GET /api/metrics?since=365d']) assert.ok(sent.includes(path), path)
    assert.deepEqual(outcome, { tokensSeen: 0, crossed: null })
    const [file] = session.files
    assert.equal(file?.path, 'metrics.json')
    assert.ok(file.text.includes('query-took'))
    assert.ok(session.gaps.some((gap) => /archon-metrics-prs/.test(gap.why) && /GitHub/.test(gap.why)))
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
