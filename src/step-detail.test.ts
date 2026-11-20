// The worker's request protocol seam: the worker mounted on a scripted Archon, which replays the
// recorded run detail and provider-event answers. These tests cover the step view's requests:
// what the worker asks Archon, how it folds the step's provider events, and the trimmed view
// models it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Release, type Scene, urls } from '../scripts/scripted-archon.ts'
import type { ItemAnswer, ItemRequest, StepAnswer, StepRequest } from './step-view'

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
