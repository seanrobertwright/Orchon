// The frame seam for sending a chat message: src/panel.tsx mounted on a scripted worker that
// answers the chat list, the thread, a send and a new chat's projects. These tests cover the
// composer, what a send asks the worker, what the panel does with each outcome, the working line
// and the busy refetch, drafts, and New chat.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { sampleChats } from '../scripts/chat-samples.ts'
import { searching } from '../scripts/connection-samples.ts'
import { unmatchedGit } from '../scripts/scope-samples.ts'
import { answeringThread, sampleMessage, sampleThread } from '../scripts/chat-thread-samples.ts'
import type { ChatProjectsRequest, ChatProjectsView, ChatSendOutcome, ChatSendRequest } from './chat-send-view'
import type { ThreadMessage, ThreadRequest, ThreadView } from './chat-thread-view'
import type { ScopeView } from './scope-view'
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
const HINT = 'Enter adds a line. Ctrl+Enter sends (Cmd+Enter on macOS).'

type Script = {
  thread?: (request: ThreadRequest) => ThreadView
  send?: (request: ChatSendRequest) => ChatSendOutcome | Promise<ChatSendOutcome>
  projects?: (request: ChatProjectsRequest) => ChatProjectsView
  scope?: () => ScopeView
}

const ACME = { id: 'cb-web', name: 'acme/web', defaultCwd: '/home/someone/code/acme-web' }
const OTHER = { id: 'cb-api', name: 'acme/api', defaultCwd: '/home/someone/code/acme-api' }

/** The panel on the Chat section, with four sample conversations and a worker answering `script`. */
async function mountChat(script: Script = {}): Promise<TestPanel> {
  const base = answeringThread(script.thread ?? ((request) => sampleThread(3, request)), {
    chats: (request) => sampleChats(4, request),
    ...(script.scope === undefined ? {} : { scope: script.scope })
  })
  const connection = (await import('../scripts/connection-samples.ts')).connected
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'chat.send': async (request: ChatSendRequest) => ({
          connection,
          outcome: await (script.send ?? ((): ChatSendOutcome => ({ kind: 'sent', conversationId: 'web-chat-0' })))(request)
        }),
        'chat.projects': (request: ChatProjectsRequest) => ({
          connection,
          projects: (script.projects ?? ((asked) => ({ kind: 'ready', chosen: asked.codebaseId === ACME.id ? ACME : null, projects: [OTHER, ACME], more: 0, unreadable: 0 })))(request)
        })
      }
    }),
    persisted: { workspace: { section: 'chat' } }
  })
  return panel
}

async function openFirst(script: Script = {}): Promise<TestPanel> {
  const view = await mountChat(script)
  await view.press({ type: 'ListItem', label: /^Question 0/ })
  return view
}

/** The inputs of every request of one name the panel sent, in order. */
const sent = (view: TestPanel, name: string): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input?: unknown }).input ?? null)

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/** The order in which the drawn tree first reaches each text, as indexes into the summary of text nodes. */
function textOrder(view: TestPanel, texts: (string | RegExp)[]): number[] {
  const all: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      all.push(node)
      return
    }
    if (node === null || typeof node !== 'object') return
    const element = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
    if (element.type !== undefined) all.push(`<${element.type} ${String(element.props?.label ?? element.props?.content ?? '')}>`)
    for (const child of element.children ?? []) walk(child)
  }
  walk(view.tree())
  return texts.map((text) => all.findIndex((entry) => (typeof text === 'string' ? entry.includes(text) : text.test(entry))))
}

describe('the composer', () => {
  test("sits at the top of the thread, above the messages: a labelled text area capped at Orca's 16,384 characters, Send and the hint line, and no Stop, attachment or command menu", async () => {
    const view = await openFirst()
    const area = view.find(MESSAGE)
    assert.ok(area)
    assert.equal(area.props.maxLength, 16_384)
    assert.ok(view.find(SEND))
    assert.ok(view.find({ type: 'Text', text: HINT }))
    const [composer, newest] = textOrder(view, [/^<Textarea Message to Archon's agent>$/, 'Reply **0**'])
    assert.ok(composer !== undefined && newest !== undefined && composer >= 0 && composer < newest, `composer ${String(composer)} before ${String(newest)}`)
    assert.equal(view.find({ type: 'Button', text: /Stop|Attach/ }), null)
    assert.equal(view.findAll({ type: 'Textarea' }).length, 1)
    clean(view)
  })

  test('Enter adds a line and sends nothing; Ctrl+Enter sends the text exactly as typed, slash command and all', async () => {
    const view = await openFirst()
    await view.type(MESSAGE, '/status\nand more ')
    assert.deepEqual(sent(view, 'chat.send'), [])
    await view.submit(MESSAGE)
    assert.deepEqual(sent(view, 'chat.send'), [{ conversationId: 'web-chat-0', message: '/status\nand more ' }])
    clean(view)
  })
})

describe('what the composer will not send', () => {
  test('Send is off for an empty message and for text past 32 KiB of UTF-8, which a line says', async () => {
    const view = await openFirst()
    assert.equal(view.find(SEND)?.props.disabled, true)
    await view.submit(MESSAGE)
    // 11,000 characters of three bytes each: 33,000 bytes.
    await view.type(MESSAGE, '€'.repeat(11_000), { replace: true })
    assert.equal(view.find(SEND)?.props.disabled, true)
    assert.ok(view.find({ type: 'Text', text: 'The message is 33000 bytes; Archon takes at most 32768. Shorten it to send.' }))
    await view.submit(MESSAGE)
    await view.type(MESSAGE, 'Hello', { replace: true })
    assert.equal(view.find(SEND)?.props.disabled, false)
    assert.deepEqual(sent(view, 'chat.send'), [])
    clean(view)
  })
})

describe('what the composer sends', () => {
  test('a message of blanks only is 1 character or more, so Send is on and it goes as typed', async () => {
    const view = await openFirst()
    await view.type(MESSAGE, '   \n ')
    assert.equal(view.find(SEND)?.props.disabled, false)
    await view.press(SEND)
    assert.deepEqual(sent(view, 'chat.send'), [{ conversationId: 'web-chat-0', message: '   \n ' }])
    clean(view)
  })
})

describe('what a send does', () => {
  test('an accepted message empties the composer and the thread is read again at once', async () => {
    const view = await openFirst()
    const reads = sent(view, 'chat.read').length
    await view.type(MESSAGE, 'Hello')
    await view.press(SEND)
    assert.deepEqual(sent(view, 'chat.send'), [{ conversationId: 'web-chat-0', message: 'Hello' }])
    assert.equal(view.find(MESSAGE)?.props.value, '')
    assert.ok(sent(view, 'chat.read').length > reads)
    clean(view)
  })

  test('a send that timed out is not sent again: the text stays, a note says why, and the thread is read again', async () => {
    const view = await openFirst({ send: () => ({ kind: 'timeout', timeoutMs: 30_000 }) })
    const reads = sent(view, 'chat.read').length
    await view.type(MESSAGE, 'Hello')
    await view.press(SEND)
    assert.equal(view.valueOf(MESSAGE), 'Hello')
    assert.ok(view.find({ text: 'Archon did not answer within 30 seconds. The message may have arrived, so it was not sent again; your text is still here.' }))
    assert.ok(sent(view, 'chat.read').length > reads)
    mock.timers.tick(60_000)
    await view.settled()
    assert.equal(sent(view, 'chat.send').length, 1)
    clean(view)
  })

  test("a refusal keeps the text and says the worker's words", async () => {
    const view = await openFirst({ send: () => ({ kind: 'refused', message: 'Conversation is not a web conversation' }) })
    await view.type(MESSAGE, 'Hello')
    await view.press(SEND)
    assert.equal(view.valueOf(MESSAGE), 'Hello')
    assert.ok(view.find({ text: 'Conversation is not a web conversation' }))
    clean(view)
  })

  test('one write at a time: while a send waits for the worker the composer is off', async () => {
    const seen: unknown[] = []
    // The worker answers after the panel has drawn the send in flight; what it drew then is noted.
    const view = await openFirst({
      async send() {
        for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
        seen.push(panel?.find(SEND)?.props.disabled, panel?.find(MESSAGE)?.props.disabled)
        return { kind: 'refused', message: 'No.' }
      }
    })
    await view.type(MESSAGE, 'Hello')
    await view.press(SEND)
    assert.deepEqual(seen, [true, true])
    assert.equal(sent(view, 'chat.send').length, 1)
    assert.equal(view.find(SEND)?.props.disabled, false)
    clean(view)
  })

  test('while Searching the thread stays under its banner, the text stays and Send is off', async () => {
    const view = await openFirst()
    await view.type(MESSAGE, 'Hello')
    await view.post('connection.changed', { ...searching, since: Date.now() + 1 })
    assert.equal(view.find(SEND)?.props.disabled, true)
    assert.equal(view.valueOf(MESSAGE), 'Hello')
    await view.submit(MESSAGE)
    assert.deepEqual(sent(view, 'chat.send'), [])
    clean(view)
  })
})

/** A message of the person's, saved `ago` milliseconds before the clock's start. */
const question = (id: string, ago: number): ThreadMessage => ({ ...sampleMessage(1), id, at: NOON - ago, blocks: [`Question ${id}`] })
/** A reply of the agent's. */
const reply = (id: string, text = `Reply ${id}`): ThreadMessage => ({ ...sampleMessage(0), id, at: NOON, blocks: [text] })

/** A thread whose messages, newest first, are whatever `messages` holds at each read. */
function liveThread(messages: { now: ThreadMessage[] }): (request: ThreadRequest) => ThreadView {
  return (request) => sampleThread(0, request, { messages: messages.now })
}

const WORKING = { type: 'Spinner', label: 'Working…' }

async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

describe('while the conversation is busy', () => {
  test('after an accepted send the composer is off, the working line sits directly under it, and the thread is read every 3 seconds', async () => {
    const messages = { now: [reply('r1'), question('q1', 120_000)] }
    const view = await openFirst({
      thread: liveThread(messages),
      send: (request) => {
        messages.now = [question('q2', 0), ...messages.now]
        return { kind: 'sent', conversationId: (request as { conversationId: string }).conversationId }
      }
    })
    await view.type(MESSAGE, 'Hello')
    await view.press(SEND)
    assert.equal(view.find(MESSAGE)?.props.disabled, true)
    assert.equal(view.find(SEND)?.props.disabled, true)
    assert.ok(view.find(WORKING))
    const [hint, working, newest] = textOrder(view, [HINT, /^<Spinner Working…>$/, 'Question q2'])
    assert.ok(hint !== undefined && working !== undefined && newest !== undefined && hint < working && working < newest, `${String(hint)} < ${String(working)} < ${String(newest)}`)
    const reads = sent(view, 'chat.read').length
    await advance(view, 3_000)
    assert.equal(sent(view, 'chat.read').length, reads + 1)
    await advance(view, 3_000)
    assert.equal(sent(view, 'chat.read').length, reads + 2)
    assert.ok(view.find(WORKING))
    clean(view)
  })

  test('a reply unchanged for 6 seconds ends the turn: the composer is on again and the thread goes back to every 30 seconds', async () => {
    const messages = { now: [question('q1', 1_000)] }
    const view = await openFirst({ thread: liveThread(messages) })
    // A trailing message of the person's means busy, with no send from this panel.
    assert.ok(view.find(WORKING))
    assert.equal(view.find(MESSAGE)?.props.disabled, true)
    messages.now = [reply('r1', 'Part'), ...messages.now]
    await advance(view, 3_000)
    assert.ok(view.find(WORKING), 'a reply just seen may still grow')
    messages.now = [reply('r1', 'Part and more'), question('q1', 1_000)]
    await advance(view, 3_000)
    assert.ok(view.find(WORKING), 'the reply changed, so the 6 seconds start again')
    await advance(view, 3_000)
    assert.ok(view.find(WORKING))
    await advance(view, 3_000)
    assert.equal(view.find(WORKING), null)
    assert.equal(view.find(MESSAGE)?.props.disabled, false)
    const reads = sent(view, 'chat.read').length
    await advance(view, 3_000)
    assert.equal(sent(view, 'chat.read').length, reads)
    await advance(view, 27_000)
    assert.equal(sent(view, 'chat.read').length, reads + 1)
    clean(view)
  })

  test('after 5 minutes with no reply the composer unlocks with a note that Archon may still be working', async () => {
    const messages = { now: [question('q1', 0)] }
    const view = await openFirst({ thread: liveThread(messages) })
    assert.ok(view.find(WORKING))
    await advance(view, 297_000)
    assert.ok(view.find(WORKING))
    await advance(view, 3_000)
    assert.equal(view.find(WORKING), null)
    assert.equal(view.find(MESSAGE)?.props.disabled, false)
    assert.ok(view.find({ text: 'No reply came within 5 minutes, so you can write again. Archon may still be working on it.' }))
    // A reply that comes later ends the note.
    messages.now = [reply('r1'), ...messages.now]
    await advance(view, 30_000)
    assert.equal(view.find({ text: /No reply came within 5 minutes/ }), null)
    clean(view)
  })

  test("a person's message older than 5 minutes is not waited for: the composer is on, with the note", async () => {
    const view = await openFirst({ thread: liveThread({ now: [question('q1', 10 * 60_000)] }) })
    assert.equal(view.find(WORKING), null)
    assert.equal(view.find(MESSAGE)?.props.disabled, false)
    assert.ok(view.find({ text: /No reply came within 5 minutes/ }))
    clean(view)
  })

  test('a thread whose newest message is the agent\'s is not busy', async () => {
    const view = await openFirst()
    assert.equal(view.find(WORKING), null)
    assert.equal(view.find(MESSAGE)?.props.disabled, false)
    clean(view)
  })
})

describe('drafts', () => {
  test('the typed text is kept per conversation while the panel is open', async () => {
    const view = await openFirst()
    await view.type(MESSAGE, 'Half a thought')
    await view.press({ type: 'Button', text: 'Chats' })
    await view.press({ type: 'ListItem', label: /^Question 1/ })
    assert.equal(view.valueOf(MESSAGE), '')
    await view.type(MESSAGE, 'Another')
    await view.press({ type: 'Button', text: 'Chats' })
    await view.press({ type: 'ListItem', label: /^Question 0/ })
    assert.equal(view.valueOf(MESSAGE), 'Half a thought')
    clean(view)
  })
})

const NEW_CHAT = { type: 'Button', text: 'New chat' }
const ABOUT = "Archon chat talks to Archon's agent about this project. It can start workflows, and it works in the project folder named in the header, not in this workspace's terminal."

describe('New chat', () => {
  test('opens an empty thread: the project and its folder, the composer, and an empty state that says what Archon chat is', async () => {
    const view = await mountChat()
    assert.equal(view.find(NEW_CHAT)?.props.disabled, undefined)
    await view.press(NEW_CHAT)
    assert.deepEqual(sent(view, 'chat.projects'), [{ codebaseId: 'cb-web' }])
    assert.ok(view.find({ type: 'Heading', text: 'New chat' }))
    assert.ok(view.find({ text: 'acme/web' }))
    assert.ok(view.find({ text: '/home/someone/code/acme-web' }))
    assert.ok(view.find(MESSAGE))
    assert.equal(view.find({ type: 'EmptyState' })?.props.description, ABOUT)
    assert.equal(view.find({ type: 'List', label: 'Conversations' }), null)
    assert.deepEqual(sent(view, 'chat.read'), [])
    await view.press({ type: 'Button', text: 'Chats' })
    assert.ok(view.find({ type: 'List', label: 'Conversations' }))
    clean(view)
  })

  test("the first send creates the conversation in the panel's project, then its thread opens, busy", async () => {
    const view = await mountChat({ send: () => ({ kind: 'sent', conversationId: 'web-new-1' }), thread: (request) => sampleThread(0, request, { messages: [question('q1', 0)] }) })
    await view.press(NEW_CHAT)
    await view.type(MESSAGE, '/help')
    await view.submit(MESSAGE)
    assert.deepEqual(sent(view, 'chat.send'), [{ codebaseId: 'cb-web', message: '/help' }])
    assert.deepEqual(sent(view, 'chat.read'), [{ conversationId: 'web-new-1', limit: 50 }])
    assert.ok(view.find(WORKING))
    assert.equal(view.find(MESSAGE)?.props.value, '')
    clean(view)
  })

  test('under "All projects" the composer has its own project select with nothing chosen, and Send waits for a choice', async () => {
    const view = await mountChat({ scope: () => unmatchedGit, send: () => ({ kind: 'sent', conversationId: 'web-new-2' }) })
    await view.press(NEW_CHAT)
    assert.deepEqual(sent(view, 'chat.projects').at(-1), {})
    const select = view.find({ type: 'Select', label: 'Project' })
    assert.ok(select)
    assert.equal(select.props.value, undefined)
    assert.deepEqual(
      (select.props.options as { value: string; label: string }[]).map((option) => option.value),
      ['cb-api', 'cb-web']
    )
    await view.type(MESSAGE, 'Hello')
    assert.equal(view.find(SEND)?.props.disabled, true)
    await view.select({ type: 'Select', label: 'Project' }, 'cb-api')
    assert.ok(view.find({ text: '/home/someone/code/acme-api' }))
    assert.equal(view.find(SEND)?.props.disabled, false)
    await view.press(SEND)
    assert.deepEqual(sent(view, 'chat.send'), [{ codebaseId: 'cb-api', message: 'Hello' }])
    clean(view)
  })

  test('a project Archon does not list now cannot start a chat, and a line says so', async () => {
    const view = await mountChat({ projects: () => ({ kind: 'ready', chosen: null, projects: [OTHER], more: 0, unreadable: 0 }) })
    await view.press(NEW_CHAT)
    await view.type(MESSAGE, 'Hello')
    assert.equal(view.find(SEND)?.props.disabled, true)
    assert.ok(view.find({ text: 'Archon does not list this project now, so a chat cannot start in it.' }))
    clean(view)
  })

  test('a first send that timed out is not sent again: the text stays and a note says to look in the list first', async () => {
    const view = await mountChat({ send: () => ({ kind: 'timeout', timeoutMs: 30_000 }) })
    await view.press(NEW_CHAT)
    await view.type(MESSAGE, 'Hello')
    await view.press(SEND)
    assert.equal(view.valueOf(MESSAGE), 'Hello')
    assert.ok(view.find({ text: /^Archon did not answer within 30 seconds\. The message may have arrived/ }))
    assert.ok(view.find({ text: 'The chat may have been created: look in the list before you send again.' }))
    assert.equal(sent(view, 'chat.send').length, 1)
    clean(view)
  })

  test('the new chat draft is kept while the panel is open', async () => {
    const view = await mountChat()
    await view.press(NEW_CHAT)
    await view.type(MESSAGE, 'Draft')
    await view.press({ type: 'Button', text: 'Chats' })
    await view.press(NEW_CHAT)
    assert.equal(view.valueOf(MESSAGE), 'Draft')
    clean(view)
  })
})
