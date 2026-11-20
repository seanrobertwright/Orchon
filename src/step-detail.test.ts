// The worker's request protocol seam: the worker mounted on a scripted Archon, which replays the
// recorded run detail and provider-event answers. These tests cover the step view's requests:
// what the worker asks Archon, how it folds the step's provider events, and the trimmed view
// models it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, REFUSE, RELEASES, scene, type Release, type Scene, urls } from '../scripts/scripted-archon.ts'
import { STEP_EVENTS_CAP_BYTES, type ItemAnswer, type ItemRequest, type StepAnswer, type StepRequest } from './step-view'

const RUN_PATH = `${DEFAULT}/api/workflows/runs/`
const CODEBASES = `${DEFAULT}/api/codebases`

/** The spend-mode recording of 0.14.0: one agent step, `list`, on the small tier. */
const SPEND = 'spend/agent-step/agent-step'
const SPEND_RUN = 'b476c201-fe57-4f11-8b7d-0da088237808'
const SPEND_ATTEMPT = 'e71391d1-b7a7-40e1-9d82-53d4f9e0e404'
/** Where the recording holds the run, the step's events, and the events after seq 0. */
const SPEND_RUN_AT = 28
const SPEND_STEP_AT = 30
const SPEND_CURSOR_AT = 31

function connectedScene(release: Release = '0.14.0'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, json({ codebases: [] }))
  return stage
}

const eventsUrl = (runId: string, step: string, cursor?: { attemptId: string; seq: number }): string =>
  `${RUN_PATH}${runId}/provider-events?step=${encodeURIComponent(step)}${
    cursor === undefined ? '' : `&attemptId=${encodeURIComponent(cursor.attemptId)}&afterSeq=${String(cursor.seq)}`
  }`

function spendScene(): Scene {
  const stage = connectedScene('0.14.0')
  stage.archon.answer(`${RUN_PATH}${SPEND_RUN}`, recorded('0.14.0', SPEND, SPEND_RUN_AT))
  stage.archon.answer(eventsUrl(SPEND_RUN, 'list'), recorded('0.14.0', SPEND, SPEND_STEP_AT))
  stage.archon.answer(eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 0 }), recorded('0.14.0', SPEND, SPEND_CURSOR_AT))
  return stage
}

function readyStep(answer: StepAnswer): Extract<StepAnswer['step'], { kind: 'ready' }> {
  if (answer.step.kind !== 'ready') throw new Error(`The step view was ${answer.step.kind}, not ready.`)
  return answer.step
}

describe('the step view request on the recorded agent step of 0.14.0', () => {
  test('answers the step facts and its output, and folds the five events into a tool call and the agent text', async () => {
    const stage = spendScene()
    const { worker } = await stage.mount()
    const answer = (await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' } satisfies StepRequest)) as StepAnswer
    const step = readyStep(answer)
    assert.equal(step.facts.name, 'list')
    assert.equal(step.facts.kind, 'agent')
    assert.equal(step.facts.state, 'completed')
    assert.equal(step.facts.position, 1)
    assert.equal(step.facts.count, 1)
    assert.equal(step.facts.previous, null)
    assert.equal(step.facts.next, null)
    assert.equal(step.facts.starts, 1)
    assert.equal(step.facts.durationMs, 4722)
    assert.equal(step.facts.costUsd, 0.00178976)
    assert.deepEqual(step.facts.tokens, { input: 17038, output: 301 })
    assert.equal(step.facts.model, 'claude-haiku-5-5')
    assert.equal(step.facts.provider, 'claude')
    assert.equal(step.facts.turns, 2)
    assert.equal(step.facts.stopReason, 'end_turn')
    assert.equal(step.facts.error, null)
    assert.equal(step.facts.skip, null)
    assert.equal(step.output?.blocks.length, 1)
    assert.ok(step.output?.blocks[0]?.startsWith('Files in `<project-path>`:'))
    assert.equal(step.output?.notShown, 0)
    // The recording's five events: state_update, tool_call, heartbeat, tool_call_update and one
    // agent_message_chunk. The tool call and its update are one item; the state update and the
    // heartbeat, a type #17's table does not list, are counted and not listed.
    assert.deepEqual(step.activity, {
      kind: 'ready',
      attempts: [
        {
          key: `attempt:${SPEND_ATTEMPT}`,
          number: 1,
          rows: [
            { key: `${SPEND_ATTEMPT}:text:4`, kind: 'text', label: 'Files in `<project-path>`:', detail: 'Agent text', at: Date.UTC(2026, 10, 20, 2, 27, 23, 492) },
            { key: `${SPEND_ATTEMPT}:tool:toolu_01HxY5X64vMXEVYM9VFgs5gT`, kind: 'tool', label: 'Glob', detail: 'Completed', at: Date.UTC(2026, 10, 20, 2, 27, 21, 958) }
          ]
        }
      ],
      loaded: 2,
      total: 2,
      earlier: 0,
      pastCap: 0,
      hidden: 2,
      unreadable: 0,
      live: false
    })
    assert.deepEqual(urls(stage).filter((url) => url.startsWith(RUN_PATH)), [`${RUN_PATH}${SPEND_RUN}`, eventsUrl(SPEND_RUN, 'list')])
    // Nothing of an event's own shape reaches the frame.
    assert.equal(JSON.stringify(answer).includes('rawInput'), false)
    assert.equal(JSON.stringify(answer).includes('filenames'), false)
  })
})

describe('an item of the recorded agent step', () => {
  test('the tool call shows its input as JSON and its output as Archon stored it, and the agent text whole', async () => {
    const stage = spendScene()
    const { worker } = await stage.mount()
    await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })
    const tool = (await worker.request('step.item', {
      runId: SPEND_RUN,
      stepId: 'list',
      key: `${SPEND_ATTEMPT}:tool:toolu_01HxY5X64vMXEVYM9VFgs5gT`
    } satisfies ItemRequest)) as ItemAnswer
    if (tool.item.kind !== 'tool') throw new Error(`The item was ${tool.item.kind}.`)
    assert.equal(tool.item.name, 'Glob')
    assert.equal(tool.item.state, 'completed')
    assert.deepEqual(tool.item.input, { text: '{\n  "pattern": "*"\n}', cut: false })
    assert.equal(tool.item.output?.cut, false)
    assert.ok(tool.item.output?.text.startsWith('{"filenames":['))
    assert.ok(tool.item.output?.text.endsWith('"countIsComplete":true}'))
    assert.equal(tool.item.outputTruncated, false)
    const text = (await worker.request('step.item', { runId: SPEND_RUN, stepId: 'list', key: `${SPEND_ATTEMPT}:text:4` })) as ItemAnswer
    if (text.item.kind !== 'text') throw new Error(`The item was ${text.item.kind}.`)
    assert.ok(text.item.text.text.endsWith('hooks, objects, refs, logs)'))
    const missing = (await worker.request('step.item', { runId: SPEND_RUN, stepId: 'list', key: 'no such item' })) as ItemAnswer
    assert.deepEqual(missing.item, { kind: 'not-found' })
  })
})

/** The one-step echo run each release's run-detail recording holds, read off the fixtures by hand. */
const ECHO_RUN: Record<Release, string> = {
  '0.12.1': '7c28e1a1-6432-4c9d-89d6-874cfaf81f89',
  '0.13.2': '542b1888-311b-4b65-b005-8b78e33a7c79',
  '0.14.0': '68b479b2-217a-4e84-b86d-ecb9faf394e6'
}

describe('the recorded provider events of every supported release', () => {
  for (const release of RELEASES) {
    test(`${release}: the shell step's recorded events are an empty list, which reads as no activity`, async () => {
      const stage = connectedScene(release)
      const runId = ECHO_RUN[release]
      stage.archon.answer(`${RUN_PATH}${runId}`, recorded(release, 'run-detail'))
      stage.archon.answer(eventsUrl(runId, 'write'), recorded(release, 'run-provider-events'))
      const { worker } = await stage.mount()
      const step = readyStep((await worker.request('step.read', { runId, stepId: 'write' })) as StepAnswer)
      assert.equal(step.facts.kind, 'exec')
      assert.equal(step.facts.state, 'completed')
      assert.deepEqual(step.activity, { kind: 'ready', attempts: [], loaded: 0, total: 0, earlier: 0, pastCap: 0, hidden: 0, unreadable: 0, live: false })
    })
  }
})

/** When a scripted event was observed: `second` seconds after 03:00 UTC on 20 November 2026. */
const at = (second: number): number => Date.UTC(2026, 10, 20, 3, 0, second)

/** One provider event in the shape the 0.14.0 spend recording holds: run, step, attempt, seq, time and event. */
function scripted(runId: string, step: string, attemptId: string, seq: number, event: Record<string, unknown>): Record<string, unknown> {
  return { runId, stepName: step, attemptId, seq, observedAt: new Date(at(seq)).toISOString(), event }
}

/** Every row of #17's table, in two attempts, with three events that cannot be read. */
function tableEvents(runId: string, step: string): unknown[] {
  const one = (seq: number, event: Record<string, unknown>) => scripted(runId, step, 'a1', seq, event)
  return [
    one(0, { type: 'state_update', state: 'running' }),
    one(1, { type: 'agent_thought_chunk', text: 'Thinking about it' }),
    one(2, { type: 'agent_thought_chunk', text: 'and some more' }),
    one(3, { type: 'agent_message_chunk', text: 'First block' }),
    one(4, { type: 'hook', hookId: 'h1', hookName: 'format', hookEvent: 'PostToolUse', status: 'started' }),
    one(5, { type: 'agent_message_chunk', text: 'Second block' }),
    one(6, { type: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'ls -la', rawInput: { command: 'ls -la' } }),
    one(7, { type: 'subtask', taskId: 's1', status: 'started', description: 'Explore the repo' }),
    one(8, { type: 'tool_call_update', toolCallId: 't1', status: 'failed', output: 'boom', outputTruncated: true, exitCode: 2 }),
    one(9, { type: 'subtask', taskId: 's1', status: 'completed', summary: 'Found 3 files' }),
    one(10, { type: 'hook', hookId: 'h1', hookName: 'format', hookEvent: 'PostToolUse', status: 'succeeded' }),
    one(11, { type: 'hook', hookId: 'h2', hookName: 'lint', hookEvent: 'PreToolUse', status: 'started' }),
    one(12, { type: 'hook', hookId: 'h2', hookName: 'lint', hookEvent: 'PreToolUse', status: 'failed', exitCode: 1 }),
    one(13, { type: 'warning', code: 'claude.node_config_ignored', message: 'Careful: a setting was ignored' }),
    one(14, { type: 'heartbeat' }),
    one(15, { type: 'mcp_server_status', server: 'files', status: 'connected' }),
    { ...one(16, { type: 'agent_message_chunk', text: 'bad seq' }), seq: '16' },
    one(17, { type: 'tool_call', toolCallId: 7, name: 'Bash' }),
    { runId, stepName: step, attemptId: 'a1', seq: 18, observedAt: 'later' },
    scripted(runId, step, 'a2', 0, { type: 'agent_message_chunk', text: 'Tried again' })
  ]
}

describe('folding provider events as the table in #17 sets', () => {
  for (const release of RELEASES) {
    test(`${release}: scripted events in the recorded shape on the recorded run, as its recordings hold none`, async () => {
      const stage = connectedScene(release)
      const runId = ECHO_RUN[release]
      stage.archon.answer(`${RUN_PATH}${runId}`, recorded(release, 'run-detail'))
      stage.archon.answer(eventsUrl(runId, 'write'), json({ events: tableEvents(runId, 'write') }))
      const { worker } = await stage.mount()
      const step = readyStep((await worker.request('step.read', { runId, stepId: 'write' })) as StepAnswer)
      assert.deepEqual(step.activity, {
        kind: 'ready',
        attempts: [
          { key: 'attempt:a2', number: 2, rows: [{ key: 'a2:text:0', kind: 'text', label: 'Tried again', detail: 'Agent text', at: at(0) }] },
          {
            key: 'attempt:a1',
            number: 1,
            rows: [
              { key: 'a1:warning:13', kind: 'warning', label: 'Careful: a setting was ignored', detail: 'Warning', at: at(13) },
              { key: 'a1:hook:h2', kind: 'hook', label: 'Hook lint', detail: 'Failed with exit code 1', at: at(11) },
              { key: 'a1:subtask:s1', kind: 'subtask', label: 'Explore the repo', detail: 'Subtask completed · Found 3 files', at: at(7) },
              { key: 'a1:tool:t1', kind: 'tool', label: 'ls -la', detail: 'Failed', at: at(6) },
              { key: 'a1:text:3', kind: 'text', label: 'First block', detail: 'Agent text', at: at(3) },
              { key: 'a1:thinking:1', kind: 'thinking', label: 'Thinking about it', detail: 'Thinking', at: at(1) }
            ]
          }
        ],
        loaded: 7,
        total: 7,
        earlier: 0,
        pastCap: 0,
        // The state update, both events of the hook that succeeded, the heartbeat and the MCP status.
        hidden: 5,
        unreadable: 3,
        live: false
      })
      const item = async (key: string) => ((await worker.request('step.item', { runId, stepId: 'write', key })) as ItemAnswer).item
      assert.deepEqual(await item('a1:text:3'), { kind: 'text', text: { text: 'First block\n\nSecond block', cut: false } })
      assert.deepEqual(await item('a1:thinking:1'), { kind: 'thinking', text: { text: 'Thinking about it\n\nand some more', cut: false } })
      assert.deepEqual(await item('a1:tool:t1'), {
        kind: 'tool',
        name: 'Bash',
        title: 'ls -la',
        state: 'failed',
        input: { text: '{\n  "command": "ls -la"\n}', cut: false },
        output: { text: 'boom', cut: false },
        outputTruncated: true,
        exitCode: 2
      })
      assert.deepEqual(await item('a1:subtask:s1'), { kind: 'subtask', status: 'completed', description: 'Explore the repo', summary: { text: 'Found 3 files', cut: false } })
      assert.deepEqual(await item('a1:hook:h2'), { kind: 'hook', name: 'lint', event: 'PreToolUse', exitCode: 1 })
      assert.deepEqual(await item('a1:hook:h1'), { kind: 'not-found' })
    })
  }
})

/** The recorded agent step's run as Archon answers it while the step runs, or once it ended. */
function spendRun(state: 'running' | 'completed'): ReturnType<typeof json> {
  const answer = recorded('0.14.0', SPEND, SPEND_RUN_AT)
  if (answer.kind !== 'json') throw new Error('The recorded run is not JSON.')
  const body = answer.value as { run: Record<string, unknown>; events: { event_type: string }[] }
  if (state === 'completed') return answer
  return json({
    ...body,
    run: { ...body.run, status: 'running', completed_at: null, nodes: [{ node_id: 'list', state: 'running' }] },
    events: body.events.filter((event) => event.event_type !== 'node_completed' && event.event_type !== 'workflow_completed')
  })
}

/** The recorded step's events from `from` to `to`, as the scripted Archon answers a read. */
function recordedEvents(from: number, to: number): ReturnType<typeof json> {
  const answer = recorded('0.14.0', SPEND, SPEND_STEP_AT)
  if (answer.kind !== 'json') throw new Error('The recorded events are not JSON.')
  const events = (answer.value as { events: { seq: number }[] }).events
  return json({ events: events.filter((event) => event.seq >= from && event.seq <= to) })
}

const stepHints = (posts: readonly { event: string; payload?: unknown }[]): unknown[] => posts.filter((post) => post.event === 'step.changed').map((post) => post.payload)
const eventCalls = (stage: Scene): string[] => urls(stage).filter((url) => url.includes('/provider-events'))

describe('a running step while its view is open', () => {
  test('is polled every 3 seconds after the last event held, with the route cursor, and a hint names it when new events came', async () => {
    const stage = connectedScene('0.14.0')
    let state: 'running' | 'completed' = 'running'
    stage.archon.answer(`${RUN_PATH}${SPEND_RUN}`, () => spendRun(state))
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list'), recordedEvents(0, 1))
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 1 }), recordedEvents(2, 3))
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 3 }), recordedEvents(4, 4))
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 4 }), recordedEvents(5, 4))
    const { worker } = await stage.mount()
    const first = readyStep((await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })) as StepAnswer)
    assert.equal(first.facts.state, 'running')
    assert.equal(first.activity.kind === 'ready' && first.activity.live, true)
    assert.equal(first.activity.kind === 'ready' && first.activity.total, 1)
    assert.deepEqual(eventCalls(stage), [eventsUrl(SPEND_RUN, 'list')])

    await stage.clock.advance(2_999)
    assert.equal(eventCalls(stage).length, 1)
    await stage.clock.advance(1)
    assert.deepEqual(eventCalls(stage).at(-1), eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 1 }))
    assert.deepEqual(stepHints(worker.posts), [{ runId: SPEND_RUN, stepId: 'list' }])

    await stage.clock.advance(3_000)
    assert.deepEqual(eventCalls(stage).at(-1), eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 3 }))
    assert.equal(stepHints(worker.posts).length, 2)
    const second = readyStep((await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })) as StepAnswer)
    assert.equal(second.activity.kind === 'ready' && second.activity.total, 2)

    // A poll that brings nothing new posts no hint.
    const before = eventCalls(stage).length
    await stage.clock.advance(3_000)
    assert.equal(eventCalls(stage).length, before + 1)
    assert.equal(stepHints(worker.posts).length, 2)

    // The step ended: the read catches the tail once, and polling stops.
    state = 'completed'
    const ended = readyStep((await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })) as StepAnswer)
    assert.equal(ended.activity.kind === 'ready' && ended.activity.live, false)
    const after = eventCalls(stage).length
    await stage.clock.advance(30_000)
    assert.equal(eventCalls(stage).length, after)
    // A step that is not running is read once: reading it again asks Archon for no events.
    await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })
    assert.equal(eventCalls(stage).length, after)
  })
})

describe('polling stops', () => {
  /** A running step whose every cursor read brings nothing new. */
  async function openRunning(): Promise<{ stage: Scene; worker: Awaited<ReturnType<Scene['mount']>>['worker'] }> {
    const stage = connectedScene('0.14.0')
    stage.archon.answer(`${RUN_PATH}${SPEND_RUN}`, spendRun('running'))
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list'), recordedEvents(0, 1))
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 1 }), recordedEvents(2, 1))
    const { worker } = await stage.mount()
    await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })
    await stage.clock.advance(3_000)
    assert.equal(eventCalls(stage).length, 2)
    return { stage, worker }
  }

  test('when the view closes', async () => {
    const { stage, worker } = await openRunning()
    assert.equal(await worker.request('step.close', { runId: SPEND_RUN, stepId: 'list' }), null)
    await stage.clock.advance(30_000)
    assert.equal(eventCalls(stage).length, 2)
  })

  test('when the view has not read the step for longer than its safety refetch', async () => {
    const { stage } = await openRunning()
    await stage.clock.advance(120_000)
    // The first read, then polls until the lease of 65 seconds from the read ends: 21 of them, at 3, 6, ... 63 seconds.
    assert.equal(eventCalls(stage).length, 22)
  })

  test('while the state is not Connected, until the view reads the step again', async () => {
    const { stage, worker } = await openRunning()
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 1 }), () => {
      stage.archon.answer(DEFAULT_HEALTH, REFUSE)
      return REFUSE
    })
    await stage.clock.advance(3_000)
    assert.equal(eventCalls(stage).length, 3)
    await stage.clock.advance(15_000)
    assert.equal(eventCalls(stage).length, 3)
    await worker.request('step.close', { runId: SPEND_RUN, stepId: 'list' })
  })
})

describe('the read cap of 32 MiB for one step', () => {
  test('a step whose events pass it on the first read shows the notice in place of the list', async () => {
    const stage = connectedScene('0.14.0')
    stage.archon.answer(`${RUN_PATH}${SPEND_RUN}`, recorded('0.14.0', SPEND, SPEND_RUN_AT))
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list'), { kind: 'chunks', chunks: [new Uint8Array(STEP_EVENTS_CAP_BYTES), new Uint8Array(1)] })
    const { worker } = await stage.mount()
    const step = readyStep((await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })) as StepAnswer)
    assert.deepEqual(step.activity, { kind: 'too-large' })
    assert.equal(stage.archon.lastBody.closed, true)
  })

  test('counts every read of the step: a poll that takes it past the cap stops polling and shows the notice', async () => {
    const stage = connectedScene('0.14.0')
    stage.archon.answer(`${RUN_PATH}${SPEND_RUN}`, spendRun('running'))
    const first = recordedEvents(0, 1)
    const firstBytes = new TextEncoder().encode(JSON.stringify(first.kind === 'json' ? first.value : null)).byteLength
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list'), first)
    // Exactly what is left under the cap would fit; one byte more does not.
    stage.archon.answer(eventsUrl(SPEND_RUN, 'list', { attemptId: SPEND_ATTEMPT, seq: 1 }), {
      kind: 'chunks',
      chunks: [new Uint8Array(STEP_EVENTS_CAP_BYTES - firstBytes), new Uint8Array(1)]
    })
    const { worker } = await stage.mount()
    await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })
    await stage.clock.advance(3_000)
    assert.deepEqual(stepHints(worker.posts), [{ runId: SPEND_RUN, stepId: 'list' }])
    const step = readyStep((await worker.request('step.read', { runId: SPEND_RUN, stepId: 'list' })) as StepAnswer)
    assert.deepEqual(step.activity, { kind: 'too-large' })
    const calls = eventCalls(stage).length
    await stage.clock.advance(30_000)
    assert.equal(eventCalls(stage).length, calls)
  })
})

describe('paging the activity', () => {
  /** `count` warnings, one item each, in one attempt. */
  function warnings(runId: string, count: number): unknown[] {
    return Array.from({ length: count }, (_, seq) => scripted(runId, 'write', 'a1', seq, { type: 'warning', code: 'x', message: `Warning ${String(seq)}` }))
  }

  async function pageOf(count: number, pages?: number) {
    const stage = connectedScene('0.14.0')
    const runId = ECHO_RUN['0.14.0']
    stage.archon.answer(`${RUN_PATH}${runId}`, recorded('0.14.0', 'run-detail'))
    stage.archon.answer(eventsUrl(runId, 'write'), json({ events: warnings(runId, count) }))
    const { worker } = await stage.mount()
    const request: StepRequest = pages === undefined ? { runId, stepId: 'write' } : { runId, stepId: 'write', pages }
    const step = readyStep((await worker.request('step.read', request)) as StepAnswer)
    if (step.activity.kind !== 'ready') throw new Error('The activity was not ready.')
    return { activity: step.activity, worker, runId }
  }

  test('the view opens on the newest 50 items, and each page more adds the 50 before them', async () => {
    const one = await pageOf(120)
    assert.equal(one.activity.loaded, 50)
    assert.equal(one.activity.total, 120)
    assert.equal(one.activity.earlier, 70)
    assert.equal(one.activity.attempts[0]?.rows[0]?.label, 'Warning 119')
    assert.equal(one.activity.attempts[0]?.rows.at(-1)?.label, 'Warning 70')
    const three = await pageOf(120, 3)
    assert.equal(three.activity.loaded, 120)
    assert.equal(three.activity.earlier, 0)
    assert.equal(three.activity.attempts[0]?.rows.at(-1)?.label, 'Warning 0')
  })

  test('the list stops at 20 pages, and says how many earlier items are past it', async () => {
    const { activity } = await pageOf(1_100, 20)
    assert.equal(activity.loaded, 1_000)
    assert.equal(activity.earlier, 0)
    assert.equal(activity.pastCap, 100)
  })

  test('a page count that is not a whole number from 1 to 20 is refused, as are a missing step id and a key the request does not take', async () => {
    const { worker, runId } = await pageOf(1)
    const refused = async (input: unknown, message: RegExp): Promise<void> => {
      await assert.rejects(worker.request('step.read', input as never), (error: unknown) => {
        const { code, message: text } = error as { code?: string; message?: string }
        return code === 'invalid_params' && message.test(text ?? '')
      })
    }
    for (const pages of [0, 21, 1.5, '2', Number.NaN, null]) await refused({ runId, stepId: 'write', pages }, /Pages must be a whole number from 1 to 20/)
    await refused({ runId, stepId: '' }, /The step id must be text/)
    await refused({ runId, stepId: 'write', extra: 1 }, /does not take extra/)
  })
})

describe('the step facts', () => {
  test('a failed step carries its error, from the recorded failed run of 0.14.0', async () => {
    const stage = connectedScene('0.14.0')
    const runId = '9441f1e2-b466-440a-b869-65527d5688b9'
    stage.archon.answer(`${RUN_PATH}${runId}`, recorded('0.14.0', 'run-failed', 8))
    stage.archon.answer(eventsUrl(runId, 'fail'), json({ events: [] }))
    const { worker } = await stage.mount()
    const step = readyStep((await worker.request('step.read', { runId, stepId: 'fail' })) as StepAnswer)
    assert.equal(step.facts.state, 'failed')
    assert.equal(step.facts.error, "Bash node 'fail' failed [exit 1]: recorded failure")
    assert.equal(step.facts.durationMs, 94)
    assert.equal(step.output, null)
  })

  test('a skipped step carries its reason and condition; a step the run lacks, and a run Archon lacks, say so', async () => {
    const stage = connectedScene('0.14.0')
    const runId = ECHO_RUN['0.14.0']
    const answer = recorded('0.14.0', 'run-detail')
    if (answer.kind !== 'json') throw new Error('The recorded run is not JSON.')
    const body = answer.value as { run: Record<string, unknown>; events: unknown[] }
    const skipped = {
      event_type: 'node_skipped',
      step_name: 'deploy',
      data: { node: { id: 'deploy', kind: 'bash' }, reason: 'when_condition', cause: { kind: 'condition', expr: "$plan.output == 'yes'" } }
    }
    stage.archon.answer(
      `${RUN_PATH}${runId}`,
      json({
        ...body,
        run: { ...body.run, nodes: [{ node_id: 'write', state: 'completed' }, { node_id: 'deploy', state: 'skipped' }] },
        events: [...body.events, skipped]
      })
    )
    stage.archon.answer(eventsUrl(runId, 'deploy'), json({ events: [] }))
    stage.archon.answer(`${RUN_PATH}gone-run`, json({ error: 'Workflow run not found' }, 404))
    const { worker } = await stage.mount()
    const step = readyStep((await worker.request('step.read', { runId, stepId: 'deploy' })) as StepAnswer)
    assert.deepEqual(step.facts.skip, { reason: 'when_condition', condition: "$plan.output == 'yes'" })
    assert.equal(step.facts.position, 2)
    assert.equal(step.facts.count, 2)
    assert.equal(step.facts.previous, 'write')
    assert.equal(step.facts.next, null)
    const missing = (await worker.request('step.read', { runId, stepId: 'nowhere' })) as StepAnswer
    assert.deepEqual(missing.step, { kind: 'no-step' })
    const gone = (await worker.request('step.read', { runId: 'gone-run', stepId: 'write' })) as StepAnswer
    assert.deepEqual(gone.step, { kind: 'gone' })
  })
})

describe('what the worker keeps', () => {
  /** The recorded echo run of 0.14.0 with seven completed steps, each with one warning. */
  function sevenSteps(): { stage: Scene; runId: string; ids: string[] } {
    const stage = connectedScene('0.14.0')
    const runId = ECHO_RUN['0.14.0']
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7']
    const answer = recorded('0.14.0', 'run-detail')
    if (answer.kind !== 'json') throw new Error('The recorded run is not JSON.')
    const body = answer.value as { run: Record<string, unknown> }
    stage.archon.answer(`${RUN_PATH}${runId}`, json({ ...body, run: { ...body.run, nodes: ids.map((id) => ({ node_id: id, state: 'completed' })) }, events: [] }))
    for (const id of ids) {
      stage.archon.answer(eventsUrl(runId, id), json({ events: [scripted(runId, id, 'a1', 0, { type: 'warning', message: `In ${id}` })] }))
    }
    return { stage, runId, ids }
  }

  test('a finished step is read once while it is kept; past the five steps most recently viewed, the oldest is read again', async () => {
    const { stage, runId, ids } = sevenSteps()
    const { worker } = await stage.mount()
    for (const id of ids.slice(0, 5)) await worker.request('step.read', { runId, stepId: id })
    await worker.request('step.read', { runId, stepId: 's1' })
    assert.equal(eventCalls(stage).length, 5)
    // s1 was viewed last, so s2 is the oldest kept and is let go when s6 is read.
    await worker.request('step.read', { runId, stepId: 's6' })
    await worker.request('step.read', { runId, stepId: 's1' })
    assert.equal(eventCalls(stage).length, 6)
    await worker.request('step.read', { runId, stepId: 's2' })
    assert.equal(eventCalls(stage).length, 7)
    assert.equal(eventCalls(stage).at(-1), eventsUrl(runId, 's2'))
  })

  test("an item of a step no longer kept is read from Archon at the moment it is asked for", async () => {
    const { stage, runId } = sevenSteps()
    const { worker } = await stage.mount()
    const answer = (await worker.request('step.item', { runId, stepId: 's3', key: 'a1:warning:0' })) as ItemAnswer
    assert.deepEqual(answer.item, { kind: 'warning', code: null, text: { text: 'In s3', cut: false } })
    assert.deepEqual(eventCalls(stage), [eventsUrl(runId, 's3')])
  })
})

describe('an item preview is cut at 16 KiB', () => {
  test("a tool call's input and output, and joined agent text, each say when they were cut; Archon's own cut is said apart", async () => {
    const stage = connectedScene('0.14.0')
    const runId = ECHO_RUN['0.14.0']
    stage.archon.answer(`${RUN_PATH}${runId}`, recorded('0.14.0', 'run-detail'))
    const one = (seq: number, event: Record<string, unknown>) => scripted(runId, 'write', 'a1', seq, event)
    stage.archon.answer(
      eventsUrl(runId, 'write'),
      json({
        events: [
          one(0, { type: 'tool_call', toolCallId: 't1', name: 'Write', rawInput: 'x'.repeat(20_000) }),
          one(1, { type: 'tool_call_update', toolCallId: 't1', status: 'completed', output: 'y'.repeat(16_384), outputTruncated: true }),
          one(2, { type: 'agent_message_chunk', text: 'a'.repeat(10_000) }),
          one(3, { type: 'agent_message_chunk', text: 'b'.repeat(10_000) })
        ]
      })
    )
    const { worker } = await stage.mount()
    await worker.request('step.read', { runId, stepId: 'write' })
    const tool = ((await worker.request('step.item', { runId, stepId: 'write', key: 'a1:tool:t1' })) as ItemAnswer).item
    if (tool.kind !== 'tool') throw new Error(`The item was ${tool.kind}.`)
    assert.equal(tool.input?.text.length, 16_384)
    assert.equal(tool.input?.cut, true)
    assert.equal(tool.output?.text.length, 16_384)
    assert.equal(tool.output?.cut, false)
    assert.equal(tool.outputTruncated, true)
    const text = ((await worker.request('step.item', { runId, stepId: 'write', key: 'a1:text:2' })) as ItemAnswer).item
    if (text.kind !== 'text') throw new Error(`The item was ${text.kind}.`)
    assert.equal(text.text.text.length, 16_384)
    assert.equal(text.text.cut, true)
  })
})
