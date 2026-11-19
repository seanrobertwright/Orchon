// The frame seam for chat drafts: src/panel.tsx mounted on a scripted worker that answers the
// chat list, the thread, a send, a new chat's projects and the drafts. These tests cover what the
// composer shows from the worker's drafts, and when it hands the typed text to the worker.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { sampleChats } from '../scripts/chat-samples.ts'
import { connected } from '../scripts/connection-samples.ts'
import { answeringThread, sampleThread } from '../scripts/chat-thread-samples.ts'
import type { ChatSendOutcome } from './chat-send-view'
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

const MESSAGE = { type: 'Textarea', label: "Message to Archon's agent" }

type Script = { drafts?: Record<string, string>; send?: () => ChatSendOutcome | Promise<ChatSendOutcome>; openChat?: string }

async function mountChat(script: Script = {}): Promise<TestPanel> {
  const base = answeringThread((request) => sampleThread(3, request), { chats: (request) => sampleChats(4, request) })
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'chat.drafts.read': { drafts: script.drafts ?? {} },
        'chat.draft.write': null,
        'chat.send': async () => ({ connection: connected, outcome: await (script.send ?? ((): ChatSendOutcome => ({ kind: 'sent', conversationId: 'web-chat-0' })))() }),
        'chat.projects': (request: { codebaseId?: string }) => ({
          connection: connected,
          projects: { kind: 'ready', chosen: request.codebaseId === 'cb-web' ? { id: 'cb-web', name: 'acme/web', defaultCwd: '/home/someone/code/acme-web' } : null, projects: [], more: 0, unreadable: 0 }
        })
      }
    }),
    persisted: { workspace: { section: 'chat', ...(script.openChat === undefined ? {} : { openChat: script.openChat }) } }
  })
  return panel
}

/** The inputs of every draft write the panel sent, in order. */
const draftWrites = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'chat.draft.write')
    .map((params) => (params as { input?: unknown }).input ?? null)

async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

describe('chat drafts in the panel', () => {
  test("a panel that mounts again on a thread shows the draft the worker kept for it", async () => {
    const view = await mountChat({ openChat: 'web-chat-3', drafts: { 'conversation:web-chat-3': 'Kept from before', 'conversation:web-chat-1': 'Another' } })
    assert.equal(view.valueOf(MESSAGE), 'Kept from before')
    clean(view)
  })

  test("a new chat shows the draft the worker kept for the scope's project", async () => {
    const view = await mountChat({ drafts: { 'new:cb-web': 'Hello there' } })
    await view.press({ type: 'Button', text: 'New chat' })
    assert.equal(view.valueOf(MESSAGE), 'Hello there')
    clean(view)
  })

  test('the typed text goes to the worker once, after a pause in typing', async () => {
    const view = await mountChat({ openChat: 'web-chat-0' })
    await view.type(MESSAGE, 'Hel')
    await advance(view, 300)
    await view.type(MESSAGE, 'lo')
    await advance(view, 300)
    assert.deepEqual(draftWrites(view), [])
    await advance(view, 200)
    assert.deepEqual(draftWrites(view), [{ key: 'conversation:web-chat-0', text: 'Hello' }])
    await advance(view, 5_000)
    assert.equal(draftWrites(view).length, 1)
    clean(view)
  })

  test('what still waits for the pause goes to the worker when the panel unmounts', async () => {
    const view = await mountChat({ openChat: 'web-chat-0' })
    await view.type(MESSAGE, 'Switching panels now')
    const host = view.host
    await view.unmount()
    panel = undefined
    const writes = host
      .callsOf('plugin.request')
      .filter((params) => (params as { name: string }).name === 'chat.draft.write')
      .map((params) => (params as { input?: unknown }).input)
    assert.deepEqual(writes, [{ key: 'conversation:web-chat-0', text: 'Switching panels now' }])
  })

  test('an accepted message clears its draft in the worker at once, and the old text is never written after', async () => {
    const view = await mountChat({ openChat: 'web-chat-0' })
    await view.type(MESSAGE, 'Send me')
    await view.press({ type: 'Button', text: 'Send' })
    assert.deepEqual(draftWrites(view), [{ key: 'conversation:web-chat-0', text: '' }])
    await advance(view, 5_000)
    assert.deepEqual(draftWrites(view), [{ key: 'conversation:web-chat-0', text: '' }])
    clean(view)
  })

  test('a send that timed out keeps the text, and its draft', async () => {
    const view = await mountChat({ openChat: 'web-chat-0', send: () => ({ kind: 'timeout', timeoutMs: 30_000 }) })
    await view.type(MESSAGE, 'Maybe sent')
    await view.press({ type: 'Button', text: 'Send' })
    await advance(view, 500)
    assert.equal(view.valueOf(MESSAGE), 'Maybe sent')
    assert.deepEqual(draftWrites(view), [{ key: 'conversation:web-chat-0', text: 'Maybe sent' }])
    clean(view)
  })
})
