// The frame seam for deleting a conversation: src/panel.tsx mounted on a scripted worker that
// answers the chat list, the thread, a send and a delete. These tests cover the thread's Delete,
// its inline confirmation, when it is off, and what the panel does with each answer.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { sampleChats } from '../scripts/chat-samples.ts'
import { connected, searching } from '../scripts/connection-samples.ts'
import { answeringThread, sampleThread } from '../scripts/chat-thread-samples.ts'
import type { ChatDeleteOutcome } from './chat-delete-view'
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

const DELETE = { type: 'Button', text: 'Delete' }
const CONFIRM = { type: 'Button', text: 'Delete conversation' }
const KEEP = { type: 'Button', text: 'Keep conversation' }
const QUESTION = 'Delete this conversation?'

type Script = { remove?: () => ChatDeleteOutcome | Promise<ChatDeleteOutcome> }

async function openFirst(script: Script = {}): Promise<TestPanel> {
  const base = answeringThread((request) => sampleThread(3, request), { chats: (request) => sampleChats(4, request) })
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'chat.send': { connection: connected, outcome: { kind: 'sent', conversationId: 'web-chat-0' } },
        'chat.delete': async () => ({ connection: connected, outcome: await (script.remove ?? ((): ChatDeleteOutcome => ({ kind: 'deleted' })))() })
      }
    }),
    persisted: { workspace: { section: 'chat' } }
  })
  await panel.press({ type: 'ListItem', label: /^Question 0/ })
  return panel
}

const requests = (view: TestPanel, name: string): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input?: unknown }).input ?? null)

/** The confirmation's callout, or null. */
const question = (view: TestPanel) => view.findAll({ type: 'Callout' }).find((callout) => callout.props.title === QUESTION) ?? null

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/** The index of each node among the drawn tree's elements, in drawing order. */
function order(view: TestPanel, texts: string[]): number[] {
  const all: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      all.push(node)
      return
    }
    if (node === null || typeof node !== 'object') return
    const element = node as { props?: Record<string, unknown>; children?: unknown[] }
    if (typeof element.props?.title === 'string') all.push(element.props.title)
    for (const child of element.children ?? []) walk(child)
  }
  walk(view.tree())
  return texts.map((text) => all.indexOf(text))
}

describe("a thread's Delete", () => {
  test('opens an inline danger callout asking first, with the safe button first, and sends nothing until confirmed', async () => {
    const view = await openFirst()
    await view.press(DELETE)
    const callout = question(view)
    assert.ok(callout)
    assert.equal(callout.props.tone, 'danger')
    const [keep, go] = order(view, ['Keep conversation', 'Delete conversation'])
    assert.ok(keep !== undefined && go !== undefined && keep >= 0 && keep < go, `keep ${String(keep)} before delete ${String(go)}`)
    assert.deepEqual(requests(view, 'chat.delete'), [])
    await view.press(KEEP)
    assert.equal(question(view), null)
    assert.deepEqual(requests(view, 'chat.delete'), [])
    clean(view)
  })

  test('confirmed, deletes the conversation once, then the list opens and is read again', async () => {
    const view = await openFirst()
    const listReads = requests(view, 'chats.read').length
    await view.press(DELETE)
    await view.press(CONFIRM)
    assert.deepEqual(requests(view, 'chat.delete'), [{ conversationId: 'web-chat-0' }])
    assert.ok(view.find({ type: 'List', label: 'Conversations' }))
    assert.equal(requests(view, 'chats.read').length, listReads + 1)
    assert.equal(view.persisted.workspace.openChat, null)
    clean(view)
  })

  test('a conversation already gone opens the list too', async () => {
    const view = await openFirst({ remove: () => ({ kind: 'gone' }) })
    await view.press(DELETE)
    await view.press(CONFIRM)
    assert.ok(view.find({ type: 'List', label: 'Conversations' }))
    clean(view)
  })

  test('is off while the conversation is busy', async () => {
    const view = await openFirst()
    await view.type({ type: 'Textarea', label: "Message to Archon's agent" }, 'Hi')
    await view.press({ type: 'Button', text: 'Send' })
    assert.equal(view.find(DELETE)?.props.disabled, true)
    clean(view)
  })

  test('is off while writes are off, and so is the confirmation', async () => {
    const view = await openFirst()
    await view.press(DELETE)
    await view.post('connection.changed', { ...searching, since: Date.now() + 1 })
    assert.equal(view.find(DELETE)?.props.disabled, true)
    assert.equal(view.find(CONFIRM)?.props.disabled, true)
    assert.equal(view.find(KEEP)?.props.disabled, false)
    clean(view)
  })

  test('a delete that timed out is not sent again: the callout says so and the thread stays', async () => {
    const view = await openFirst({ remove: () => ({ kind: 'timeout', timeoutMs: 30_000 }) })
    await view.press(DELETE)
    await view.press(CONFIRM)
    assert.ok(view.find({ text: /^Archon did not answer within 30 seconds\. The conversation may have been deleted, so it was not sent again\./ }))
    assert.ok(view.find({ type: 'Heading', text: 'Question 0' }))
    assert.equal(requests(view, 'chat.delete').length, 1)
    clean(view)
  })

  test("a refusal is said in the worker's words, and the thread stays", async () => {
    const view = await openFirst({ remove: () => ({ kind: 'refused', message: 'Identity backend unavailable' }) })
    await view.press(DELETE)
    await view.press(CONFIRM)
    assert.ok(question(view))
    assert.ok(view.find({ text: 'Identity backend unavailable' }))
    assert.ok(view.find({ type: 'Heading', text: 'Question 0' }))
    clean(view)
  })

  test('there is no rename', async () => {
    const view = await openFirst()
    assert.equal(view.find({ type: 'Button', text: /Rename/ }), null)
    assert.equal(view.findAll({ type: 'Input' }).length, 0)
    clean(view)
  })
})
