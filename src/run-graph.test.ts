// The worker's request protocol seam for the run graph tab: the worker mounted on a scripted
// Archon that replays the recorded runs, projects and workflows. These tests cover `graph.read`,
// the request a graph tab sends: what the worker asks Archon and the view model it answers,
// including the mismatch rules of #17 and the cap on laid-out steps.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Release, type Scene, type Scripted } from '../scripts/scripted-archon.ts'
import type { GraphAnswer, GraphStep, GraphView } from '../editors/run-graph/graph-view'

const RUNS = `${DEFAULT}/api/workflows/runs/`
const CODEBASES = `${DEFAULT}/api/codebases`
/** The recorded projects' folder, as the recorder scrubbed it. */
const CWD = encodeURIComponent('<project-path>')
const workflowUrl = (name: string): string => `${DEFAULT}/api/workflows/${encodeURIComponent(name)}?cwd=${CWD}`

/** The run each release's run-detail recording holds, read off the fixtures by hand. */
const ECHO_RUN: Record<Release, string> = {
  '0.12.1': '7c28e1a1-6432-4c9d-89d6-874cfaf81f89',
  '0.13.2': '542b1888-311b-4b65-b005-8b78e33a7c79',
  '0.14.0': '68b479b2-217a-4e84-b86d-ecb9faf394e6'
}

function jsonOf(answer: Scripted): Record<string, unknown> {
  if (answer.kind !== 'json') throw new Error('The recorded answer is not JSON.')
  return answer.value as Record<string, unknown>
}

/**
 * One workflow as `GET /api/workflows/{name}` answers it, taken from the release's recorded
 * workflow list: the recorder's own workflows have no recording of their own.
 */
function listedWorkflow(release: Release, name: string): Scripted {
  const list = jsonOf(recorded(release, 'workflows')).workflows as { workflow: { name: string }; source: string }[]
  const entry = list.find((item) => item.workflow.name === name)
  if (entry === undefined) throw new Error(`The recorded list of ${release} has no ${name}.`)
  return json({ workflow: entry.workflow, source: entry.source })
}

/** The recorded run of a scenario with some fields of `run` changed. */
function changed(answer: Scripted, change: Record<string, unknown>): Scripted {
  const value = jsonOf(answer) as { run: Record<string, unknown> }
  return json({ ...value, run: { ...value.run, ...change } })
}

function stageFor(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  return stage
}

async function readGraph(stage: Scene, runId: string): Promise<GraphAnswer> {
  const { worker } = await stage.mount()
  const answer = (await worker.request('graph.read', { runId, locale: 'en-US' })) as GraphAnswer
  await worker.deactivate()
  return answer
}

function ready(view: GraphView): Extract<GraphView, { kind: 'ready' }> {
  if (view.kind !== 'ready') throw new Error(`The graph is ${view.kind}, not ready.`)
  return view
}

const brief = (steps: GraphStep[]): string[] => steps.map((step) => `${step.id} ${step.glyph} ${step.word}`)

describe('the run graph request', () => {
  for (const release of RELEASES) {
    test(`draws the recorded run of ${release} on its workflow as it is now`, async () => {
      const stage = stageFor(release)
      const runId = ECHO_RUN[release]
      stage.archon.answer(`${RUNS}${runId}`, recorded(release, 'run-detail'))
      stage.archon.answer(workflowUrl('orchon-recorder-echo'), listedWorkflow(release, 'orchon-recorder-echo'))
      const answer = await readGraph(stage, runId)
      assert.deepEqual(answer.connection, { kind: 'connected', live: true })
      const graph = ready(answer.graph)
      assert.equal(graph.mismatch, null)
      assert.deepEqual({ ...graph.header, started: '' }, { workflow: 'orchon-recorder-echo', shortId: runId.slice(0, 8), state: '✓ Completed', started: '', finished: true })
      assert.match(graph.header.started, /2026/)
      assert.deepEqual(graph.steps, [
        {
          id: 'write',
          name: 'write',
          kind: 'exec',
          state: 'completed',
          glyph: '✓',
          word: 'Completed',
          group: null,
          isGroup: false,
          conditional: false,
          note: null,
          summary: { duration: '0s', cost: null, model: null, skipReason: null, output: 'recorded', outputShown: 'whole' }
        }
      ])
      assert.deepEqual(graph.edges, [])
    })
  }

  test("a paused run's waiting step says it is answered in the Orchon panel, and its arrows follow the workflow", async () => {
    const stage = stageFor()
    const runId = 'e7678067-ddb7-44b2-9bec-2d9a049e9c5e'
    stage.archon.answer(`${RUNS}${runId}`, recorded('0.12.1', 'attention-gate', 2))
    stage.archon.answer(workflowUrl('orchon-recorder-gate'), listedWorkflow('0.12.1', 'orchon-recorder-gate'))
    const graph = ready((await readGraph(stage, runId)).graph)
    assert.equal(graph.mismatch, null)
    assert.equal(graph.header.state, '‖ Paused')
    assert.equal(graph.header.finished, false)
    assert.deepEqual(brief(graph.steps), ['gate ‖ Waiting', 'ask ○ Not reached', 'done ○ Not reached'])
    assert.equal(graph.steps[0]?.note, 'Answered in the Orchon panel.')
    assert.equal(graph.steps[1]?.note, null)
    assert.deepEqual(graph.edges, [
      { from: 'gate', to: 'ask' },
      { from: 'ask', to: 'done' }
    ])
  })

  test("a step with a when is conditional, and a loop group holds its own steps with the group's id in front", async () => {
    const stage = stageFor('0.14.0')
    const runId = ECHO_RUN['0.14.0']
    const nodes = [
      { node_id: 'forge', state: 'completed' },
      { node_id: 'rounds', state: 'running' },
      { node_id: 'rounds.implement', state: 'completed' },
      { node_id: 'rounds.pr', state: 'running' }
    ]
    stage.archon.answer(`${RUNS}${runId}`, changed(recorded('0.14.0', 'run-detail'), { workflow_name: 'archon-deliver-block', status: 'running', nodes, metadata: {} }))
    stage.archon.answer(workflowUrl('archon-deliver-block'), recorded('0.14.0', 'workflows/archon-deliver-block'))
    const graph = ready((await readGraph(stage, runId)).graph)
    assert.equal(graph.mismatch, null)
    const rounds = graph.steps.find((step) => step.id === 'rounds')
    assert.equal(rounds?.isGroup, true)
    const pr = graph.steps.find((step) => step.id === 'rounds.pr')
    assert.deepEqual(pr && { name: pr.name, group: pr.group, conditional: pr.conditional, state: pr.state }, { name: 'pr', group: 'rounds', conditional: true, state: 'running' })
    assert.equal(graph.steps.find((step) => step.id === 'rounds.review')?.state, 'not-reached')
    assert.deepEqual(
      graph.edges.filter((edge) => edge.from === 'forge' || edge.to === 'rounds.pr'),
      [
        { from: 'forge', to: 'rounds' },
        { from: 'rounds.implement', to: 'rounds.pr' }
      ]
    )
    assert.ok(graph.edges.some((edge) => edge.from === 'rounds' && edge.to === 'update-pr-body'))
  })
})

describe("each step's summary for its card", () => {
  const runId = ECHO_RUN['0.12.1']
  const echo = jsonOf(listedWorkflow('0.12.1', 'orchon-recorder-echo')) as { workflow: Record<string, unknown> }
  const event = (step: string, type: string, data: Record<string, unknown>): Record<string, unknown> => ({ event_type: type, step_name: step, data })

  /** The recorded run with these nodes and events, drawn on a workflow of these ids. */
  async function summaries(ids: string[], events: Record<string, unknown>[], states: Record<string, string> = {}): Promise<GraphStep[]> {
    const stage = stageFor()
    const recordedRun = jsonOf(recorded('0.12.1', 'run-detail')) as { run: Record<string, unknown> }
    const nodes = ids.map((id) => ({ node_id: id, state: states[id] ?? 'completed' }))
    stage.archon.answer(`${RUNS}${runId}`, json({ run: { ...recordedRun.run, nodes, metadata: { terminal_graph: { node_ids: ids } } }, events }))
    stage.archon.answer(workflowUrl('orchon-recorder-echo'), json({ ...echo, workflow: { ...echo.workflow, nodes: ids.map((id) => ({ id, kind: 'exec' })) } }))
    return ready((await readGraph(stage, runId)).graph).steps
  }

  test("carries its latest start's duration, cost and model, the first 4 KiB of its output, and a skipped step's reason", async () => {
    const finished = {
      binding: { provider: 'claude', model: { requested: 'sonnet', resolved: { source: 'provider', value: 'claude-sonnet-4-5' } } },
      timing: { durationMs: 125_000 },
      spend: { costUsd: { source: 'provider', value: 0.1234 } },
      node_output: `${'a'.repeat(4_000)}${'b'.repeat(1_000)}`
    }
    const [agent, skipped, cheap] = await summaries(
      ['agent', 'skipped', 'cheap'],
      [
        event('agent', 'node_started', { binding: {} }),
        event('agent', 'node_failed', { timing: { durationMs: 1 }, node_output: 'first try' }),
        event('agent', 'node_started', { binding: {} }),
        event('agent', 'node_completed', finished),
        event('skipped', 'node_skipped', { reason: 'when_condition', node_output: '' }),
        event('cheap', 'node_completed', { binding: { model: { requested: 'haiku', resolved: { source: 'unavailable', reason: 'not_reported' } } }, cost_usd: 0.001, duration_ms: 3_400, node_output: 'done' })
      ],
      { skipped: 'skipped' }
    )
    assert.deepEqual(agent?.summary, {
      duration: '2m 5s',
      cost: '$0.12',
      model: 'claude-sonnet-4-5',
      skipReason: null,
      output: `${'a'.repeat(4_000)}${'b'.repeat(96)}`,
      outputShown: 'cut'
    })
    assert.deepEqual(skipped?.summary, { duration: null, cost: null, model: null, skipReason: 'Its when condition was false.', output: '', outputShown: 'whole' })
    assert.deepEqual(cheap?.summary, { duration: '3s', cost: 'Under $0.01', model: 'haiku', skipReason: null, output: 'done', outputShown: 'whole' })
  })

  test("a recorded skip of a step that had completed before the run resumed says so", async () => {
    const stage = stageFor()
    const gateRun = 'e7678067-ddb7-44b2-9bec-2d9a049e9c5e'
    stage.archon.answer(`${RUNS}${gateRun}`, recorded('0.12.1', 'attention-wait', 2))
    stage.archon.answer(workflowUrl('orchon-recorder-gate'), listedWorkflow('0.12.1', 'orchon-recorder-gate'))
    const graph = ready((await readGraph(stage, gateRun)).graph)
    assert.equal(graph.steps.find((step) => step.id === 'gate')?.summary?.skipReason, 'It had completed before the run resumed.')
  })

  test('past the size one answer may carry, later steps carry no output and say so, and the answer stays inside 1 MiB', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `step-${String(index)}`)
    const steps = await summaries(
      ids,
      ids.map((id) => event(id, 'node_completed', { node_output: '€'.repeat(5_000) }))
    )
    assert.equal(steps[0]?.summary?.outputShown, 'cut')
    assert.equal(steps[0]?.summary?.output.length, 4_096)
    assert.equal(steps[299]?.summary?.outputShown, 'withheld')
    assert.equal(steps[299]?.summary?.output, '')
    assert.ok(new TextEncoder().encode(JSON.stringify(steps)).length < 1024 * 1024)
  })
})

describe('the mismatch rules of #17', () => {
  const runId = ECHO_RUN['0.12.1']
  const echo = jsonOf(listedWorkflow('0.12.1', 'orchon-recorder-echo')) as { workflow: { nodes: Record<string, unknown>[] } }
  const withNodes = (nodes: Record<string, unknown>[]): Scripted => json({ ...echo, workflow: { ...echo.workflow, nodes } })
  const write = echo.workflow.nodes[0] ?? {}

  async function graphWith(run: Scripted, workflow: Scripted): Promise<Extract<GraphView, { kind: 'ready' }>> {
    const stage = stageFor()
    stage.archon.answer(`${RUNS}${runId}`, run)
    stage.archon.answer(workflowUrl('orchon-recorder-echo'), workflow)
    return ready((await readGraph(stage, runId)).graph)
  }

  test("a finished run whose top-level ids differ from the file's, in either direction, is a mismatch drawn in run order with no arrows", async () => {
    const more = await graphWith(recorded('0.12.1', 'run-detail'), withNodes([write, { id: 'later', kind: 'exec', depends_on: ['write'] }]))
    assert.equal(more.mismatch, 'changed')
    assert.deepEqual(brief(more.steps), ['write ✓ Completed'])
    assert.deepEqual(more.edges, [])
    const fewer = await graphWith(recorded('0.12.1', 'run-detail'), withNodes([{ ...write, id: 'renamed' }]))
    assert.equal(fewer.mismatch, 'changed')
    assert.deepEqual(brief(fewer.steps), ['write ✓ Completed'])
  })

  test('the run lists its top-level ids in terminal_graph; without it, its steps with no dot', async () => {
    const run = changed(recorded('0.12.1', 'run-detail'), { metadata: { terminal_graph: { node_ids: ['write', 'gone'] } } })
    assert.equal((await graphWith(run, withNodes([write]))).mismatch, 'changed')
    const bare = changed(recorded('0.12.1', 'run-detail'), { metadata: {}, nodes: [{ node_id: 'write', state: 'completed' }, { node_id: 'write.inner', state: 'completed' }] })
    assert.equal((await graphWith(bare, withNodes([write]))).mismatch, null)
  })

  test('a live run is a mismatch only when it has a top-level step the file lacks', async () => {
    const live = changed(recorded('0.12.1', 'run-detail'), { status: 'running', completed_at: null })
    const grown = await graphWith(live, withNodes([write, { id: 'later', kind: 'exec', depends_on: ['write'] }]))
    assert.equal(grown.mismatch, null)
    assert.deepEqual(brief(grown.steps), ['write ✓ Completed', 'later ○ Not reached'])
    assert.equal(grown.header.finished, false)
    assert.equal((await graphWith(live, withNodes([{ ...write, id: 'renamed' }]))).mismatch, 'changed')
  })

  test('a deleted workflow file is a mismatch that says so', async () => {
    const deleted = await graphWith(recorded('0.12.1', 'run-detail'), json({ error: 'Workflow not found: orchon-recorder-echo' }, 404))
    assert.equal(deleted.mismatch, 'deleted')
    assert.deepEqual(brief(deleted.steps), ['write ✓ Completed'])
    assert.deepEqual(deleted.edges, [])
  })
})

describe('what the tab gets instead of a graph', () => {
  const runId = ECHO_RUN['0.12.1']

  test('a run with no project has no graph, and Archon is not asked for a workflow', async () => {
    const stage = stageFor()
    stage.archon.answer(`${RUNS}${runId}`, changed(recorded('0.12.1', 'run-detail'), { codebase_id: null }))
    const answer = await readGraph(stage, runId)
    assert.equal(answer.graph.kind, 'no-graph')
    assert.ok(answer.graph.kind === 'no-graph' && answer.graph.message === 'This run has no Archon project, so it has no graph.')
    assert.ok(!stage.archon.calls.some((call) => call.url.includes('/api/workflows/orchon')))
  })

  test('past 300 steps the tab gets the count and the cap, not the steps', async () => {
    const stage = stageFor()
    stage.archon.answer(`${RUNS}${runId}`, changed(recorded('0.12.1', 'run-detail'), { status: 'running', completed_at: null }))
    const nodes = Array.from({ length: 301 }, (_, index) => ({ id: index === 0 ? 'write' : `step-${String(index)}`, kind: 'exec' }))
    const echo = jsonOf(listedWorkflow('0.12.1', 'orchon-recorder-echo')) as { workflow: Record<string, unknown> }
    stage.archon.answer(workflowUrl('orchon-recorder-echo'), json({ ...echo, workflow: { ...echo.workflow, nodes } }))
    const answer = await readGraph(stage, runId)
    assert.ok(answer.graph.kind === 'too-many')
    assert.deepEqual({ count: answer.graph.count, cap: answer.graph.cap }, { count: 301, cap: 300 })
  })

  test('a run Archon does not have is gone', async () => {
    const stage = stageFor()
    stage.archon.answer(`${RUNS}${runId}`, json({ error: 'Workflow run not found' }, 404))
    assert.deepEqual((await readGraph(stage, runId)).graph, { kind: 'gone' })
  })

  test('while not connected the tab gets the state screen and Archon is not asked', async () => {
    const stage = scene()
    const answer = await readGraph(stage, runId)
    assert.deepEqual(answer.graph, { kind: 'not-connected' })
    assert.equal(answer.connection.kind, 'screen')
    assert.ok(answer.connection.kind === 'screen' && answer.connection.screen.title === 'Orchon could not find Archon.')
  })

  test('refuses a request that is not a run id and a language', async () => {
    const { worker } = await stageFor().mount()
    for (const input of [{ runId: '' }, { runId: 'x', locale: '' }, { runId: 'x'.repeat(201), locale: 'en' }, { runId: 'x', locale: 'en US<' }, { runId: 'x', locale: 'en', more: 1 }]) {
      await assert.rejects(worker.request('graph.read', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await worker.deactivate()
  })
})

describe('a tab Orca restores after a restart', () => {
  test('is served by a worker that has just started, before any panel has opened', async () => {
    const stage = stageFor()
    const runId = ECHO_RUN['0.12.1']
    stage.archon.answer(`${RUNS}${runId}`, recorded('0.12.1', 'run-detail'))
    stage.archon.answer(workflowUrl('orchon-recorder-echo'), listedWorkflow('0.12.1', 'orchon-recorder-echo'))
    const { worker, host } = await stage.mount()
    // Nothing has asked the worker anything: no panel request reached it.
    assert.deepEqual(host.callsOf('plugin.request'), [])
    const answer = (await worker.request('graph.read', { runId, locale: 'en-US' }, { panel: 'run-graph' })) as GraphAnswer
    assert.equal(answer.graph.kind, 'ready')
    await worker.deactivate()
  })
})
