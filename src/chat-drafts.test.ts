// The worker's request protocol seam: the worker mounted on a scripted Archon and a stand-in Orca
// host whose plugin storage the test reads. These tests cover chat drafts: what the worker keeps,
// what it writes to plugin storage and when, and what it drops.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, scene, type MountedScene, type Scene } from '../scripts/scripted-archon.ts'
import type { ChatDraftsAnswer } from './chat-drafts-view'

const KEY = 'chat-drafts'

async function drafts(mounted: MountedScene): Promise<Record<string, string>> {
  return ((await mounted.worker.request('chat.drafts.read')) as ChatDraftsAnswer).drafts
}

const write = (mounted: MountedScene, key: string, text: string): Promise<unknown> => mounted.worker.request('chat.draft.write', { key, text })

describe('chat drafts', () => {
  test('a written draft reads back at once, and reaches plugin storage only after a pause', async () => {
    const stage = scene()
    const mounted = await stage.mount({})
    await write(mounted, 'conversation:web-1', 'Half a thought')
    assert.deepEqual(await drafts(mounted), { 'conversation:web-1': 'Half a thought' })
    assert.equal(mounted.host.data().storage[KEY], undefined)
    await stage.clock.advance(1_000)
    assert.deepEqual(mounted.host.data().storage[KEY], [{ key: 'conversation:web-1', text: 'Half a thought' }])
    await mounted.worker.deactivate()
  })

  test('keeps the 20 most recently edited: an edit moves a draft to the front, and the 21st pushes out the oldest', async () => {
    const stage = scene()
    const mounted = await stage.mount({})
    for (let index = 0; index < 21; index += 1) await write(mounted, `conversation:web-${String(index)}`, `Draft ${String(index)}`)
    await write(mounted, 'conversation:web-1', 'Draft 1, again')
    await write(mounted, 'new:cb-web', 'A new chat')
    const kept = await drafts(mounted)
    assert.equal(Object.keys(kept).length, 20)
    assert.equal(kept['conversation:web-0'], undefined)
    assert.equal(kept['conversation:web-2'], undefined)
    assert.equal(kept['conversation:web-1'], 'Draft 1, again')
    assert.equal(kept['new:cb-web'], 'A new chat')
    await stage.clock.advance(1_000)
    const stored = mounted.host.data().storage[KEY] as { key: string }[]
    assert.deepEqual(stored.slice(0, 2).map((draft) => draft.key), ['new:cb-web', 'conversation:web-1'])
    assert.equal(stored.length, 20)
    await mounted.worker.deactivate()
  })

  test('empty text removes a draft', async () => {
    const stage = scene()
    const mounted = await stage.mount({})
    await write(mounted, 'conversation:web-1', 'Gone soon')
    await write(mounted, 'conversation:web-1', '')
    assert.deepEqual(await drafts(mounted), {})
    await stage.clock.advance(1_000)
    assert.deepEqual(mounted.host.data().storage[KEY], [])
    await mounted.worker.deactivate()
  })

  test('drafts in plugin storage survive a restart, and a stored draft that is not one within the caps is dropped', async () => {
    const stage = scene()
    const mounted = await stage.mount({
      storage: {
        [KEY]: [
          { key: 'conversation:web-1', text: 'Kept' },
          { key: 'conversation:web-1', text: 'A second of one key' },
          { key: 'conversation:web 2', text: 'A key the rule refuses' },
          { key: 'elsewhere:web-3', text: 'A key of no kind' },
          { key: 'conversation:web-4', text: 'a'.repeat(32 * 1024 + 1) },
          { key: 'conversation:web-5', text: '' },
          { key: 'conversation:web-6', text: 7 },
          'not a draft',
          { key: 'new:all', text: 'Also kept' }
        ]
      }
    })
    assert.deepEqual(await drafts(mounted), { 'conversation:web-1': 'Kept', 'new:all': 'Also kept' })
    await mounted.worker.deactivate()
  })

  test('storage that holds no list gives no drafts', async () => {
    const stage = scene()
    const mounted = await stage.mount({ storage: { [KEY]: { 'conversation:web-1': 'Not a list' } } })
    assert.deepEqual(await drafts(mounted), {})
    await mounted.worker.deactivate()
  })

  test('a change still waiting for the pause is written when the worker stops', async () => {
    const stage = scene()
    const mounted = await stage.mount({})
    await write(mounted, 'conversation:web-1', 'Typed just before Orca quit')
    await mounted.worker.deactivate()
    assert.deepEqual(mounted.host.data().storage[KEY], [{ key: 'conversation:web-1', text: 'Typed just before Orca quit' }])
  })

  test('refuses a draft past 32 KiB of UTF-8, a key of no conversation or project, and other keys', async () => {
    const stage = scene()
    const mounted = await stage.mount({})
    const cases: unknown[] = [
      { key: 'conversation:web-1', text: '€'.repeat(11_000) },
      { key: 'conversation:../web-1', text: 'Hi' },
      { key: 'conversation:', text: 'Hi' },
      { key: 'conversation:web-1', text: 'Hi', extra: true },
      { key: 'conversation:web-1' },
      'Hi'
    ]
    for (const input of cases) {
      await assert.rejects(mounted.worker.request('chat.draft.write', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    assert.deepEqual(await drafts(mounted), {})
    await mounted.worker.deactivate()
  })
})

/** The one web conversation and the one project of the 0.12.1 recording. */
const CONVERSATION = 'web-1795050072354-vqr978'
const PROJECT = 'cd8c6f17a56a08ff6e8c24143751f5c4'

/** Archon 0.12.1 accepting a send, as `chat-send.test.ts` scripts it from the recorded launch route. */
function sendScene(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.12.1' }))
  stage.archon.answer(`${DEFAULT}/api/codebases`, recorded('0.12.1', 'codebases', 1))
  stage.archon.answer(`${DEFAULT}/api/conversations/${CONVERSATION}/message`, recorded('0.12.1', 'launch-accepted', 6))
  stage.archon.answer(`${DEFAULT}/api/conversations`, recorded('0.12.1', 'launch-accepted', 0))
  return stage
}

describe('a draft and its send', () => {
  test("is cleared when Archon accepts the conversation's message", async () => {
    const stage = sendScene()
    const mounted = await stage.mount({})
    await write(mounted, `conversation:${CONVERSATION}`, 'Sent soon')
    await write(mounted, 'conversation:web-other', 'Not sent')
    await mounted.worker.request('chat.send', { conversationId: CONVERSATION, message: 'Sent soon' })
    assert.deepEqual(await drafts(mounted), { 'conversation:web-other': 'Not sent' })
    await mounted.worker.deactivate()
  })

  test("a new chat's draft in its project is cleared when Archon accepts its first message", async () => {
    const stage = sendScene()
    const mounted = await stage.mount({})
    await write(mounted, `new:${PROJECT}`, 'Hello')
    await mounted.worker.request('chat.send', { codebaseId: PROJECT, message: 'Hello' })
    assert.deepEqual(await drafts(mounted), {})
    await mounted.worker.deactivate()
  })

  test('is kept when the send was not accepted', async () => {
    const stage = sendScene()
    stage.archon.answer(`${DEFAULT}/api/conversations/${CONVERSATION}/message`, json({ error: 'Busy' }, 400))
    const mounted = await stage.mount({})
    await write(mounted, `conversation:${CONVERSATION}`, 'Still here')
    await mounted.worker.request('chat.send', { conversationId: CONVERSATION, message: 'Still here' })
    assert.deepEqual(await drafts(mounted), { [`conversation:${CONVERSATION}`]: 'Still here' })
    await mounted.worker.deactivate()
  })
})
