// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, and a stand-in Orca host. These tests cover the chat list: which
// conversations the worker asks Archon for under each scope, which it leaves out, and the rows
// it answers.
import { assert, describe, test, type MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type MountedScene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import type { ChatsAnswer, ChatsView } from './chats-view'

/** The id of the one project each release's recording holds. Read off the fixtures by hand. */
const RECORDED_ID: Record<Release, string> = {
  '0.12.1': 'cd8c6f17a56a08ff6e8c24143751f5c4',
  '0.13.2': '6feec5b110ac5147f1d58ffa49d2790c',
  '0.14.0': '4fb57f7e8043f7efd57270977e68c598'
}
/** The one web conversation each release's recording holds, read off the fixtures by hand. */
const RECORDED_CHAT: Record<Release, { id: string; title: string; lastActivityAt: number }> = {
  '0.12.1': { id: 'web-1795050072354-vqr978', title: 'Orchon recorder launch shell step', lastActivityAt: Date.UTC(2026, 10, 19, 1, 1, 12) },
  '0.13.2': { id: 'web-1795050191420-o7xrhr', title: 'Orchon launch recording shell step', lastActivityAt: Date.UTC(2026, 10, 19, 1, 3, 11) },
  '0.14.0': { id: 'web-1795050310074-i0mt96', title: 'Orchon launch shell step', lastActivityAt: Date.UTC(2026, 10, 19, 1, 5, 10) }
}

const ALL_URL = `${DEFAULT}/api/conversations?platform=web`
const projectUrl = (id: string): string => `${DEFAULT}/api/conversations?platform=web&codebaseId=${id}`

function chatScene(release: Release, storeId?: string): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health(storeId === undefined ? { version: release } : { version: release, storeId }))
  return stage
}

async function read(mounted: MountedScene, input: Record<string, unknown> = {}): Promise<ChatsView> {
  return ((await mounted.worker.request('chats.read', input)) as ChatsAnswer).chats
}

const ready = (view: ChatsView): Extract<ChatsView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The chat list is ${view.kind}${view.kind === 'failed' ? `: ${view.message}` : ''}.`)
  return view
}

const host = (storage: MockHostOptions['storage'] = {}): MockHostOptions => ({ storage })

describe('the chat list under "This project"', () => {
  for (const release of RELEASES) {
    test(`${release}: asks Archon for the project's web conversations and answers the recorded one`, async () => {
      const stage = chatScene(release)
      stage.archon.answer(projectUrl(RECORDED_ID[release]), recorded(release, 'conversations', 1))
      const mounted = await stage.mount(host())
      const view = ready(await read(mounted, { codebaseId: RECORDED_ID[release] }))
      const chat = RECORDED_CHAT[release]
      assert.deepEqual(view, { kind: 'ready', rows: [{ id: chat.id, title: chat.title, lastActivityAt: chat.lastActivityAt }], capped: false, unreadable: 0 })
      assert.ok(stage.archon.calls.some((call) => call.url === projectUrl(RECORDED_ID[release])))
      assert.ok(!stage.archon.calls.some((call) => call.url === ALL_URL))
      await mounted.worker.deactivate()
    })
  }
})

const CODEBASES = `${DEFAULT}/api/codebases`
const RECORDED_NAME = 'orchon-recorder/throwaway-project'

/** The recorded answer's rows, for a test that adds its own beside them. */
function recordedRows(release: Release, index: number): Record<string, unknown>[] {
  const answer = recorded(release, 'conversations', index)
  if (answer.kind !== 'json' || !Array.isArray(answer.value)) throw new Error(`The recorded conversations of ${release} are not a list.`)
  return answer.value as Record<string, unknown>[]
}

/** A web conversation like the recorded one, with its own id and the fields given. */
function likeRecorded(release: Release, id: string, change: Record<string, unknown> = {}): Record<string, unknown> {
  const [first] = recordedRows(release, 0)
  return { ...first, id: `db-${id}`, platform_conversation_id: id, ...change }
}

describe('the chat list under "All projects"', () => {
  for (const release of RELEASES) {
    test(`${release}: asks Archon for web conversations alone, and each row names its project or none`, async () => {
      const stage = chatScene(release)
      stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
      stage.archon.answer(ALL_URL, json([...recordedRows(release, 0), likeRecorded(release, 'web-loose', { codebase_id: null, title: null })]))
      const mounted = await stage.mount(host())
      const view = ready(await read(mounted))
      const chat = RECORDED_CHAT[release]
      assert.deepEqual(view.rows, [
        { id: chat.id, title: chat.title, lastActivityAt: chat.lastActivityAt, project: RECORDED_NAME },
        { id: 'web-loose', title: null, lastActivityAt: chat.lastActivityAt, project: null }
      ])
      assert.ok(!stage.archon.calls.some((call) => call.url.includes('codebaseId=')))
      await mounted.worker.deactivate()
    })
  }
})
