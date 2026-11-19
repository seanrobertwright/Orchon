// The frame seam for the links between chat and runs: src/panel.tsx mounted on a scripted worker
// that answers the runs table, run detail, the chat list, a thread and the run lookup of a
// dispatch row. These tests cover Open conversation in run detail, and Open run on a thread's
// dispatch row and result card: which section shows, what opens there and which requests go.
import { mock } from 'node:test'
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { answeringThread, sampleMessage, sampleThread } from '../scripts/chat-thread-samples.ts'
import { connected } from '../scripts/connection-samples.ts'
import { sampleDetail } from '../scripts/runs-samples.ts'
import type { ChatRunRequest, ChatRunView } from './chat-run-view'
import { messageDrawCost, type ThreadMessage, type ThreadRequest, type ThreadView } from './chat-thread-view'
import * as panelModule from './panel'
import type { RunDetail, RunDetailRequest } from './run-detail-view'

const SECTION_BAR = { label: 'Orchon sections' }

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

type Script = {
  detail?: (request: RunDetailRequest) => RunDetail
  thread?: (request: ThreadRequest) => ThreadView
  findRun?: (request: ChatRunRequest) => ChatRunView
}

/** The panel on a scripted worker, opened on what `persisted` names for the workspace. */
async function mountLinks(script: Script, persisted: Record<string, unknown>): Promise<TestPanel> {
  const base = answeringThread(script.thread ?? ((request) => sampleThread(2, request)))
  const detail = script.detail ?? ((request: RunDetailRequest) => sampleDetail(Number(request.runId.slice(4))))
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'run.read': (request: RunDetailRequest) => ({ connection: connected, run: { kind: 'ready', detail: detail(request) } }),
        'chat.findRun': (request: ChatRunRequest) => ({ connection: connected, run: script.findRun?.(request) ?? { kind: 'not-created' } })
      }
    }),
    persisted: { workspace: persisted }
  })
  return panel
}

/** Every request of one name the panel sent, by its input, in order. */
function requests(view: TestPanel, name: string): unknown[] {
  return view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input?: unknown }).input ?? null)
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

const OPEN_CONVERSATION = { type: 'Button', text: 'Open conversation' }

describe('Open conversation in run detail', () => {
  test("a run started from a chat opens that conversation's thread in the Chat section, read by its id", async () => {
    const view = await mountLinks(
      {
        detail: (request) => ({ ...sampleDetail(Number(request.runId.slice(4))), conversationId: 'web-launch-7' }),
        thread: (request) => sampleThread(2, request, { title: 'The launch conversation' })
      },
      { section: 'runs', openRun: 'run-1' }
    )
    await view.press(OPEN_CONVERSATION)
    assert.equal(view.valueOf(SECTION_BAR), 'chat')
    assert.deepEqual(requests(view, 'chat.read'), [{ conversationId: 'web-launch-7', limit: 50 }])
    // An ordinary thread: its header, its title and its messages.
    assert.ok(view.find({ type: 'Button', text: 'Chats' }))
    assert.ok(view.find({ type: 'Heading', text: 'The launch conversation' }))
    assert.ok(view.findAll({ type: 'Markdown' }).some((node) => node.props.content === 'Reply **0**'))
    // The chat list was not read: the thread is reached by id, listed or not.
    assert.deepEqual(requests(view, 'chats.read'), [])
    clean(view)
  })

  test('the thread stays open in the Chat section, and run detail in Runs, when a person moves between them', async () => {
    const view = await mountLinks(
      { detail: (request) => ({ ...sampleDetail(Number(request.runId.slice(4))), conversationId: 'web-launch-7' }) },
      { section: 'runs', openRun: 'run-1' }
    )
    await view.press(OPEN_CONVERSATION)
    await view.select(SECTION_BAR, 'runs')
    assert.ok(view.find(OPEN_CONVERSATION))
    await view.select(SECTION_BAR, 'chat')
    assert.ok(view.find({ type: 'Button', text: 'Chats' }))
    clean(view)
  })

  test('a run started from the CLI, with no conversation, has no such control', async () => {
    const view = await mountLinks({}, { section: 'runs', openRun: 'run-1' })
    assert.ok(view.find({ type: 'Button', text: 'Open graph' }))
    assert.equal(view.find(OPEN_CONVERSATION), null)
    clean(view)
  })
})

/** A thread whose newest messages are `messages`, over the sample ones. */
const threadWith =
  (...messages: ThreadMessage[]) =>
  (request: ThreadRequest): ThreadView => {
    const view = sampleThread(2, request)
    if (view.kind !== 'ready') return view
    return { ...view, thread: { ...view.thread, messages: [...messages, ...view.thread.messages] } }
  }

const dispatchMessage = (workerId: string | null): ThreadMessage => ({
  ...sampleMessage(0),
  id: 'msg-dispatch',
  blocks: [],
  dispatch: { workflow: 'deploy-site', workerId }
})

const resultMessage: ThreadMessage = {
  ...sampleMessage(0),
  id: 'msg-result',
  blocks: ['The site is **live**.'],
  notShown: 1_500,
  result: { workflow: 'deploy-site', runId: 'run-5' }
}

describe('a dispatch row in the thread', () => {
  test('shows a "Started workflow" badge, the workflow and Open run, and none of its content', async () => {
    const view = await mountLinks({ thread: threadWith(dispatchMessage('web-worker-9')) }, { section: 'chat', openChat: 'web-chat-0' })
    assert.ok(view.find({ type: 'Badge', text: 'Started workflow' }))
    assert.ok(view.find({ type: 'Text', text: 'deploy-site' }))
    assert.ok(view.find({ type: 'Button', text: 'Open run' }))
    clean(view)
  })

  test("Open run finds the run by the worker conversation and opens its detail in the Runs section", async () => {
    const view = await mountLinks(
      { thread: threadWith(dispatchMessage('web-worker-9')), findRun: () => ({ kind: 'found', runId: 'run-4' }) },
      { section: 'chat', openChat: 'web-chat-0' }
    )
    await view.press({ type: 'Button', text: 'Open run' })
    assert.deepEqual(requests(view, 'chat.findRun'), [{ workerId: 'web-worker-9' }])
    assert.equal(view.valueOf(SECTION_BAR), 'runs')
    assert.deepEqual(requests(view, 'run.read'), [{ runId: 'run-4', open: true }])
    assert.ok(view.find({ type: 'Text', text: 'workflow-4' }))
    clean(view)
  })

  test('when Archon has no run yet, the row says so and the panel stays on the thread', async () => {
    const view = await mountLinks(
      { thread: threadWith(dispatchMessage('web-worker-9')), findRun: () => ({ kind: 'not-created' }) },
      { section: 'chat', openChat: 'web-chat-0' }
    )
    await view.press({ type: 'Button', text: 'Open run' })
    assert.equal(view.valueOf(SECTION_BAR), 'chat')
    assert.ok(view.find({ type: 'Text', text: 'The run has not been created yet.' }))
    assert.deepEqual(requests(view, 'run.read'), [])
    clean(view)
  })

  test("a failed lookup says the worker's sentence on the row", async () => {
    const view = await mountLinks(
      { thread: threadWith(dispatchMessage('web-worker-9')), findRun: () => ({ kind: 'failed', message: 'Archon did not answer in time.' }) },
      { section: 'chat', openChat: 'web-chat-0' }
    )
    await view.press({ type: 'Button', text: 'Open run' })
    assert.ok(view.find({ type: 'Text', text: 'Archon did not answer in time.' }))
    clean(view)
  })

  test('a dispatch that names no worker conversation has no Open run, and says why', async () => {
    const view = await mountLinks({ thread: threadWith(dispatchMessage(null)) }, { section: 'chat', openChat: 'web-chat-0' })
    assert.ok(view.find({ type: 'Badge', text: 'Started workflow' }))
    assert.equal(view.find({ type: 'Button', text: 'Open run' }), null)
    assert.ok(view.find({ type: 'Text', text: "Archon did not say which run it started." }))
    clean(view)
  })
})

describe('a result card in the thread', () => {
  test('shows the workflow, the summary with how much is not shown, and Open run, which opens the run in the Runs section', async () => {
    const view = await mountLinks({ thread: threadWith(resultMessage) }, { section: 'chat', openChat: 'web-chat-0' })
    const card = view.find({ type: 'Card' })
    assert.equal(card?.props.title, 'deploy-site')
    assert.ok(view.findAll({ type: 'Markdown' }).some((node) => node.props.content === 'The site is **live**.'))
    assert.ok(view.find({ type: 'Text', text: '1500 characters of the summary are not shown.' }))
    await view.press({ type: 'Button', text: 'Open run' })
    // The card names its run, so nothing is looked up.
    assert.deepEqual(requests(view, 'chat.findRun'), [])
    assert.equal(view.valueOf(SECTION_BAR), 'runs')
    assert.deepEqual(requests(view, 'run.read'), [{ runId: 'run-5', open: true }])
    clean(view)
  })
})

function nodeCount(node: TreeSnapshot | string | null): number {
  if (node === null) return 0
  if (typeof node === 'string') return 1
  return 1 + (node.children ?? []).reduce((sum, child) => sum + nodeCount(child), 0)
}

describe('the draw cost the worker bounds its answer by', () => {
  afterEach(() => mock.timers.reset())

  const cases: [string, ThreadMessage][] = [
    ['a dispatch row with its line', dispatchMessage('web-worker-9')],
    ['a dispatch row with no worker conversation', dispatchMessage(null)],
    ['a result card with a cut summary', { ...resultMessage, blocks: ['Part one\n\n', 'Part two'] }]
  ]
  for (const [what, message] of cases) {
    test(`${what} draws no more nodes than messageDrawCost counts`, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 18, 12) })
      let showing = true
      const view = await mountLinks(
        {
          thread: (request) => (showing ? threadWith(message)(request) : sampleThread(2, request)),
          findRun: () => ({ kind: 'not-created' })
        },
        { section: 'chat', openChat: 'web-chat-0' }
      )
      if (message.dispatch !== undefined && message.dispatch.workerId !== null) await view.press({ type: 'Button', text: 'Open run' })
      const drawn = nodeCount(view.tree())
      showing = false
      mock.timers.tick(30_000)
      await view.settled()
      // The thread without the special message: the two sample ones under it stay.
      assert.equal(view.find({ type: 'Button', text: 'Open run' }), null)
      const cost = drawn - nodeCount(view.tree())
      assert.ok(cost > 0 && cost <= messageDrawCost(message), `${String(cost)} nodes drawn, ${String(messageDrawCost(message))} counted`)
      clean(view)
    })
  }
})
