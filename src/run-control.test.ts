// The worker's request protocol seam for run control: the worker mounted on a scripted Archon,
// which replays the recorded cancel, abandon and resume answers. These tests cover what the
// worker asks Archon, what it refuses before asking, and the outcome it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import { DEFAULT, DEFAULT_HEALTH, HANG, health, html, json, recorded, RELEASES, scene, settle, type Release, type Scene } from '../scripts/scripted-archon.ts'
import { field } from '../scripts/shape.ts'
import type { RunControlAnswer, RunControlRequest } from './run-control-view'

const RUN_PATH = `${DEFAULT}/api/workflows/runs/`

function connectedScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  return stage
}

/** A recorded run-control exchange: where it sits in the log, the run it was sent to and what was sent. */
type Exchange = { index: number; runId: string; requestBody: unknown }

/**
 * The `nth` POST to `action` in a recorded scenario, found by reading the log, so the indexes
 * and run ids come from the recording and are never typed.
 */
function exchange(release: Release, scenario: string, action: string, nth = 0): Exchange {
  const log = field(JSON.parse(readRepoText(`fixtures/${release}/${scenario}.json`)), 'log') as unknown[]
  let seen = 0
  for (const [index, entry] of log.entries()) {
    const path = field(entry, 'path')
    if (field(entry, 'method') !== 'POST' || typeof path !== 'string') continue
    const match = /^\/api\/workflows\/runs\/([^/]+)\/([a-z]+)$/.exec(path)
    if (match === null || match[2] !== action) continue
    if (seen === nth) return { index, runId: decodeURIComponent(match[1] ?? ''), requestBody: field(entry, 'requestBody') }
    seen += 1
  }
  throw new Error(`fixtures/${release}/${scenario}.json holds no POST ${action} number ${String(nth)}.`)
}

async function control(stage: Scene, input: RunControlRequest): Promise<RunControlAnswer> {
  const { worker } = await stage.mount()
  return (await worker.request('run.control', input)) as RunControlAnswer
}

/** Scripts the recorded answer and sends the same action as the panel would. */
async function replay(release: Release, scenario: string, action: RunControlRequest['action'], nth = 0) {
  const stage = connectedScene(release)
  const sent = exchange(release, scenario, action, nth)
  stage.archon.answer(`${RUN_PATH}${sent.runId}/${action}`, recorded(release, scenario, sent.index))
  const answer = await control(stage, { runId: sent.runId, action })
  const writes = stage.archon.calls.filter((call) => call.method === 'POST')
  return { answer, writes, sent }
}

describe('replaying the recorded run-control answers', () => {
  for (const release of RELEASES) {
    test(`cancel on the running run of ${release} sends no body and shows Archon's message`, async () => {
      const { answer, writes, sent } = await replay(release, 'run-control-running', 'cancel')
      assert.equal(writes.length, 1)
      assert.equal(writes[0]?.url, `${RUN_PATH}${sent.runId}/cancel`)
      assert.equal(writes[0]?.body, undefined)
      assert.equal(sent.requestBody ?? undefined, undefined)
      assert.deepEqual(answer.outcome, { kind: 'done', message: 'Cancelled workflow: orchon-recorder-slow' })
    })
  }
})

const ABANDONED_RUNNING = 'Cannot abandon run with status \'cancelled\'. Only running, paused, or failed runs can be abandoned.'
const CANCEL_NOT_RUNNING = (status: string): string =>
  `Cannot cancel run with status '${status}'. Only a running run has live work to stop; abandon a paused or failed run instead.`

describe('replaying the recorded refusals', () => {
  for (const release of RELEASES) {
    test(`cancel on the paused and the failed run of ${release} is refused with Archon's 400 and its text`, async () => {
      const paused = await replay(release, 'run-control-paused', 'cancel')
      assert.deepEqual(paused.answer.outcome, { kind: 'refused', status: 400, message: CANCEL_NOT_RUNNING('paused') })
      const failed = await replay(release, 'run-failed', 'cancel')
      assert.deepEqual(failed.answer.outcome, { kind: 'refused', status: 400, message: CANCEL_NOT_RUNNING('failed') })
    })

    test(`abandon on the cancelled run of ${release} is refused with Archon's 409, sent once`, async () => {
      const { answer, writes } = await replay(release, 'run-control-running', 'abandon')
      assert.equal(writes.length, 1)
      assert.deepEqual(answer.outcome, { kind: 'refused', status: 409, message: ABANDONED_RUNNING })
    })

    test(`every action on a run ${release} does not know answers gone`, async () => {
      for (const action of ['cancel', 'abandon', 'resume'] as const) {
        const { answer } = await replay(release, 'run-unknown', action)
        assert.deepEqual(answer.outcome, { kind: 'gone' }, action)
      }
    })
  }
})

describe('replaying the recorded successes', () => {
  for (const release of RELEASES) {
    test(`resume on the failed run of ${release} and abandon after it show Archon's messages`, async () => {
      const resumed = await replay(release, 'run-failed', 'resume')
      assert.deepEqual(resumed.answer.outcome, { kind: 'done', message: 'Resuming workflow: orchon-recorder-fail' })
      assert.equal(resumed.writes[0]?.body, undefined)
      const abandoned = await replay(release, 'run-failed', 'abandon')
      const recordedBody = recorded(release, 'run-failed', abandoned.sent.index)
      const message = recordedBody.kind === 'json' ? field(recordedBody.value, 'message') : undefined
      assert.equal(typeof message, 'string')
      assert.deepEqual(abandoned.answer.outcome, { kind: 'done', message })
      assert.ok(String(message).includes('Abandoned workflow: orchon-recorder-fail'))
    })

    test(`abandon on the paused run of ${release} shows Archon's message with its warnings`, async () => {
      const { answer } = await replay(release, 'run-control-paused', 'abandon')
      assert.equal(answer.outcome.kind, 'done')
      assert.ok(answer.outcome.kind === 'done' && answer.outcome.message.includes('warning: Retained checkout'))
    })
  }
})

const RUN = 'run_1-a'
const write = (action: string): string => `${RUN_PATH}${RUN}/${action}`

describe('outcomes Archon was not recorded giving', () => {
  test('a refusal naming a childRunId carries it, and server text is cut at 2,000 characters', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('resume'), json({ error: 'e'.repeat(2_500), childRunId: 'child-7' }, 409))
    const answer = await control(stage, { runId: RUN, action: 'resume' })
    assert.deepEqual(answer.outcome, { kind: 'refused', status: 409, message: 'e'.repeat(2_000), childRunId: 'child-7' })
  })

  test('a long success message is cut at 2,000 characters', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('cancel'), json({ success: true, message: 'm'.repeat(2_001) }))
    const answer = await control(stage, { runId: RUN, action: 'cancel' })
    assert.deepEqual(answer.outcome, { kind: 'done', message: 'm'.repeat(2_000) })
  })

  test('a 500 is a failure with the server text when there is some, and without when there is none', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('cancel'), json({ error: 'Database is locked' }, 500))
    stage.archon.answer(write('abandon'), html(500))
    const { worker } = await stage.mount()
    const cancel = (await worker.request('run.control', { runId: RUN, action: 'cancel' })) as RunControlAnswer
    const abandon = (await worker.request('run.control', { runId: RUN, action: 'abandon' })) as RunControlAnswer
    assert.deepEqual(cancel.outcome, { kind: 'failed', message: 'Database is locked' })
    assert.deepEqual(abandon.outcome, { kind: 'failed', message: null })
  })

  test('a 200 that is not the expected JSON, and a 400 with no error text, are failures', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('resume'), html(200))
    stage.archon.answer(write('cancel'), json({ nope: true }, 400))
    const { worker } = await stage.mount()
    const resume = (await worker.request('run.control', { runId: RUN, action: 'resume' })) as RunControlAnswer
    const cancel = (await worker.request('run.control', { runId: RUN, action: 'cancel' })) as RunControlAnswer
    assert.deepEqual(resume.outcome, { kind: 'failed', message: null })
    assert.deepEqual(cancel.outcome, { kind: 'failed', message: null })
  })

  test('a 4xx other than 400, 403, 404 and 409 is a failure, even with error text', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('cancel'), json({ error: 'Unprocessable' }, 422))
    stage.archon.answer(write('abandon'), json({ error: 'Too many requests' }, 429))
    const { worker } = await stage.mount()
    const cancel = (await worker.request('run.control', { runId: RUN, action: 'cancel' })) as RunControlAnswer
    const abandon = (await worker.request('run.control', { runId: RUN, action: 'abandon' })) as RunControlAnswer
    assert.deepEqual(cancel.outcome, { kind: 'failed', message: 'Unprocessable' })
    assert.deepEqual(abandon.outcome, { kind: 'failed', message: 'Too many requests' })
  })

  test('a 403 with error text is a refusal', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('cancel'), json({ error: 'Forbidden' }, 403))
    const answer = await control(stage, { runId: RUN, action: 'cancel' })
    assert.deepEqual(answer.outcome, { kind: 'refused', status: 403, message: 'Forbidden' })
  })

  test('a write Archon does not answer times out after 30 seconds and is not sent again', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('cancel'), HANG)
    const { worker } = await stage.mount()
    const pending = worker.request('run.control', { runId: RUN, action: 'cancel' }) as Promise<RunControlAnswer>
    await stage.clock.advance(29_999)
    let settled = false
    void pending.then(() => (settled = true))
    await settle()
    assert.equal(settled, false)
    await stage.clock.advance(1)
    assert.deepEqual((await pending).outcome, { kind: 'timeout', timeoutMs: 30_000 })
    await stage.clock.advance(60_000)
    assert.equal(stage.archon.calls.filter((call) => call.url === write('cancel')).length, 1)
  })
})

const isInvalid = (error: unknown): boolean => (error as { code?: string }).code === 'invalid_params'

describe("the worker's refusals", () => {
  test('a run id that is not 1 to 64 letters, digits, - and _ is refused, and nothing is sent', async () => {
    const stage = connectedScene()
    const { worker } = await stage.mount()
    const bad: unknown[] = ['', 'a'.repeat(65), '../health', 'run/1', 'run 1', 'run%2F1', 'run.1', 'rün', 7, null, undefined]
    for (const runId of bad) {
      await assert.rejects(worker.request('run.control', { runId, action: 'cancel' } as never), isInvalid)
    }
    assert.equal(stage.archon.calls.filter((call) => call.method === 'POST').length, 0)
  })

  test('a run id of 64 such characters is taken', async () => {
    const stage = connectedScene()
    const runId = `${'aZ09-_'.repeat(10)}abcd`
    stage.archon.answer(`${RUN_PATH}${runId}/cancel`, json({ success: true, message: 'ok' }))
    const answer = await control(stage, { runId, action: 'cancel' })
    assert.deepEqual(answer.outcome, { kind: 'done', message: 'ok' })
  })

  test('an action off the closed list, a missing one and an extra key are refused, and nothing is sent', async () => {
    const stage = connectedScene()
    const { worker } = await stage.mount()
    const bad: unknown[] = [
      { runId: RUN, action: 'delete' },
      { runId: RUN, action: 'approve' },
      { runId: RUN, action: 'toString' },
      { runId: RUN },
      { runId: RUN, action: 'cancel', decision: 'approve' },
      { runId: RUN, action: 'cancel', body: {} },
      [RUN, 'cancel'],
      null
    ]
    for (const input of bad) await assert.rejects(worker.request('run.control', input as never), isInvalid)
    assert.equal(stage.archon.calls.filter((call) => call.method === 'POST').length, 0)
  })

  test('one write per run at a time: a second while the first is in flight is refused without asking Archon', async () => {
    const stage = connectedScene()
    stage.archon.answer(write('cancel'), HANG)
    stage.archon.answer(`${RUN_PATH}other/resume`, json({ success: true, message: 'Resuming workflow: other' }))
    stage.archon.answer(write('abandon'), json({ success: true, message: 'Abandoned workflow: w' }))
    const { worker } = await stage.mount()
    const first = worker.request('run.control', { runId: RUN, action: 'cancel' }) as Promise<RunControlAnswer>
    await settle()
    const second = (await worker.request('run.control', { runId: RUN, action: 'abandon' })) as RunControlAnswer
    assert.equal(second.outcome.kind, 'refused')
    assert.ok(second.outcome.kind === 'refused' && second.outcome.status === null)
    const other = (await worker.request('run.control', { runId: 'other', action: 'resume' })) as RunControlAnswer
    assert.equal(other.outcome.kind, 'done')
    await stage.clock.advance(30_000)
    assert.deepEqual((await first).outcome, { kind: 'timeout', timeoutMs: 30_000 })
    const after = (await worker.request('run.control', { runId: RUN, action: 'abandon' })) as RunControlAnswer
    assert.equal(after.outcome.kind, 'done')
    assert.deepEqual(
      stage.archon.calls.filter((call) => call.method === 'POST').map((call) => call.url),
      [write('cancel'), `${RUN_PATH}other/resume`, write('abandon')]
    )
  })

  test('while not connected nothing is sent', async () => {
    const stage = scene()
    const answer = await control(stage, { runId: RUN, action: 'cancel' })
    assert.deepEqual(answer.outcome, { kind: 'not-connected' })
    assert.equal(stage.archon.calls.filter((call) => call.method === 'POST').length, 0)
  })
})
