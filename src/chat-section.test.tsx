// The frame seam for the Chat section: src/panel.tsx mounted on a scripted worker that answers
// the chat list, the scope and the runs table. These tests cover what the list draws under each
// scope, its notices and empty state, and when the panel asks the worker for it again.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answeringChats, sampleChats } from '../scripts/chat-samples.ts'
import { searching } from '../scripts/connection-samples.ts'
import { remote, unmatchedGit } from '../scripts/scope-samples.ts'
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

  test('under "All projects" asks for the conversations of every project, and each row names its project or says "No project"', async () => {
    const view = await mountChat((request) => sampleChats(3, request), { scope: () => unmatchedGit })
    assert.deepEqual(sent(view), [{}])
    assert.deepEqual(
      view.findAll({ type: 'ListItem' }).map((row) => [row.props.title, row.props.description]),
      [
        ['Question 0', 'acme/web'],
        ['Question 1', 'acme/web'],
        ['Question 2', 'No project']
      ]
    )
    clean(view)
  })

  test('in a remote workspace the list is in "All projects" mode, under the remote notice', async () => {
    const view = await mountChat((request) => sampleChats(1, request), { scope: () => remote })
    assert.deepEqual(sent(view), [{}])
    assert.ok(view.find({ text: /This workspace is on another host\./ }))
    assert.equal(view.find({ type: 'ListItem' })?.props.description, 'acme/web')
    clean(view)
  })

  test('a header row has the heading "Conversations" and New chat, which is on', async () => {
    const view = await mountChat((request) => sampleChats(2, request))
    assert.ok(view.find({ type: 'Heading', text: 'Conversations' }))
    const newChat = view.find({ type: 'Button', text: 'New chat' })
    assert.equal(newChat?.disabled, false)
    assert.equal(view.find({ type: 'Text', text: 'Starting a chat from Orchon is not available yet.' }), null)
    // There is no search.
    assert.equal(view.find({ type: 'Input' }), null)
    clean(view)
  })

  test('with no conversations the section says "No conversations yet"', async () => {
    const view = await mountChat((request) => sampleChats(0, request))
    assert.ok(view.find({ type: 'EmptyState', label: /^No conversations yet/ }))
    assert.equal(view.find({ type: 'List' }), null)
    clean(view)
  })

  test('at 50 rows a notice says only the 50 most recent are shown and some may be missing; at 49 there is none', async () => {
    let count = 50
    const view = await mountChat((request) => sampleChats(count, request))
    assert.equal(view.findAll({ type: 'ListItem' }).length, 50)
    const notice = view.find({ type: 'Callout' })
    assert.match(notice?.text ?? '', /50 most recent conversations/)
    assert.match(notice?.text ?? '', /some may be missing/)
    count = 49
    await view.select(SECTION_BAR, 'runs')
    await view.select(SECTION_BAR, 'chat')
    assert.equal(view.findAll({ type: 'ListItem' }).length, 49)
    assert.equal(view.find({ type: 'Callout' }), null)
    clean(view)
  })

  test('says how many conversations could not be read', async () => {
    const view = await mountChat((request) => sampleChats(2, request, 3))
    assert.ok(view.find({ type: 'Text', text: '3 conversations could not be read and are not shown.' }))
    clean(view)
  })
})

describe('when the chat list is read', () => {
  /** Moves the frame's clock and lets what fell due run. */
  async function advance(view: TestPanel, ms: number): Promise<void> {
    mock.timers.tick(ms)
    await view.settled()
  }

  test('when the section is shown, and every 30 seconds while it shows; never while another section shows', async () => {
    const view = await mountChat((request) => sampleChats(2, request))
    assert.equal(sent(view).length, 1)
    await advance(view, 29_999)
    assert.equal(sent(view).length, 1)
    await advance(view, 1)
    assert.equal(sent(view).length, 2)
    await view.select(SECTION_BAR, 'runs')
    await advance(view, 90_000)
    assert.equal(sent(view).length, 2)
    await view.select(SECTION_BAR, 'chat')
    assert.equal(sent(view).length, 3)
    clean(view)
  })

  test('a run hint reads nothing', async () => {
    const view = await mountChat((request) => sampleChats(2, request))
    await advance(view, 5_000)
    const before = sent(view).length
    await view.post('runs.changed', { types: ['workflow_status', 'dag_node'], runs: 'many' })
    await advance(view, 5_000)
    assert.equal(sent(view).length, before)
    clean(view)
  })

  test('Searching keeps the loaded list under its banner', async () => {
    const view = await mountChat((request) => sampleChats(2, request))
    await view.post('connection.changed', { ...searching, since: Date.now() + 1 })
    assert.ok(view.find({ type: 'Text', text: /Archon stopped answering/ }))
    assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
    clean(view)
  })
})
