// The frame seam for the Chat section: src/panel.tsx mounted on a scripted worker that answers
// the chat list, the scope and the runs table. These tests cover what the list draws under each
// scope, its notices and empty state, and when the panel asks the worker for it again.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answeringChats, sampleChats } from '../scripts/chat-samples.ts'
import type { ChatsRequest, ChatsView } from './chats-view'
import * as panelModule from './panel'

let panel: TestPanel | undefined
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 18, 12) })
})
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

const SECTION_BAR = { label: 'Orchon sections' }

async function mountChat(chats: (request: ChatsRequest) => ChatsView, options: Parameters<typeof answeringChats>[1] = {}): Promise<TestPanel> {
  panel = await mount(panelModule, { host: mockHost(answeringChats(chats, options)), persisted: { workspace: { section: 'chat' } } })
  return panel
}

/** Every chat list request the panel sent, by its input, in order. */
const sent = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'chats.read')
    .map((params) => (params as { input?: unknown }).input ?? null)

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

describe('the chat list', () => {
  test('under "This project" asks for the project\'s conversations and draws each title, or "Untitled", with its last activity', async () => {
    const view = await mountChat((request) => sampleChats(4, request))
    assert.deepEqual(sent(view), [{ codebaseId: 'cb-web' }])
    const rows = view.findAll({ type: 'ListItem' })
    assert.deepEqual(
      rows.map((row) => [row.props.title, row.props.description]),
      [
        ['Question 0', undefined],
        ['Question 1', undefined],
        ['Question 2', undefined],
        ['Untitled', undefined]
      ]
    )
    assert.deepEqual(
      view.findAll({ type: 'RelativeTime' }).map((time) => time.props.at),
      [0, 1, 2, 3].map((index) => Date.UTC(2026, 10, 18, 12) - index * 60_000)
    )
    clean(view)
  })
})
