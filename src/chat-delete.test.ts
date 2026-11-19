// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, and a stand-in Orca host. These tests cover deleting a conversation: what the
// worker sends Archon, only once, and what it refuses before anything is sent.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, HANG, health, json, recorded, RELEASES, scene, type MountedScene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import type { ChatDeleteAnswer, ChatDeleteOutcome } from './chat-delete-view'
import type { ChatDraftsAnswer } from './chat-drafts-view'

/** The one web conversation each release's recording holds. */
const CONVERSATION: Record<Release, string> = {
  '0.12.1': 'web-1795050072354-vqr978',
  '0.13.2': 'web-1795050191420-o7xrhr',
  '0.14.0': 'web-1795050310074-i0mt96'
}

const conversationUrl = (id: string): string => `${DEFAULT}/api/conversations/${id}`

/**
 * A release's Archon. The recordings hold no delete of a conversation, so its answer is the
 * recorded answer of deleting a project, the same `SuccessResponse` the path list documents for
 * `DELETE /api/conversations/{id}`.
 */
function deleteScene(release: Release): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(conversationUrl(CONVERSATION[release]), recorded(release, 'deletes', 2))
  return stage
}

async function remove(mounted: MountedScene, input: unknown): Promise<ChatDeleteOutcome> {
  return ((await mounted.worker.request('chat.delete', input as never)) as ChatDeleteAnswer).outcome
}

/** Every write the worker sent Archon: method and path. */
const writes = (stage: Scene): { method: string; path: string }[] =>
  stage.archon.calls.filter((call) => call.method !== 'GET').map((call) => ({ method: call.method, path: new URL(call.url).pathname }))

describe('deleting a conversation', () => {
  for (const release of RELEASES) {
    test(`${release}: sends one DELETE of the conversation, with no body`, async () => {
      const stage = deleteScene(release)
      const mounted = await stage.mount({})
      assert.deepEqual(await remove(mounted, { conversationId: CONVERSATION[release] }), { kind: 'deleted' })
      assert.deepEqual(writes(stage), [{ method: 'DELETE', path: `/api/conversations/${CONVERSATION[release]}` }])
      assert.equal(stage.archon.calls.find((call) => call.method === 'DELETE')?.body, undefined)
      await mounted.worker.deactivate()
    })
  }

  const release: Release = '0.12.1'
  const id = CONVERSATION[release]

  test('a delete that times out is answered as a timeout and never sent again', async () => {
    const stage = deleteScene(release)
    stage.archon.answer(conversationUrl(id), HANG)
    const mounted = await stage.mount({})
    const pending = remove(mounted, { conversationId: id })
    await stage.clock.advance(30_000)
    assert.deepEqual(await pending, { kind: 'timeout', timeoutMs: 30_000 })
    await stage.clock.advance(120_000)
    assert.equal(writes(stage).length, 1)
    await mounted.worker.deactivate()
  })

  test("a conversation that no longer exists is gone, Archon's refusal is said in its words, and an answer that says no delete is refused", async () => {
    const stage = deleteScene(release)
    const mounted = await stage.mount({})
    stage.archon.answer(conversationUrl(id), json({ error: 'Conversation not found' }, 404))
    assert.deepEqual(await remove(mounted, { conversationId: id }), { kind: 'gone' })
    stage.archon.answer(conversationUrl(id), json({ error: 'Identity backend unavailable' }, 503))
    assert.deepEqual(await remove(mounted, { conversationId: id }), { kind: 'refused', message: 'Identity backend unavailable' })
    stage.archon.answer(conversationUrl(id), json({ success: false }))
    assert.deepEqual(await remove(mounted, { conversationId: id }), { kind: 'refused', message: 'Archon did not say it deleted the conversation.' })
    // Each was sent once, and none again.
    assert.equal(writes(stage).length, 3)
    await mounted.worker.deactivate()
  })

  test("deleting drops the conversation's draft", async () => {
    const stage = deleteScene(release)
    const mounted = await stage.mount({})
    await mounted.worker.request('chat.draft.write', { key: `conversation:${id}`, text: 'Never sent' })
    await remove(mounted, { conversationId: id })
    assert.deepEqual(((await mounted.worker.request('chat.drafts.read')) as ChatDraftsAnswer).drafts, {})
    await mounted.worker.deactivate()
  })

  test('refuses a conversation id the rule does not accept, and other keys, before anything is sent', async () => {
    const stage = deleteScene(release)
    const mounted = await stage.mount({})
    const cases: unknown[] = [{ conversationId: '' }, { conversationId: '../x' }, { conversationId: 'a b' }, { conversationId: 'a'.repeat(201) }, { conversationId: id, extra: 1 }, {}, id]
    for (const input of cases) {
      await assert.rejects(mounted.worker.request('chat.delete', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })

  test('while not connected nothing is sent', async () => {
    const stage = scene()
    const mounted = await stage.mount({})
    assert.deepEqual(await remove(mounted, { conversationId: id }), { kind: 'not-connected' })
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })
})
