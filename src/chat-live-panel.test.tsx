// The frame seam for live chat: src/panel.tsx mounted on a scripted worker that answers the chat
// list and a thread with what the conversation's stream said, and posts the worker's chat hints.
// These tests cover what the panel does with them: the reads a hint sets off, busy and the
// working line while the worker reads the stream and once it no longer does, and the Working
// badge on a list row.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { sampleChat, sampleChats } from '../scripts/chat-samples.ts'
import { connected } from '../scripts/connection-samples.ts'
import { answeringThread, sampleMessage, sampleThread } from '../scripts/chat-thread-samples.ts'
import type { ChatSendRequest } from './chat-send-view'
import type { ThreadLive, ThreadMessage, ThreadRequest } from './chat-thread-view'
import type { ChatsView } from './chats-view'
import * as panelModule from './panel'

const NOON = Date.UTC(2026, 10, 18, 12)

let panel: TestPanel | undefined
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOON })
})
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

const MESSAGE = { type: 'Textarea', label: "Message to Archon's agent" }
const SEND = { type: 'Button', text: 'Send' }
const WORKING = { type: 'Spinner', label: /^Working/ }

/** What the scripted worker answers: the newest messages and what the stream said, as they stand at each read. */
type Now = { messages: ThreadMessage[]; live?: ThreadLive; chats?: ChatsView }

const question = (id: string): ThreadMessage => ({ ...sampleMessage(1), id, at: NOON, blocks: [`Question ${id}`] })
const reply = (id: string): ThreadMessage => ({ ...sampleMessage(0), id, at: NOON, blocks: [`Reply ${id}`] })

async function openThread(now: Now): Promise<TestPanel> {
  const base = answeringThread(
    (request: ThreadRequest) => sampleThread(0, request, { messages: now.messages, ...(now.live === undefined ? {} : { live: now.live }) }),
    { chats: (request) => now.chats ?? sampleChats(4, request) }
  )
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'chat.send': (request: ChatSendRequest) => ({ connection: connected, outcome: { kind: 'sent', conversationId: (request as { conversationId: string }).conversationId } })
      }
    }),
    persisted: { workspace: { section: 'chat' } }
  })
  if (now.chats === undefined) await panel.press({ type: 'ListItem', label: /^Question 0/ })
  return panel
}

/** The inputs of every request of one name the panel sent, in order. */
const sent = (view: TestPanel, name: string): Record<string, unknown>[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => ((params as { input?: unknown }).input ?? {}) as Record<string, unknown>)

async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

describe("the worker's chat hints", () => {
  test('a hint for the open thread reads it again; one for another conversation does not', async () => {
    const view = await openThread({ messages: [reply('r1')] })
    await advance(view, 2_000)
    const reads = sent(view, 'chat.read').length
    await view.post('chat.changed', { conversationId: 'web-chat-0' })
    assert.equal(sent(view, 'chat.read').length, reads + 1)
    await advance(view, 2_000)
    await view.post('chat.changed', { conversationId: 'web-chat-3' })
    await advance(view, 2_000)
    assert.equal(sent(view, 'chat.read').length, reads + 1)
    clean(view)
  })

  test('the first read after the person opens the thread says so, and the reads after it do not', async () => {
    const view = await openThread({ messages: [reply('r1')] })
    await advance(view, 30_000)
    const reads = sent(view, 'chat.read')
    assert.equal(reads[0]?.['open'], true)
    assert.ok(reads.length >= 2)
    for (const later of reads.slice(1)) assert.equal(Object.hasOwn(later, 'open'), false)
    clean(view)
  })
})

describe('busy while the worker reads the stream', () => {
  test('the stream says busy although the newest message is the agent\'s, and the thread is read every 3 seconds', async () => {
    const now: Now = { messages: [reply('r1'), question('q1')], live: { busy: true, tool: null } }
    const view = await openThread(now)
    assert.ok(view.find({ type: 'Spinner', label: 'Working…' }))
    assert.equal(view.find(MESSAGE)?.props.disabled, true)
    const reads = sent(view, 'chat.read').length
    await advance(view, 3_000)
    assert.equal(sent(view, 'chat.read').length, reads + 1)
    // The stream says the turn ended: the composer is on again at once.
    now.live = { busy: false, tool: null }
    await view.post('chat.changed', { conversationId: 'web-chat-0' })
    await advance(view, 2_000)
    assert.equal(view.find(WORKING), null)
    assert.equal(view.find(MESSAGE)?.props.disabled, false)
    clean(view)
  })

  test("the stream says not busy although the newest message is the person's", async () => {
    const view = await openThread({ messages: [question('q1')], live: { busy: false, tool: null } })
    assert.equal(view.find(WORKING), null)
    assert.equal(view.find(MESSAGE)?.props.disabled, false)
    clean(view)
  })

  test('the working line names the tool the agent is using, and loses it with the stream, when busy is inferred again', async () => {
    const now: Now = { messages: [question('q1')], live: { busy: true, tool: 'Bash' } }
    const view = await openThread(now)
    assert.ok(view.find({ type: 'Spinner', label: 'Working: Bash…' }))
    now.live = { busy: true, tool: null }
    await advance(view, 3_000)
    assert.ok(view.find({ type: 'Spinner', label: 'Working…' }))
    now.live = { busy: true, tool: 'Read' }
    await advance(view, 3_000)
    assert.ok(view.find({ type: 'Spinner', label: 'Working: Read…' }))
    // Displaced: the worker no longer reads the stream, and the trailing question means busy.
    delete now.live
    await advance(view, 3_000)
    assert.ok(view.find({ type: 'Spinner', label: 'Working…' }))
    clean(view)
  })

  test('a send after the stream said not busy keeps the composer off until the stream says the turn began and ended', async () => {
    const now: Now = { messages: [reply('r1')], live: { busy: false, tool: null } }
    const view = await openThread(now)
    await advance(view, 1_000)
    await view.type(MESSAGE, 'Hello')
    await view.press(SEND)
    now.messages = [question('q2'), reply('r1')]
    await advance(view, 3_000)
    // The stream has not said yet that the turn began.
    assert.ok(view.find(WORKING))
    now.live = { busy: true, tool: null }
    await advance(view, 3_000)
    assert.ok(view.find(WORKING))
    now.live = { busy: false, tool: null }
    now.messages = [reply('r2'), question('q2'), reply('r1')]
    await advance(view, 3_000)
    assert.equal(view.find(WORKING), null)
    assert.equal(view.find(MESSAGE)?.props.disabled, false)
    clean(view)
  })
})

describe('the chat list', () => {
  test('a row the worker knows is busy shows a Working badge, and a hint reads the list again', async () => {
    const now: Now = { messages: [], chats: { kind: 'ready', rows: [{ ...sampleChat(0), working: true }, sampleChat(1)], capped: false, unreadable: 0 } }
    const view = await openThread(now)
    const badges = view.findAll({ type: 'Badge', text: 'Working' })
    assert.equal(badges.length, 1)
    const reads = sent(view, 'chats.read').length
    await advance(view, 2_000)
    now.chats = { kind: 'ready', rows: [sampleChat(0), sampleChat(1)], capped: false, unreadable: 0 }
    await view.post('chat.changed', { conversationId: sampleChat(0).id })
    assert.equal(sent(view, 'chats.read').length, reads + 1)
    assert.equal(view.find({ type: 'Badge', text: 'Working' }), null)
    clean(view)
  })
})
