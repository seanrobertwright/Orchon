// The frame seam for a chat thread: src/panel.tsx mounted on a scripted worker that answers the
// chat list, the thread, the scope and the runs table. These tests cover how a row opens the
// thread, what the thread draws, and when the panel asks the worker for it again.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestElement, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { sampleChats } from '../scripts/chat-samples.ts'
import { searching } from '../scripts/connection-samples.ts'
import { answeringThread, sampleMessage, sampleThread } from '../scripts/chat-thread-samples.ts'
import type { ThreadMessage, ThreadRequest, ThreadView } from './chat-thread-view'
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

/** The panel on the Chat section, with the list of four sample conversations. */
async function mountChat(thread: (request: ThreadRequest) => ThreadView): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answeringThread(thread, { chats: (request) => sampleChats(4, request) })),
    persisted: { workspace: { section: 'chat' } }
  })
  return panel
}

/** Mounts the Chat section and opens the first conversation of the list. */
async function openFirst(thread: (request: ThreadRequest) => ThreadView): Promise<TestPanel> {
  const view = await mountChat(thread)
  await view.press({ type: 'ListItem', label: /^Question 0/ })
  return view
}

/** Every thread request the panel sent, by its input, in order. */
const sent = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'chat.read')
    .map((params) => (params as { input?: unknown }).input ?? null)

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

describe('opening a thread', () => {
  test('a row opens its thread: a back control and the Show tool calls switch, the title, the project and its folder', async () => {
    const view = await openFirst((request) => sampleThread(3, request))
    assert.deepEqual(sent(view), [{ conversationId: 'web-chat-0', limit: 50 }])
    assert.ok(view.find({ type: 'Button', text: 'Chats' }))
    const toggle = view.find({ type: 'Switch', label: 'Show tool calls' })
    assert.equal(toggle?.props.checked, false)
    assert.ok(view.find({ type: 'Heading', text: 'Question 0' }))
    assert.ok(view.find({ text: 'acme/web' }))
    assert.ok(view.find({ text: '/home/someone/code/acme-web' }))
    // The list is gone.
    assert.equal(view.find({ type: 'List', label: 'Conversations' }), null)
    clean(view)
  })

  test('messages are drawn newest first as Markdown, each with its role and a relative time', async () => {
    const view = await openFirst((request) => sampleThread(3, request))
    assert.deepEqual(
      view.findAll({ type: 'Markdown' }).map((node) => node.props.content),
      ['Reply **0**', 'Question 1', 'Reply **2**']
    )
    assert.deepEqual(
      view.findAll({ type: 'Text', text: /^(Agent|You)$/ }).map((node) => node.text),
      ['Agent', 'You', 'Agent']
    )
    assert.deepEqual(
      view.findAll({ type: 'RelativeTime' }).map((time) => time.props.at),
      [0, 1, 2].map((index) => sampleMessage(index).at)
    )
    clean(view)
  })

  test('with no title the thread says "Untitled", and with no project it says so', async () => {
    const view = await openFirst((request) => sampleThread(1, request, { title: null, project: null }))
    assert.ok(view.find({ type: 'Heading', text: 'Untitled' }))
    assert.ok(view.find({ text: 'No project' }))
    clean(view)
  })
})

const SECTION_BAR = { label: 'Orchon sections' }

/** Moves the frame's clock and lets what fell due run. */
async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

/** Every Stack that holds Markdown blocks alone, more than one: its gap and how many blocks it holds. */
function blockHolders(root: TreeSnapshot | string | null): { gap: unknown; blocks: number }[] {
  const found: { gap: unknown; blocks: number }[] = []
  const walk = (node: TreeSnapshot | string | null): void => {
    if (node === null || typeof node === 'string') return
    const children = (node.children ?? []).filter((child) => typeof child !== 'string')
    if (node.type === 'Stack' && children.length > 1 && children.every((child) => child.type === 'Markdown')) {
      found.push({ gap: node.props?.gap, blocks: children.length })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}

/** A thread whose newest message is `message`, over the sample ones. */
const withMessage =
  (message: Partial<ThreadMessage>) =>
  (request: ThreadRequest): ThreadView => {
    const view = sampleThread(2, request)
    if (view.kind !== 'ready') return view
    return { ...view, thread: { ...view.thread, messages: [{ ...sampleMessage(0), id: 'msg-special', ...message }, ...view.thread.messages.slice(1)] } }
  }

describe('what a message shows', () => {
  test('a long message is drawn as its blocks, one under the other with no gap, and a cut one says how much is not shown', async () => {
    const view = await openFirst(withMessage({ blocks: ['Part one\n\n', 'Part two\n\n', 'Part three'], notShown: 1_234 }))
    const blocks = view.findAll({ type: 'Markdown' }).slice(0, 3)
    assert.deepEqual(
      blocks.map((node) => node.props.content),
      ['Part one\n\n', 'Part two\n\n', 'Part three']
    )
    assert.deepEqual(blockHolders(view.tree()), [{ gap: 'none', blocks: 3 }])
    assert.ok(view.find({ type: 'Text', text: '1234 characters of this message are not shown.' }))
    clean(view)
  })

  test('a system message is plain text, not Markdown', async () => {
    const view = await openFirst(withMessage({ role: 'system', format: 'text', blocks: ['**not bold**'] }))
    assert.ok(view.find({ type: 'Text', text: 'System' }))
    assert.ok(view.find({ type: 'Text', text: '**not bold**' }))
    assert.equal(
      view.findAll({ type: 'Markdown' }).some((node) => node.props.content === '**not bold**'),
      false
    )
    clean(view)
  })

  test('error metadata is a danger callout with the error in words', async () => {
    const view = await openFirst(withMessage({ error: 'The provider stopped.' }))
    const callout = view.find({ type: 'Callout', text: /The provider stopped\./ })
    assert.equal(callout?.props.tone, 'danger')
    assert.equal(callout?.props.title, 'Error')
    clean(view)
  })

  test('a message sent with files lists their names only', async () => {
    const view = await openFirst(withMessage({ role: 'user', files: { names: ['plan.md', 'shot.png'], notShown: 0 } }))
    assert.ok(view.find({ type: 'Text', text: 'Sent with 2 files: plan.md, shot.png' }))
    clean(view)
  })
})

describe('tool calls', () => {
  const calls = {
    calls: [
      { id: 'msg-special-0', name: 'Read', input: '{\n  "file_path": "a.ts"\n}', inputNotShown: 0, output: 'export const a = 1', outputNotShown: 20 },
      { id: 'msg-special-1', name: 'Bash', input: null, inputNotShown: 0, output: null, outputNotShown: 0 }
    ],
    notShown: 2
  }

  test('are hidden until the switch is on; then the thread asks for them and draws each as a collapsed row with code views', async () => {
    const view = await openFirst((request) => withMessage(request.toolCalls === true ? { blocks: [], toolCalls: calls } : { blocks: [] })(request))
    // A message of tool calls alone has nothing to show while they are hidden.
    assert.equal(view.find({ type: 'Collapsible' }), null)
    assert.equal(view.findAll({ type: 'Text', text: /^(Agent|You)$/ }).length, 1)
    await view.toggle({ type: 'Switch', label: 'Show tool calls' })
    assert.deepEqual(sent(view).at(-1), { conversationId: 'web-chat-0', limit: 50, toolCalls: true })
    assert.equal(view.find({ type: 'Switch', label: 'Show tool calls' })?.props.checked, true)
    const rows = view.findAll({ type: 'Collapsible' })
    assert.deepEqual(
      rows.map((row) => [row.props.title, row.props.open ?? row.props.defaultOpen ?? false]),
      [
        ['Read', false],
        ['Bash', false]
      ]
    )
    // Collapsed: the code views show only once a row is opened.
    assert.equal(view.find({ type: 'CodeView' }), null)
    await view.toggle(rows[0] as TestElement)
    assert.deepEqual(
      view.findAll({ type: 'CodeView' }).map((code) => [code.props.label, code.props.code]),
      [
        ['Input of Read', '{\n  "file_path": "a.ts"\n}'],
        ['Output of Read', 'export const a = 1']
      ]
    )
    assert.ok(view.find({ type: 'Text', text: '20 characters of the output are not shown.' }))
    await view.toggle(view.findAll({ type: 'Collapsible' })[1] as TestElement)
    assert.ok(view.find({ type: 'Text', text: 'No input was saved.' }))
    assert.ok(view.find({ type: 'Text', text: 'No output was saved.' }))
    assert.ok(view.find({ type: 'Text', text: '2 more tool calls are not shown.' }))
    await view.toggle({ type: 'Switch', label: 'Show tool calls' })
    assert.deepEqual(sent(view).at(-1), { conversationId: 'web-chat-0', limit: 50 })
    assert.equal(view.find({ type: 'Collapsible' }), null)
    clean(view)
  })
})

describe('older messages', () => {
  test('Show earlier asks for 50 more, up to 500, where a line says older messages cannot be fetched', async () => {
    const view = await openFirst((request) => sampleThread(600, request))
    for (const expected of [100, 150, 200, 250, 300, 350, 400, 450, 500]) {
      await view.press({ type: 'Button', text: 'Show earlier' })
      assert.deepEqual(sent(view).at(-1), { conversationId: 'web-chat-0', limit: expected })
    }
    assert.equal(view.find({ type: 'Button', text: 'Show earlier' }), null)
    assert.ok(view.find({ type: 'Text', text: 'Archon sends only the 500 newest messages, so older messages cannot be fetched.' }))
    clean(view)
  })

  test('a whole thread offers nothing earlier', async () => {
    const view = await openFirst((request) => sampleThread(3, request))
    assert.equal(view.find({ type: 'Button', text: 'Show earlier' }), null)
    assert.equal(view.find({ text: /cannot be fetched/ }), null)
    clean(view)
  })

  test('says how many older messages the worker cut, and how many could not be read', async () => {
    const view = await openFirst((request) => sampleThread(3, request, { cut: 12, unreadable: 2 }))
    assert.ok(view.find({ type: 'Text', text: /^12 older messages are not shown: the thread is too long to show at once\./ }))
    assert.ok(view.find({ type: 'Text', text: '2 messages could not be read and are not shown.' }))
    clean(view)
  })
})

describe('when the thread is read', () => {
  test('every 30 seconds while it shows, never while another section shows, and at once when it shows again', async () => {
    const view = await openFirst((request) => sampleThread(2, request))
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
    assert.ok(view.find({ type: 'Heading', text: 'Question 0' }))
    clean(view)
  })

  test('the list is not read while the thread shows, and the back control shows it and reads it again', async () => {
    const view = await openFirst((request) => sampleThread(2, request))
    const listReads = (): number => view.host.callsOf('plugin.request').filter((params) => (params as { name: string }).name === 'chats.read').length
    const before = listReads()
    await advance(view, 60_000)
    assert.equal(listReads(), before)
    await view.press({ type: 'Button', text: 'Chats' })
    assert.equal(listReads(), before + 1)
    assert.ok(view.find({ type: 'List', label: 'Conversations' }))
    // The thread is no longer read once the list shows.
    const threadReads = sent(view).length
    await advance(view, 30_000)
    await advance(view, 30_000)
    assert.equal(sent(view).length, threadReads)
    clean(view)
  })

  test('when the conversation no longer exists the thread says so and offers the way back to the list', async () => {
    const view = await openFirst(() => ({ kind: 'gone' }))
    assert.ok(view.find({ type: 'Text', text: 'This conversation no longer exists in Archon.' }))
    await view.press({ type: 'Button', text: 'Back to conversations' })
    assert.ok(view.find({ type: 'List', label: 'Conversations' }))
    clean(view)
  })

  test('Searching keeps the loaded thread under its banner', async () => {
    const view = await openFirst((request) => sampleThread(2, request))
    await view.post('connection.changed', { ...searching, since: Date.now() + 1 })
    assert.ok(view.find({ type: 'Text', text: /Archon stopped answering/ }))
    assert.ok(view.find({ type: 'Heading', text: 'Question 0' }))
    clean(view)
  })

  test('the open thread is kept per workspace: a panel that mounts again shows it', async () => {
    panel = await mount(panelModule, {
      host: mockHost(answeringThread((request) => sampleThread(2, request))),
      persisted: { workspace: { section: 'chat', openChat: 'web-chat-3' } }
    })
    assert.deepEqual(sent(panel), [{ conversationId: 'web-chat-3', limit: 50 }])
    assert.ok(panel.find({ type: 'Heading', text: 'Question 0' }))
    clean(panel)
  })

  test('a failed read keeps the thread under one warning line', async () => {
    let fail = false
    const view = await openFirst((request) => (fail ? { kind: 'failed', message: 'Archon answered with an error (500).' } : sampleThread(2, request)))
    fail = true
    await advance(view, 30_000)
    assert.ok(view.find({ type: 'Callout', text: /Archon answered with an error \(500\)\./ }))
    assert.ok(view.find({ type: 'Heading', text: 'Question 0' }))
    clean(view)
  })
})
