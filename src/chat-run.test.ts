// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, and a stand-in Orca host. These tests cover Open run on a chat's dispatch
// row: the worker finds the run a dispatch started by the worker conversation it names.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Release, type Scripted } from '../scripts/scripted-archon.ts'
import type { ChatRunAnswer, ChatRunView } from './chat-run-view'

/** The worker conversation and the run each release's recorded dispatch names, read off the fixtures by hand. */
const RECORDED: Record<Release, { worker: string; runId: string }> = {
  '0.12.1': { worker: 'web-worker-1795050075790-mrmpg0', runId: '7c28e1a1-6432-4c9d-89d6-874cfaf81f89' },
  '0.13.2': { worker: 'web-worker-1795050194452-i06suv', runId: '542b1888-311b-4b65-b005-8b78e33a7c79' },
  '0.14.0': { worker: 'web-worker-1795050313338-bvgrg9', runId: '68b479b2-217a-4e84-b86d-ecb9faf394e6' }
}

const byWorker = (worker: string): string => `${DEFAULT}/api/workflows/runs/by-worker/${worker}`

async function find(release: Release, input: unknown, answers: [string, Scripted][] = []): Promise<{ view: ChatRunView; calls: string[] }> {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(byWorker(RECORDED[release].worker), recorded(release, 'run-by-worker'))
  for (const [url, answer] of answers) stage.archon.answer(url, answer)
  const mounted = await stage.mount({})
  try {
    const view = ((await mounted.worker.request('chat.findRun', input as never)) as ChatRunAnswer).run
    return { view, calls: stage.archon.calls.map((call) => call.url).filter((url) => url.includes('/by-worker/')) }
  } finally {
    await mounted.worker.deactivate()
  }
}

describe("a dispatch's run", () => {
  for (const release of RELEASES) {
    test(`${release}: is found by the worker conversation the dispatch names`, async () => {
      const { worker, runId } = RECORDED[release]
      const { view, calls } = await find(release, { workerId: worker })
      assert.deepEqual(view, { kind: 'found', runId })
      assert.deepEqual(calls, [byWorker(worker)])
    })
  }

  test("Archon's 404 means the run has not been created yet", async () => {
    const { view } = await find('0.14.0', { workerId: 'web-worker-1-new' }, [[byWorker('web-worker-1-new'), json({ error: 'Workflow run not found' }, 404)]])
    assert.deepEqual(view, { kind: 'not-created' })
  })

  test('another failure, or an answer with no run id, fails with a sentence', async () => {
    const failed = await find('0.14.0', { workerId: 'web-worker-2' }, [[byWorker('web-worker-2'), json({ error: 'boom' }, 500)]])
    assert.equal(failed.view.kind, 'failed')
    const odd = await find('0.14.0', { workerId: 'web-worker-3' }, [[byWorker('web-worker-3'), json({ run: { id: '' } })]])
    assert.equal(odd.view.kind, 'failed')
    if (odd.view.kind === 'failed') assert.match(odd.view.message, /0\.14\.0/)
  })
})

describe('what the worker refuses', () => {
  test('a worker conversation id with anything but letters, digits, _ and -, or another key, before asking Archon', async () => {
    for (const input of [{ workerId: '' }, { workerId: 'web/../x' }, { workerId: 'a'.repeat(201) }, { workerId: 7 }, {}, null, { workerId: 'web-1', extra: true }]) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
      const mounted = await stage.mount({})
      await assert.rejects(mounted.worker.request('chat.findRun', input as never))
      assert.equal(stage.archon.calls.filter((call) => call.url.includes('/by-worker/')).length, 0)
      await mounted.worker.deactivate()
    }
  })
})
