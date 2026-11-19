// The worker's request protocol seam for answering a question: the worker mounted on a scripted
// Archon, which replays the recorded gate and attention wait, and the recorded `respond` and
// `answer` exchanges of each supported release. These tests cover the question run detail
// carries, what the worker refuses before asking Archon, the guarded body it sends, and the
// outcome it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import { DEFAULT, DEFAULT_HEALTH, health, recorded, RELEASES, scene, settle, type Release, type Scene } from '../scripts/scripted-archon.ts'
import { field } from '../scripts/shape.ts'
import type { RunAnswerRequest } from './run-answer-view'
import type { RunControlAnswer } from './run-control-view'
import type { RunDetail, RunDetailAnswer } from './run-detail-view'

const RUN_PATH = `${DEFAULT}/api/workflows/runs/`

function connectedScene(release: Release): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(`${DEFAULT}/api/codebases`, recorded(release, 'codebases', 1))
  return stage
}

const logOf = (release: Release, scenario: string): unknown[] =>
  field(JSON.parse(readRepoText(`fixtures/${release}/${scenario}.json`)), 'log') as unknown[]

/** The index of the recorded GET of the run in a scenario, and the run it holds. */
function runRead(release: Release, scenario: string): { index: number; run: unknown } {
  for (const [index, entry] of logOf(release, scenario).entries()) {
    const path = field(entry, 'path')
    if (field(entry, 'method') === 'GET' && typeof path === 'string' && path.startsWith('/api/workflows/runs/')) {
      return { index, run: field(field(entry, 'body'), 'run') }
    }
  }
  throw new Error(`fixtures/${release}/${scenario}.json holds no read of a run.`)
}

/** Every recorded POST to `action` in a scenario: where it sits, the run and the body sent. */
function posts(release: Release, scenario: string, action: string): { index: number; runId: string; requestBody: unknown }[] {
  const found: { index: number; runId: string; requestBody: unknown }[] = []
  for (const [index, entry] of logOf(release, scenario).entries()) {
    const path = field(entry, 'path')
    if (field(entry, 'method') !== 'POST' || typeof path !== 'string') continue
    const match = /^\/api\/workflows\/runs\/([^/]+)\/([a-z]+)$/.exec(path)
    if (match?.[2] === action) found.push({ index, runId: decodeURIComponent(match[1] ?? ''), requestBody: field(entry, 'requestBody') })
  }
  return found
}

const ready = (answer: RunDetailAnswer): RunDetail => {
  if (answer.run.kind !== 'ready') throw new Error(`The run read was ${answer.run.kind}.`)
  return answer.run.detail
}

describe('the question run detail carries', () => {
  for (const release of RELEASES) {
    test(`the recorded gate of ${release} is a gate question with approve and reject`, async () => {
      const stage = connectedScene(release)
      const { index, run } = runRead(release, 'attention-gate')
      const runId = String(field(run, 'id'))
      const pauseId = field(field(field(run, 'metadata'), 'approval'), 'pauseId')
      stage.archon.answer(`${RUN_PATH}${runId}`, recorded(release, 'attention-gate', index))
      const { worker } = await stage.mount()
      const detail = ready((await worker.request('run.read', { runId })) as RunDetailAnswer)
      assert.deepEqual(detail.question, {
        kind: 'gate',
        nodeId: 'gate',
        pauseId,
        message: 'Recorded gate: approve to go on.',
        messageCut: false,
        decisions: [
          { id: 'approve', label: null },
          { id: 'reject', label: null }
        ],
        authored: false,
        completionSignaled: false
      })
      assert.equal(detail.waiting, null)
    })
  }
})

describe('the question run detail carries, for an attention wait', () => {
  for (const release of RELEASES) {
    test(`the recorded wait of ${release} is a select with its two options and nothing recommended`, async () => {
      const stage = connectedScene(release)
      const { index, run } = runRead(release, 'attention-wait')
      const runId = String(field(run, 'id'))
      const occurrence = field(field(run, 'attention'), 'occurrence')
      stage.archon.answer(`${RUN_PATH}${runId}`, recorded(release, 'attention-wait', index))
      const { worker } = await stage.mount()
      const detail = ready((await worker.request('run.read', { runId })) as RunDetailAnswer)
      assert.deepEqual(detail.question, {
        kind: 'wait',
        nodeId: 'ask',
        occurrence,
        form: 'select',
        message: 'Recorded question: pick one.',
        messageCut: false,
        options: [
          { id: 'first', label: 'The first option', does: null },
          { id: 'second', label: 'The second option', does: null }
        ],
        moreOptions: 0,
        recommendation: null
      })
    })
  }
})

/** Mounts the worker on a release's recorded gate and reads it, as run detail does before an answer. */
async function atGate(release: Release, change: (run: Record<string, unknown>) => void = () => undefined) {
  const stage = connectedScene(release)
  const { index, run } = runRead(release, 'attention-gate')
  const runId = String(field(run, 'id'))
  const read = recorded(release, 'attention-gate', index)
  if (read.kind !== 'json') throw new Error('The recorded gate is not JSON.')
  const body = structuredClone(read.value) as { run: Record<string, unknown> }
  change(body.run)
  stage.archon.answer(`${RUN_PATH}${runId}`, { ...read, value: body })
  const mounted = await stage.mount()
  const detail = ready((await mounted.worker.request('run.read', { runId })) as RunDetailAnswer)
  return { stage, worker: mounted.worker, runId, detail }
}

/** Mounts the worker on a release's recorded attention wait and reads it. */
async function atWait(release: Release) {
  const stage = connectedScene(release)
  const { index, run } = runRead(release, 'attention-wait')
  const runId = String(field(run, 'id'))
  stage.archon.answer(`${RUN_PATH}${runId}`, recorded(release, 'attention-wait', index))
  const mounted = await stage.mount()
  const detail = ready((await mounted.worker.request('run.read', { runId })) as RunDetailAnswer)
  return { stage, worker: mounted.worker, runId, detail }
}

const writes = (stage: Scene) => stage.archon.calls.filter((call) => call.method === 'POST')
const sentBody = (stage: Scene, nth = 0): unknown => {
  const body = writes(stage)[nth]?.body
  return body === undefined ? undefined : JSON.parse(body)
}

const gateIdentity = (detail: RunDetail): { nodeId: string; pauseId?: string } => {
  const question = detail.question
  if (question?.kind !== 'gate') throw new Error('The run is not at a gate.')
  return question.pauseId === null ? { nodeId: question.nodeId } : { nodeId: question.nodeId, pauseId: question.pauseId }
}

describe('replaying the recorded respond exchanges', () => {
  for (const release of RELEASES) {
    test(`approve with a comment on the gate of ${release} sends the recorded guarded body and shows Archon's message`, async () => {
      const { stage, worker, runId, detail } = await atGate(release)
      const exchange = posts(release, 'respond', 'respond').find((post) => field(post.requestBody, 'text') !== undefined)
      if (exchange === undefined) throw new Error('No recorded approval with text.')
      stage.archon.answer(`${RUN_PATH}${runId}/respond`, recorded(release, 'respond', exchange.index))
      const request: RunAnswerRequest = { runId, kind: 'gate', ...gateIdentity(detail), decision: 'approve', text: '  Recorded approval.\n' }
      const answer = (await worker.request('run.answer', request)) as RunControlAnswer
      assert.equal(writes(stage).length, 1)
      assert.equal(writes(stage)[0]?.url, `${RUN_PATH}${runId}/respond`)
      assert.deepEqual(sentBody(stage), exchange.requestBody)
      assert.deepEqual(answer.outcome, { kind: 'done', message: "Workflow responded 'approve': orchon-recorder-gate. The run continues on its own." })
    })
  }
})

const isInvalid = (error: unknown): boolean => (error as { code?: string }).code === 'invalid_params'
const STALE = 'Orchon has not read this question as it stands now, so nothing was sent. The run was read again: check the question and answer again.'
const MOVED_ON = /^Workflow run .* was already resolved or is no longer paused at the expected gate\./

describe('replaying the recorded stale answers and refusals', () => {
  for (const release of RELEASES) {
    test(`a gate of ${release} with no pause id is guarded by its node id string, and the recorded 409 is a refusal sent once`, async () => {
      const { stage, worker, runId, detail } = await atGate(release, (run) => {
        const approval = (run.metadata as { approval: Record<string, unknown> }).approval
        delete approval.pauseId
      })
      assert.deepEqual(gateIdentity(detail), { nodeId: 'gate' })
      const exchange = posts(release, 'respond', 'respond').find((post) => field(post.requestBody, 'expectedGate') === 'gate')
      if (exchange === undefined) throw new Error('No recorded respond guarded by the node id string.')
      stage.archon.answer(`${RUN_PATH}${runId}/respond`, recorded(release, 'respond', exchange.index))
      const answer = (await worker.request('run.answer', { runId, kind: 'gate', nodeId: 'gate', decision: 'approve' })) as RunControlAnswer
      assert.deepEqual(sentBody(stage), exchange.requestBody)
      assert.equal(writes(stage).length, 1)
      assert.ok(answer.outcome.kind === 'refused' && answer.outcome.status === 409 && MOVED_ON.test(answer.outcome.message))
    })

    test(`a gate of ${release} that moved on before the write gets the recorded 409 for the object guard`, async () => {
      const { stage, worker, runId, detail } = await atGate(release)
      const exchange = posts(release, 'respond', 'respond').find((post) => typeof field(post.requestBody, 'expectedGate') === 'object')
      if (exchange === undefined) throw new Error('No recorded respond guarded by an object.')
      stage.archon.answer(`${RUN_PATH}${runId}/respond`, recorded(release, 'respond', exchange.index))
      const answer = (await worker.request('run.answer', { runId, kind: 'gate', ...gateIdentity(detail), decision: 'approve' })) as RunControlAnswer
      assert.deepEqual(sentBody(stage), { decision: 'approve', expectedGate: gateIdentity(detail) })
      assert.ok(answer.outcome.kind === 'refused' && answer.outcome.status === 409 && MOVED_ON.test(answer.outcome.message))
    })

    test(`approving the gate of ${release} again is the recorded 400, not a 409`, async () => {
      const { stage, worker, runId, detail } = await atGate(release)
      const again = posts(release, 'respond', 'respond').at(-1)
      if (again === undefined) throw new Error('No recorded respond.')
      stage.archon.answer(`${RUN_PATH}${runId}/respond`, recorded(release, 'respond', again.index))
      const answer = (await worker.request('run.answer', { runId, kind: 'gate', ...gateIdentity(detail), decision: 'approve' })) as RunControlAnswer
      assert.deepEqual(sentBody(stage), again.requestBody)
      assert.deepEqual(answer.outcome, { kind: 'refused', status: 400, message: 'Workflow run was already approved — resume in progress' })
    })

    test(`a decision the gate of ${release} does not offer, and another gate's ids, are refused as stale without asking Archon`, async () => {
      const { stage, worker, runId, detail } = await atGate(release)
      const identity = gateIdentity(detail)
      const bad: RunAnswerRequest[] = [
        { runId, kind: 'gate', ...identity, decision: 'orchon-recorder-no-such-decision' },
        { runId, kind: 'gate', nodeId: 'orchon-recorder-other-step', ...(identity.pauseId === undefined ? {} : { pauseId: identity.pauseId }), decision: 'approve' },
        { runId, kind: 'gate', nodeId: identity.nodeId, pauseId: 'orchon-recorder-other-pause', decision: 'approve' },
        { runId, kind: 'gate', nodeId: identity.nodeId, decision: 'approve' },
        { runId, kind: 'wait', occurrence: identity.pauseId ?? '', choose: ['approve'] }
      ]
      for (const request of bad) {
        const answer = (await worker.request('run.answer', request)) as RunControlAnswer
        assert.deepEqual(answer.outcome, { kind: 'refused', status: null, message: STALE }, JSON.stringify(request))
      }
      assert.equal(writes(stage).length, 0)
    })
  }
})

describe('replaying the recorded answer exchanges', () => {
  for (const release of RELEASES) {
    test(`choosing an option with a comment on the wait of ${release} sends the recorded body and shows Archon's message`, async () => {
      const { stage, worker, runId, detail } = await atWait(release)
      const exchange = posts(release, 'answer', 'answer').find((post) => field(post.requestBody, 'text') !== undefined)
      if (exchange === undefined || detail.question?.kind !== 'wait') throw new Error('No recorded answer with text.')
      stage.archon.answer(`${RUN_PATH}${runId}/answer`, recorded(release, 'answer', exchange.index))
      const answer = (await worker.request('run.answer', {
        runId,
        kind: 'wait',
        occurrence: detail.question.occurrence,
        choose: ['first'],
        text: 'Recorded answer. '
      })) as RunControlAnswer
      assert.equal(writes(stage)[0]?.url, `${RUN_PATH}${runId}/answer`)
      assert.deepEqual(sentBody(stage), exchange.requestBody)
      assert.deepEqual(answer.outcome, { kind: 'done', message: 'Workflow answered: orchon-recorder-gate. The run continues on its own.' })
    })

    test(`answering the wait of ${release} again is the recorded 409, with no text in the body`, async () => {
      const { stage, worker, runId, detail } = await atWait(release)
      const again = posts(release, 'answer', 'answer').at(-1)
      if (again === undefined || detail.question?.kind !== 'wait') throw new Error('No recorded answer.')
      stage.archon.answer(`${RUN_PATH}${runId}/answer`, recorded(release, 'answer', again.index))
      const answer = (await worker.request('run.answer', { runId, kind: 'wait', occurrence: detail.question.occurrence, choose: ['first'], text: '   ' })) as RunControlAnswer
      assert.deepEqual(sentBody(stage), again.requestBody)
      assert.ok(answer.outcome.kind === 'refused' && answer.outcome.status === 409 && MOVED_ON.test(answer.outcome.message))
    })

    test(`an unknown option, no choice, two choices and another occurrence on the wait of ${release} are refused without asking Archon`, async () => {
      const { stage, worker, runId, detail } = await atWait(release)
      if (detail.question?.kind !== 'wait') throw new Error('The run is not at a wait.')
      const { occurrence } = detail.question
      const bad: RunAnswerRequest[] = [
        { runId, kind: 'wait', occurrence, choose: ['orchon-recorder-no-such-option'] },
        { runId, kind: 'wait', occurrence, choose: [] },
        { runId, kind: 'wait', occurrence, choose: ['first', 'second'] },
        { runId, kind: 'wait', occurrence, choose: ['first', 'first'] },
        { runId, kind: 'wait', occurrence: 'orchon-recorder-other-occurrence', choose: ['first'] },
        { runId, kind: 'gate', nodeId: 'ask', pauseId: occurrence, decision: 'approve' }
      ]
      for (const request of bad) {
        const answer = (await worker.request('run.answer', request)) as RunControlAnswer
        assert.deepEqual(answer.outcome, { kind: 'refused', status: null, message: STALE }, JSON.stringify(request))
      }
      assert.equal(writes(stage).length, 0)
    })
  }
})

describe("the worker's checks on an answer", () => {
  test('an answer for a run the worker has not read, as after a restart, is refused as stale without asking Archon', async () => {
    const stage = connectedScene('0.12.1')
    const { worker } = await stage.mount()
    const answer = (await worker.request('run.answer', { runId: 'run-1', kind: 'gate', nodeId: 'gate', decision: 'approve' })) as RunControlAnswer
    assert.deepEqual(answer.outcome, { kind: 'refused', status: null, message: STALE })
    assert.equal(writes(stage).length, 0)
  })

  test('text of 10,000 characters is taken, trimmed; text past that, and malformed requests, are refused before anything is sent', async () => {
    const { stage, worker, runId, detail } = await atGate('0.12.1')
    const identity = gateIdentity(detail)
    stage.archon.answer(`${RUN_PATH}${runId}/respond`, { kind: 'json', value: { success: true, message: 'ok' }, status: 200 })
    const bad: unknown[] = [
      { runId, kind: 'gate', ...identity, decision: 'approve', text: 'x'.repeat(10_001) },
      { runId, kind: 'gate', ...identity, decision: 'approve', text: 7 },
      { runId, kind: 'gate', ...identity, decision: '' },
      { runId, kind: 'gate', ...identity },
      { runId, kind: 'gate', ...identity, decision: 'approve', expectedGate: 'gate' },
      { runId, kind: 'gate', ...identity, decision: 'approve', choose: [] },
      { runId, kind: 'approve', decision: 'approve' },
      { runId: '../health', kind: 'gate', ...identity, decision: 'approve' },
      { runId, kind: 'wait', occurrence: 'o', choose: 'first' },
      { runId, kind: 'wait', occurrence: 'o', choose: [''] },
      { runId, kind: 'wait', choose: ['first'] },
      null
    ]
    for (const input of bad) await assert.rejects(worker.request('run.answer', input as never), isInvalid)
    assert.equal(writes(stage).length, 0)
    const text = ` ${'y'.repeat(9_998)} `
    const answer = (await worker.request('run.answer', { runId, kind: 'gate', ...identity, decision: 'reject', text })) as RunControlAnswer
    assert.deepEqual(answer.outcome, { kind: 'done', message: 'ok' })
    assert.deepEqual(sentBody(stage), { decision: 'reject', text: 'y'.repeat(9_998), expectedGate: identity })
  })

  test('one write per run: an answer while a cancel is in flight is refused without asking Archon', async () => {
    const { stage, worker, runId, detail } = await atGate('0.12.1')
    stage.archon.answer(`${RUN_PATH}${runId}/cancel`, { kind: 'hang' })
    const cancel = worker.request('run.control', { runId, action: 'cancel' }) as Promise<RunControlAnswer>
    await settle()
    const answer = (await worker.request('run.answer', { runId, kind: 'gate', ...gateIdentity(detail), decision: 'approve' })) as RunControlAnswer
    assert.ok(answer.outcome.kind === 'refused' && answer.outcome.status === null && answer.outcome.message !== STALE)
    await stage.clock.advance(30_000)
    assert.equal((await cancel).outcome.kind, 'timeout')
    assert.deepEqual(writes(stage).map((call) => call.url), [`${RUN_PATH}${runId}/cancel`])
  })

  test('a run that moved on to no question is refused as stale; while not connected nothing is sent', async () => {
    const { stage, worker, runId, detail } = await atGate('0.12.1')
    const identity = gateIdentity(detail)
    stage.archon.answer(`${RUN_PATH}${runId}`, recorded('0.12.1', 'run-detail'))
    await worker.request('run.read', { runId })
    const answer = (await worker.request('run.answer', { runId, kind: 'gate', ...identity, decision: 'approve' })) as RunControlAnswer
    assert.deepEqual(answer.outcome, { kind: 'refused', status: null, message: STALE })
    const away = scene()
    const { worker: offline } = await away.mount()
    const off = (await offline.request('run.answer', { runId, kind: 'gate', ...identity, decision: 'approve' })) as RunControlAnswer
    assert.deepEqual(off.outcome, { kind: 'not-connected' })
    assert.equal(writes(stage).length + writes(away).length, 0)
  })
})
