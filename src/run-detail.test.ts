// The worker's request protocol seam: the worker mounted on a scripted Archon, which replays the
// recorded run detail answers. These tests cover run detail's request: what the worker asks
// Archon, and the trimmed view model it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Release, type Scene, urls } from '../scripts/scripted-archon.ts'
import type { RunDetail, RunDetailAnswer, RunDetailRequest } from './run-detail-view'

const RUN_PATH = `${DEFAULT}/api/workflows/runs/`
const CODEBASES = `${DEFAULT}/api/codebases`

/** A scene connected to the default address, with health answering as `release`. */
function connectedScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  return stage
}

async function readDetail(stage: Scene, input: RunDetailRequest): Promise<RunDetailAnswer> {
  const { worker } = await stage.mount()
  return (await worker.request('run.read', input)) as RunDetailAnswer
}

/** The run each release's run-detail recording holds, read off the fixtures by hand. */
const RECORDED: Record<Release, { id: string; started: number; ended: number; durationMs: number }> = {
  '0.12.1': {
    id: '7c28e1a1-6432-4c9d-89d6-874cfaf81f89',
    started: Date.UTC(2026, 10, 19, 1, 1, 15),
    ended: Date.UTC(2026, 10, 19, 1, 1, 18),
    durationMs: 207
  },
  '0.13.2': {
    id: '542b1888-311b-4b65-b005-8b78e33a7c79',
    started: Date.UTC(2026, 10, 19, 1, 3, 14),
    ended: Date.UTC(2026, 10, 19, 1, 3, 16),
    durationMs: 257
  },
  '0.14.0': {
    id: '68b479b2-217a-4e84-b86d-ecb9faf394e6',
    started: Date.UTC(2026, 10, 19, 1, 5, 13),
    ended: Date.UTC(2026, 10, 19, 1, 5, 16),
    durationMs: 507
  }
}

describe('the run detail request', () => {
  for (const release of RELEASES) {
    test(`reads the recorded run of ${release} into the trimmed view model`, async () => {
      const stage = connectedScene(release)
      const run = RECORDED[release]
      stage.archon.answer(`${RUN_PATH}${run.id}`, recorded(release, 'run-detail'))
      const answer = await readDetail(stage, { runId: run.id, open: true })
      assert.equal(answer.connection.kind, 'connected')
      assert.deepEqual(answer.run, {
        kind: 'ready',
        detail: {
          id: run.id,
          workflow: 'orchon-recorder-echo',
          status: 'completed',
          startedAt: run.started,
          endedAt: run.ended,
          costUsd: null,
          project: 'orchon-recorder/throwaway-project',
          workingPath: '<project-path>',
          message: 'Recording a launch for Orchon: one shell step.',
          messageCut: false,
          steps: [
            { id: 'write', name: 'write', kind: 'exec', state: 'completed', loop: null, starts: 1, durationMs: run.durationMs, reached: true }
          ],
          stepCount: 1,
          unreadableSteps: 0,
          waiting: null
        }
      })
    })
  }
})

/** The ids of the recorded failed and waiting runs, read off the fixtures by hand. */
const FAILED: Record<Release, { id: string; durationMs: number }> = {
  '0.12.1': { id: '7aa79fd0-82a8-4f02-96a1-3bcaf1944649', durationMs: 72 },
  '0.13.2': { id: 'cc369ba0-9500-4ee5-8ec3-76ead586add9', durationMs: 86 },
  '0.14.0': { id: '9441f1e2-b466-440a-b869-65527d5688b9', durationMs: 94 }
}
const WAITING: Record<Release, { id: string; gateMs: number }> = {
  '0.12.1': { id: 'e7678067-ddb7-44b2-9bec-2d9a049e9c5e', gateMs: 144 },
  '0.13.2': { id: '122e7550-1d38-43f0-92eb-67ed11e0cd37', gateMs: 66 },
  '0.14.0': { id: '092f196c-66fc-4beb-9d61-256cb682234e', gateMs: 248 }
}

function ready(answer: RunDetailAnswer): RunDetail {
  if (answer.run.kind !== 'ready') throw new Error(`Run detail was ${answer.run.kind}, not ready.`)
  return answer.run.detail
}

describe('the run detail validator against every supported release', () => {
  for (const release of RELEASES) {
    test(`reads the recorded failed run of ${release}`, async () => {
      const stage = connectedScene(release)
      const run = FAILED[release]
      stage.archon.answer(`${RUN_PATH}${run.id}`, recorded(release, 'run-failed', 8))
      const detail = ready(await readDetail(stage, { runId: run.id }))
      assert.equal(detail.status, 'failed')
      assert.deepEqual(detail.steps, [
        { id: 'fail', name: 'fail', kind: 'exec', state: 'failed', loop: null, starts: 1, durationMs: run.durationMs, reached: true }
      ])
    })

    test(`reads the recorded run of ${release} paused at an attention wait, with the step not reached last`, async () => {
      const stage = connectedScene(release)
      const run = WAITING[release]
      stage.archon.answer(`${RUN_PATH}${run.id}`, recorded(release, 'attention-wait', 2))
      const detail = ready(await readDetail(stage, { runId: run.id }))
      assert.equal(detail.status, 'paused')
      assert.deepEqual(detail.steps, [
        { id: 'gate', name: 'gate', kind: 'gate', state: 'completed', loop: null, starts: 1, durationMs: run.gateMs, reached: true },
        { id: 'ask', name: 'ask', kind: 'wait', state: 'running', loop: null, starts: 1, durationMs: null, reached: true },
        { id: 'done', name: 'done', kind: null, state: 'pending', loop: null, starts: 0, durationMs: null, reached: false }
      ])
      // An attention wait is a question, which the answer block shows: it is not a waiting state here.
      assert.equal(detail.waiting, null)
    })

    test(`a run that ${release} no longer has is gone`, async () => {
      const stage = connectedScene(release)
      stage.archon.answer(`${RUN_PATH}orchon-recorder-no-such-run`, recorded(release, 'run-unknown'))
      const answer = await readDetail(stage, { runId: 'orchon-recorder-no-such-run' })
      assert.deepEqual(answer.run, { kind: 'gone' })
    })
  }
})

/** The floor's recorded run detail, as Archon sent it, to build other runs from. */
function recordedBody(): { run: Record<string, unknown>; events: Record<string, unknown>[] } {
  const answer = recorded('0.12.1', 'run-detail')
  if (answer.kind !== 'json') throw new Error('The recorded run detail is not JSON.')
  return structuredClone(answer.value) as { run: Record<string, unknown>; events: Record<string, unknown>[] }
}

const FLOOR_ID = RECORDED['0.12.1'].id

/** The recorded start and end of the floor's one step, renamed, with the end's duration set. */
function stepEvents(step: string, durationMs?: number): Record<string, unknown>[] {
  const body = recordedBody()
  const started = body.events.find((event) => event['event_type'] === 'node_started')
  const completed = body.events.find((event) => event['event_type'] === 'node_completed')
  if (started === undefined || completed === undefined) throw new Error('The recorded run has no step events.')
  const data = completed['data'] as { timing: Record<string, unknown>; duration_ms: unknown }
  if (durationMs !== undefined) {
    data.timing['durationMs'] = durationMs
    data.duration_ms = durationMs
  }
  return [
    { ...started, step_name: step },
    { ...completed, step_name: step }
  ]
}

type RunChange = {
  status?: string
  nodes?: unknown[]
  events?: unknown[]
  metadata?: Record<string, unknown>
  run?: Record<string, unknown>
}

/** The floor's recorded run with its status, nodes, events, metadata or other fields changed. */
function runWith(change: RunChange): { run: Record<string, unknown>; events: Record<string, unknown>[] } {
  const body = recordedBody()
  if (change.status !== undefined) body.run['status'] = change.status
  if (change.nodes !== undefined) body.run['nodes'] = change.nodes
  if (change.events !== undefined) body.events = change.events as Record<string, unknown>[]
  if (change.metadata !== undefined) body.run['metadata'] = { ...(body.run['metadata'] as object), ...change.metadata }
  Object.assign(body.run, change.run ?? {})
  return body
}

async function readFloor(stage: Scene, body: unknown, request: Partial<RunDetailRequest> = {}): Promise<RunDetail> {
  stage.archon.answer(`${RUN_PATH}${FLOOR_ID}`, json(body))
  return ready(await readDetail(stage, { runId: FLOOR_ID, ...request }))
}

const node = (id: string, state: string): Record<string, string> => ({ node_id: id, state })

describe('the step list', () => {
  test("orders steps by first start, nests a loop's inner steps under it, and puts the steps not reached last in Archon's order", async () => {
    const stage = connectedScene()
    const body = runWith({
      status: 'running',
      nodes: [
        node('plan', 'completed'),
        node('review', 'pending'),
        node('implement', 'running'),
        node('implement.test', 'completed'),
        node('implement.build', 'completed'),
        node('implement.lint', 'pending'),
        node('ship', 'pending'),
        node('setup', 'completed')
      ],
      events: [
        ...stepEvents('setup', 1_000),
        ...stepEvents('plan', 2_000),
        stepEvents('implement')[0],
        ...stepEvents('implement.build', 3_000),
        ...stepEvents('implement.test', 4_000),
        ...stepEvents('implement.build', 5_000)
      ]
    })
    const detail = await readFloor(stage, body)
    assert.deepEqual(
      detail.steps.map((step) => [step.id, step.name, step.loop, step.starts, step.durationMs, step.reached]),
      [
        ['setup', 'setup', null, 1, 1_000, true],
        ['plan', 'plan', null, 1, 2_000, true],
        ['implement', 'implement', null, 1, null, true],
        ['implement.build', 'build', 'implement', 2, 5_000, true],
        ['implement.test', 'test', 'implement', 1, 4_000, true],
        ['implement.lint', 'lint', 'implement', 0, null, false],
        ['review', 'review', null, 0, null, false],
        ['ship', 'ship', null, 0, null, false]
      ]
    )
    assert.equal(detail.stepCount, 8)
  })

  test('stops at 500 steps and says how many the run has', async () => {
    const stage = connectedScene()
    const nodes = Array.from({ length: 640 }, (_, index) => node(`step-${String(index)}`, 'pending'))
    const detail = await readFloor(stage, runWith({ nodes, events: [] }))
    assert.equal(detail.steps.length, 500)
    assert.equal(detail.steps.at(-1)?.id, 'step-499')
    assert.equal(detail.stepCount, 640)
  })

  test('drops and counts a step it cannot read', async () => {
    const stage = connectedScene()
    const nodes = [node('write', 'completed'), { node_id: '', state: 'completed' }, node('later', 'thinking'), 'write']
    const detail = await readFloor(stage, runWith({ nodes }))
    assert.deepEqual(
      detail.steps.map((step) => step.id),
      ['write']
    )
    assert.equal(detail.unreadableSteps, 3)
  })
})

describe('what run detail carries', () => {
  test('cuts the launch message at 2,000 characters and says so', async () => {
    const stage = connectedScene()
    const detail = await readFloor(stage, runWith({ run: { user_message: `${'a'.repeat(1_999)}bc` } }))
    assert.equal(detail.message, `${'a'.repeat(1_999)}b`)
    assert.equal(detail.messageCut, true)
  })

  test('keeps a message of exactly 2,000 characters whole', async () => {
    const stage = connectedScene()
    const detail = await readFloor(stage, runWith({ run: { user_message: 'x'.repeat(2_000) } }))
    assert.equal(detail.message.length, 2_000)
    assert.equal(detail.messageCut, false)
  })

  test("reads the run's cost", async () => {
    const stage = connectedScene()
    const detail = await readFloor(stage, runWith({ metadata: { total_cost_usd: 1.25 } }))
    assert.equal(detail.costUsd, 1.25)
  })

  test("answers a run of about 1 MB within Orca's relay limits, without artifacts, payloads or output", async () => {
    const stage = connectedScene()
    const body = runWith({})
    const record = body.run['terminal_record'] as { artifacts: { files: unknown[] } }
    record.artifacts.files = Array.from({ length: 6_000 }, (_, index) => ({ path: `coverage/lcov-report/file-${String(index)}.html`, size: index }))
    const output = 'output line\n'.repeat(20_000)
    body.events = body.events.map((event) => ({ ...event, data: { ...(event['data'] as object), node_output: output } }))
    const raw = JSON.stringify(body)
    assert.ok(raw.length > 1_000_000, `the raw detail is ${String(raw.length)} characters`)
    const answer = JSON.stringify(await readFloor(stage, body))
    assert.ok(answer.length < 8 * 1024, `the answer is ${String(answer.length)} characters`)
    assert.equal(/coverage|output line|artifacts|node_output/.test(answer), false)
  })

  test("says it could not read Archon's answer when the run lacks what run detail needs", async () => {
    const stage = connectedScene()
    stage.archon.answer(`${RUN_PATH}${FLOOR_ID}`, json({ run: { id: FLOOR_ID, status: 'completed' } }))
    const answer = await readDetail(stage, { runId: FLOOR_ID })
    assert.equal(answer.run.kind, 'failed')
    assert.match(answer.run.kind === 'failed' ? answer.run.message : '', /could not read Archon's answer/)
  })

  test('encodes the run id in the path', async () => {
    const stage = connectedScene()
    await readDetail(stage, { runId: 'a/b c' })
    assert.ok(urls(stage).includes(`${RUN_PATH}a%2Fb%20c`))
  })

  test('refuses a request with no run id, an empty or overlong one, a wrong open or another key', async () => {
    const stage = connectedScene()
    const { worker } = await stage.mount()
    for (const input of [undefined, {}, { runId: '' }, { runId: 'x'.repeat(201) }, { runId: 'r', open: 'yes' }, { runId: 'r', rows: 5 }]) {
      await assert.rejects(worker.request('run.read', input as RunDetailRequest), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
  })
})

describe('what a run waits for', () => {
  test('a time wait carries the time it waits until', async () => {
    const stage = connectedScene()
    const wait = { owner: 'node', nodeId: 'write', kind: 'time', waitingSince: '2026-11-19T01:00:00.000Z', resumeAt: '2026-11-19T03:30:00.000Z' }
    const detail = await readFloor(stage, runWith({ status: 'paused', metadata: { wait } }))
    assert.deepEqual(detail.waiting, { kind: 'time', until: Date.UTC(2026, 10, 19, 3, 30) })
  })

  test('an event wait names the event and its latest time', async () => {
    const stage = connectedScene()
    const wait = { owner: 'node', nodeId: 'write', kind: 'event', event: 'deploy-done', waitingSince: '2026-11-19T01:00:00.000Z', resumeAt: '2026-11-20T01:00:00.000Z' }
    const detail = await readFloor(stage, runWith({ status: 'paused', metadata: { wait } }))
    assert.deepEqual(detail.waiting, { kind: 'event', event: 'deploy-done', until: Date.UTC(2026, 10, 20, 1) })
  })

  test('a time that does not parse is dropped and the wait kept', async () => {
    const stage = connectedScene()
    const wait = { kind: 'time', waitingSince: '2026-11-19T01:00:00.000Z', resumeAt: 'tomorrow' }
    const detail = await readFloor(stage, runWith({ status: 'paused', metadata: { wait } }))
    assert.deepEqual(detail.waiting, { kind: 'time', until: null })
  })

  test('a run that has ended waits for nothing', async () => {
    const stage = connectedScene()
    const wait = { kind: 'time', waitingSince: '2026-11-19T01:00:00.000Z', resumeAt: '2026-11-19T03:30:00.000Z' }
    const detail = await readFloor(stage, runWith({ status: 'completed', metadata: { wait } }))
    assert.equal(detail.waiting, null)
  })
})

describe('the sub-runs a parent waits on', () => {
  const CHILDREN = Array.from({ length: 23 }, (_, index) => `child-${String(index)}`)
  const blocked = (ids: string[]) =>
    runWith({ status: 'paused', run: { attention: { kind: 'blocked_on_children', runId: FLOOR_ID, nodeId: 'write', childRunIds: ids } } })

  /** Archon answering each sub-run as the recorded run with its id, a workflow named for it and a status. */
  function answerChildren(stage: Scene): void {
    CHILDREN.forEach((id, index) => {
      const child = runWith({ status: index % 2 === 0 ? 'running' : 'failed', run: { id, workflow_name: `flow-${String(index)}` } })
      stage.archon.answer(`${RUN_PATH}${id}`, json(child))
    })
  }

  const childCalls = (stage: Scene): number => urls(stage).filter((url) => url.startsWith(`${RUN_PATH}child-`)).length

  test('lists the first 20 with their workflow and state, then how many more', async () => {
    const stage = connectedScene()
    answerChildren(stage)
    const detail = await readFloor(stage, blocked(CHILDREN), { open: true })
    assert.equal(detail.waiting?.kind, 'children')
    if (detail.waiting?.kind !== 'children') return
    assert.equal(detail.waiting.children.length, 20)
    assert.deepEqual(detail.waiting.children.slice(0, 2), [
      { id: 'child-0', workflow: 'flow-0', status: 'running' },
      { id: 'child-1', workflow: 'flow-1', status: 'failed' }
    ])
    assert.equal(detail.waiting.more, 3)
    assert.equal(childCalls(stage), 20)
  })

  test('a parent blocked on one sub-run lists it', async () => {
    const stage = connectedScene()
    answerChildren(stage)
    const body = runWith({ status: 'paused', run: { attention: { kind: 'blocked_on_child', runId: FLOOR_ID, nodeId: 'write', childRunId: 'child-4' } } })
    const detail = await readFloor(stage, body, { open: true })
    assert.deepEqual(detail.waiting, { kind: 'children', children: [{ id: 'child-4', workflow: 'flow-4', status: 'running' }], more: 0 })
  })

  test('a sub-run that cannot be looked up keeps its row with its id only', async () => {
    const stage = connectedScene()
    stage.archon.answer(`${RUN_PATH}child-0`, recorded('0.12.1', 'run-unknown'))
    const detail = await readFloor(stage, blocked(['child-0']), { open: true })
    assert.deepEqual(detail.waiting, { kind: 'children', children: [{ id: 'child-0', workflow: null, status: null }], more: 0 })
  })

  test('looks the sub-runs up when run detail opens and on the 30 second refetch, not on every read', async () => {
    const stage = connectedScene()
    answerChildren(stage)
    stage.archon.answer(`${RUN_PATH}${FLOOR_ID}`, json(blocked(CHILDREN)))
    const { worker } = await stage.mount()
    await worker.request('run.read', { runId: FLOOR_ID, open: true })
    assert.equal(childCalls(stage), 20)
    await stage.clock.advance(5_000)
    const hinted = ready((await worker.request('run.read', { runId: FLOOR_ID })) as RunDetailAnswer)
    assert.equal(childCalls(stage), 20)
    assert.equal(hinted.waiting?.kind === 'children' ? hinted.waiting.children[3]?.workflow : undefined, 'flow-3')
    await stage.clock.advance(25_000)
    await worker.request('run.read', { runId: FLOOR_ID })
    assert.equal(childCalls(stage), 40)
    await worker.request('run.read', { runId: FLOOR_ID, open: true })
    assert.equal(childCalls(stage), 60)
  })
})

describe("the run's project", () => {
  const codebaseCalls = (stage: Scene): number => urls(stage).filter((url) => url === CODEBASES).length

  test("names the project from Archon's list, read on open and then at most every 30 seconds", async () => {
    const stage = connectedScene()
    stage.archon.answer(`${RUN_PATH}${FLOOR_ID}`, recorded('0.12.1', 'run-detail'))
    const { worker } = await stage.mount()
    const before = codebaseCalls(stage)
    await worker.request('run.read', { runId: FLOOR_ID, open: true })
    await worker.request('run.read', { runId: FLOOR_ID })
    assert.equal(codebaseCalls(stage) - before, 1)
    await stage.clock.advance(30_000)
    const later = ready((await worker.request('run.read', { runId: FLOOR_ID })) as RunDetailAnswer)
    assert.equal(codebaseCalls(stage) - before, 2)
    assert.equal(later.project, 'orchon-recorder/throwaway-project')
  })

  test('a project Archon no longer lists has no name', async () => {
    const stage = connectedScene()
    stage.archon.answer(CODEBASES, recorded('0.12.1', 'codebases-empty'))
    const detail = await readFloor(stage, runWith({}), { open: true })
    assert.equal(detail.project, null)
  })

  test('a run with no project asks for no list', async () => {
    const stage = connectedScene()
    const { worker } = await stage.mount()
    stage.archon.answer(`${RUN_PATH}${FLOOR_ID}`, json(runWith({ run: { codebase_id: null } })))
    const before = codebaseCalls(stage)
    const detail = ready((await worker.request('run.read', { runId: FLOOR_ID, open: true })) as RunDetailAnswer)
    assert.equal(detail.project, null)
    assert.equal(codebaseCalls(stage), before)
  })
})
