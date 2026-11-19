// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, and a stand-in Orca host. These tests cover the last answer the worker keeps
// for each thread on screen: in memory only, while the thread's reads hold its lease.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type MountedScene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import type { ChatLastAnswer } from './chat-last-view'
import type { ThreadAnswer, ThreadView } from './chat-thread-view'

/** The one web conversation each release's recording holds. */
const CONVERSATION: Record<Release, string> = {
  '0.12.1': 'web-1795050072354-vqr978',
  '0.13.2': 'web-1795050191420-o7xrhr',
  '0.14.0': 'web-1795050310074-i0mt96'
}

const conversationUrl = (id: string): string => `${DEFAULT}/api/conversations/${id}`

function threadScene(release: Release): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  const id = CONVERSATION[release]
  stage.archon.answer(conversationUrl(id), recorded(release, 'conversations', 2))
  stage.archon.answer(`${conversationUrl(id)}/messages?limit=50`, recorded(release, 'conversations', 3))
  stage.archon.answer(`${DEFAULT}/api/codebases`, recorded(release, 'codebases', 1))
  return stage
}

const read = async (mounted: MountedScene, conversationId: string): Promise<ThreadView> =>
  ((await mounted.worker.request('chat.read', { conversationId, limit: 50 })) as ThreadAnswer).thread

const last = async (mounted: MountedScene, conversationId: string): Promise<ChatLastAnswer['thread']> =>
  ((await mounted.worker.request('chat.last', { conversationId })) as ChatLastAnswer).thread

describe("a thread's last answer", () => {
  for (const release of RELEASES) {
    test(`${release}: is the thread the last read answered, asking Archon nothing`, async () => {
      const stage = threadScene(release)
      const mounted = await stage.mount({})
      const id = CONVERSATION[release]
      assert.equal(await last(mounted, id), null)
      const view = await read(mounted, id)
      assert.equal(view.kind, 'ready')
      const calls = stage.archon.calls.length
      assert.deepEqual(await last(mounted, id), view.kind === 'ready' ? view.thread : null)
      assert.equal(stage.archon.calls.length, calls)
      await mounted.worker.deactivate()
    })
  }

  const release: Release = '0.12.1'
  const id = CONVERSATION[release]

  test('is dropped when no read has renewed its 60 second lease', async () => {
    const stage = threadScene(release)
    const mounted = await stage.mount({})
    await read(mounted, id)
    await stage.clock.advance(59_000)
    assert.notEqual(await last(mounted, id), null)
    await read(mounted, id)
    await stage.clock.advance(59_000)
    assert.notEqual(await last(mounted, id), null)
    await stage.clock.advance(2_000)
    assert.equal(await last(mounted, id), null)
    await mounted.worker.deactivate()
  })

  test('is dropped when the conversation no longer exists, or is deleted', async () => {
    const stage = threadScene(release)
    const mounted = await stage.mount({})
    await read(mounted, id)
    stage.archon.answer(conversationUrl(id), json({ error: 'Conversation not found' }, 404))
    assert.deepEqual(await read(mounted, id), { kind: 'gone' })
    assert.equal(await last(mounted, id), null)
    stage.archon.answer(conversationUrl(id), recorded(release, 'conversations', 2))
    await read(mounted, id)
    stage.archon.answer(conversationUrl(id), recorded(release, 'deletes', 2))
    await mounted.worker.request('chat.delete', { conversationId: id })
    assert.equal(await last(mounted, id), null)
    await mounted.worker.deactivate()
  })

  test('is kept in memory only: nothing of the thread reaches plugin storage', async () => {
    const stage = threadScene(release)
    const mounted = await stage.mount({})
    await read(mounted, id)
    await stage.clock.advance(5_000)
    assert.deepEqual(mounted.host.data().storage, {})
    await mounted.worker.deactivate()
  })

  test('refuses a conversation id the rule does not accept', async () => {
    const stage = threadScene(release)
    const mounted = await stage.mount({})
    for (const input of [{ conversationId: '../x' }, { conversationId: '' }, { conversationId: id, limit: 50 }, null]) {
      await assert.rejects(mounted.worker.request('chat.last', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await mounted.worker.deactivate()
  })
})
