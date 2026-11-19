// The frame seam for the run graph tab: the tab driven through Orca's stand-in editor host, a
// scripted worker and a stand-in DOM. These tests cover what the tab draws in its own HTML and
// which requests it sends, and that it never edits its file.
import { afterEach, assert, describe, mockEditorHost, test, type MockEditorHost } from 'orca/testing'
import { fakeDocument, find, findAll, markupWritten, withClass, type FakeDocument, type FakeElement } from '../../scripts/fake-dom.ts'
import { createClock, settle, type Clock } from '../../scripts/scripted-archon.ts'
import type { GraphAnswer, GraphStep, GraphView, TabConnection } from './graph-view.ts'
import { readPointer, startTab, type Tab } from './tab.ts'

const RUN_ID = '7c28e1a1-6432-4c9d-89d6-874cfaf81f89'
const POINTER = `${JSON.stringify({ orchon: 'run-graph', runId: RUN_ID })}\n`

const header = { workflow: 'archon-deliver-block', shortId: '7c28e1a1', state: '✓ Completed', started: '19 Nov 2026, 01:01', finished: true }
const step = (id: string, extra: Partial<GraphStep> = {}): GraphStep => ({
  id,
  name: id,
  kind: 'exec',
  state: 'completed',
  glyph: '✓',
  word: 'Completed',
  group: null,
  isGroup: false,
  conditional: false,
  note: null,
  ...extra
})
const readyGraph: GraphView = {
  kind: 'ready',
  header,
  mismatch: null,
  steps: [step('forge'), step('review', { state: 'waiting', glyph: '‖', word: 'Waiting', note: 'Answered in the Orchon panel.' })],
  edges: [{ from: 'forge', to: 'review' }]
}
const connection: TabConnection = { kind: 'connected', live: true }

type Sent = { name: string; input: unknown }

let host: MockEditorHost | undefined
let tab: Tab | undefined
afterEach(() => {
  tab?.stop()
  tab = undefined
  host?.dispose()
  host = undefined
})

type Stage = {
  doc: FakeDocument
  app: FakeElement
  clock: Clock
  sent: Sent[]
  /** Delivers a worker post, as `orca.plugin.on` would. */
  post(event: string, payload: unknown): Promise<void>
  /** What the scripted worker answers next. */
  answer: { value: GraphAnswer | ((sent: Sent) => GraphAnswer | Promise<GraphAnswer>) }
  external: string[]
}

async function open(first: GraphAnswer, text = POINTER): Promise<Stage> {
  host = mockEditorHost({ text })
  const doc = fakeDocument()
  const app = doc.getElementById('app')
  if (app === null) throw new Error('The stand-in document has no #app.')
  const clock = createClock()
  const sent: Sent[] = []
  const handlers = new Map<string, ((payload: unknown) => void)[]>()
  const stage: Stage = {
    doc,
    app,
    clock,
    sent,
    answer: { value: first },
    external: [],
    async post(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
      await settle()
    }
  }
  tab = startTab({
    doc: doc as unknown as Document,
    app: app as unknown as HTMLElement,
    readPointer,
    locale: 'en-GB',
    timers: clock.timers,
    request(name, input) {
      const call = { name, input }
      sent.push(call)
      if (name === 'connection.retry') return Promise.resolve(null)
      const { value } = stage.answer
      return Promise.resolve(typeof value === 'function' ? value(call) : value)
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return { dispose: () => handlers.set(event, (handlers.get(event) ?? []).filter((held) => held !== handler)) }
    },
    openExternal(url) {
      stage.external.push(url)
      return Promise.resolve()
    }
  })
  await settle()
  return stage
}

const reads = (stage: Stage): Sent[] => stage.sent.filter((call) => call.name === 'graph.read')
const live = (stage: Stage): FakeElement => {
  const region = find(stage.app, (element) => element.getAttribute('aria-live') === 'polite')
  if (region === null) throw new Error('The tab has no polite live region.')
  return region
}
const texts = (root: FakeElement, tag: string): string[] => findAll(root, (element) => element.tagName === tag).map((element) => element.textContent)

describe('the run graph tab', () => {
  test("reads the run from its file, asks the worker for it in Orca's language, and never edits the file", async () => {
    const stage = await open({ connection, graph: readyGraph })
    assert.deepEqual(reads(stage), [{ name: 'graph.read', input: { runId: RUN_ID, locale: 'en-GB' } }])
    assert.deepEqual(host?.edits, [])
    assert.equal(host?.text, POINTER)
  })

  test('a header shows the workflow name, the short run id, the state and the start time; a finished run says where its arrows come from', async () => {
    const stage = await open({ connection, graph: readyGraph })
    assert.deepEqual(texts(stage.app, 'h1'), ['archon-deliver-block'])
    assert.ok(texts(stage.app, 'p').includes('Run 7c28e1a1 · ✓ Completed · Started 19 Nov 2026, 01:01'))
    assert.ok(texts(stage.app, 'p').includes('Arrows come from the workflow as it is now.'))
  })

  test('a live run does not carry the line about arrows', async () => {
    const stage = await open({ connection, graph: { ...readyGraph, header: { ...header, state: '● Running', finished: false } } })
    assert.ok(!texts(stage.app, 'p').includes('Arrows come from the workflow as it is now.'))
  })

  test('draws the graph as SVG, and a paused step says it is answered in the Orchon panel', async () => {
    const stage = await open({ connection, graph: readyGraph })
    const svg = find(stage.app, (element) => element.tagName === 'svg')
    assert.ok(svg !== null)
    assert.deepEqual(
      withClass(svg, 'step').map((box) => box.getAttribute('aria-label')),
      ['forge, exec, ✓ Completed', 'review, exec, ‖ Waiting']
    )
    assert.match(svg.textContent, /Answered in the Orchon panel\./)
    assert.equal(withClass(svg, 'edge').length, 1)
  })

  test("sets Archon's text through textContent, never as markup", async () => {
    const stage = await open({ connection, graph: { ...readyGraph, header: { ...header, workflow: '<img src=x onerror=alert(1)>' } } })
    assert.deepEqual(texts(stage.app, 'h1'), ['<img src=x onerror=alert(1)>'])
    assert.equal(findAll(stage.app, (element) => element.tagName === 'img').length, 0)
    assert.equal(markupWritten(stage.app), false)
  })

  test('on a mismatch a banner in the polite live region says so, and the steps are drawn with no arrows', async () => {
    for (const [mismatch, words] of [
      ['changed', 'The workflow has changed since this run.'],
      ['deleted', 'The workflow has been deleted since this run.']
    ] as const) {
      const stage = await open({ connection, graph: { ...readyGraph, mismatch, edges: [] } })
      assert.match(live(stage).textContent, new RegExp(words.replace('.', '\\.')))
      assert.match(live(stage).textContent, /drawn in run order, with no arrows/)
      const svg = find(stage.app, (element) => element.tagName === 'svg')
      assert.ok(svg !== null)
      assert.equal(withClass(svg, 'step').length, 2)
      assert.equal(withClass(svg, 'edge').length, 0)
      tab?.stop()
      host?.dispose()
    }
  })

  test('past the cap a notice points to the step list in the Orchon panel, and nothing is laid out', async () => {
    const stage = await open({ connection, graph: { kind: 'too-many', header, count: 412, cap: 300 } })
    assert.equal(find(stage.app, (element) => element.tagName === 'svg'), null)
    assert.ok(
      texts(stage.app, 'p').includes('This run has 412 steps. One graph lays out at most 300, so this one is not drawn. Its steps are listed in run detail in the Orchon panel.')
    )
  })

  test('a run with no project says it has no graph', async () => {
    const stage = await open({ connection, graph: { kind: 'no-graph', header, message: 'This run has no Archon project, so it has no graph.' } })
    assert.ok(texts(stage.app, 'p').includes('This run has no Archon project, so it has no graph.'))
  })

  test('a file that names no run says so and asks the worker nothing', async () => {
    const stage = await open({ connection, graph: readyGraph }, '{ "sample": true }')
    assert.deepEqual(stage.sent, [])
    assert.ok(texts(stage.app, 'p').includes('Orchon could not read this file: it does not name a run.'))
  })
})

describe('the state screens and the Searching banner, in the tab\'s own HTML', () => {
  const notRunning: TabConnection = {
    kind: 'screen',
    screen: {
      title: 'Archon is not running.',
      lines: ['Nothing answered at `http://127.0.0.1:3090` (the default address). Start it in a terminal:'],
      command: 'archon serve',
      after: ['Orchon checks again by itself, at least every 30 seconds.'],
      tryAgain: true,
      install: null
    }
  }

  test('a state screen replaces the graph, with code marked as code, and Try again asks the worker to look for Archon at once', async () => {
    const stage = await open({ connection: notRunning, graph: { kind: 'not-connected' } })
    assert.deepEqual(texts(stage.app, 'h2'), ['Archon is not running.'])
    assert.ok(texts(stage.app, 'code').includes('http://127.0.0.1:3090'))
    assert.ok(texts(stage.app, 'code').includes('archon serve'))
    assert.equal(find(stage.app, (element) => element.tagName === 'svg'), null)
    const button = find(stage.app, (element) => element.tagName === 'button' && element.textContent === 'Try again')
    assert.equal(button?.getAttribute('type'), 'button')
    stage.answer.value = { connection, graph: readyGraph }
    button?.click()
    await settle()
    assert.deepEqual(stage.sent.map((call) => call.name), ['graph.read', 'connection.retry', 'graph.read'])
    assert.ok(find(stage.app, (element) => element.tagName === 'svg'))
  })

  test('the installation guide opens in the browser', async () => {
    const stage = await open({
      connection: { kind: 'screen', screen: { ...notRunning.screen, title: 'Orchon could not find Archon.', install: 'https://archon.diy/getting-started/installation/' } } as TabConnection,
      graph: { kind: 'not-connected' }
    })
    const link = find(stage.app, (element) => element.tagName === 'a')
    assert.equal(link?.getAttribute('href'), 'https://archon.diy/getting-started/installation/')
    const event = link?.dispatch('click')
    assert.equal(event?.defaultPrevented, true)
    assert.deepEqual(stage.external, ['https://archon.diy/getting-started/installation/'])
  })

  test('Searching with data keeps the graph under the banner, in the polite live region', async () => {
    const stage = await open({ connection, graph: readyGraph })
    stage.answer.value = { connection: { kind: 'searching', banner: 'Archon stopped answering at 12:00. Reconnecting…', label: 'Looking for Archon…' }, graph: { kind: 'not-connected' } }
    await stage.post('connection.changed', {})
    await stage.clock.advance(1_000)
    assert.match(live(stage).textContent, /Archon stopped answering at 12:00\. Reconnecting…/)
    assert.ok(find(stage.app, (element) => element.tagName === 'svg'))
  })

  test('Searching with nothing loaded shows "Looking for Archon…"', async () => {
    const stage = await open({ connection: { kind: 'searching', banner: 'Archon stopped answering. Reconnecting…', label: 'Looking for Archon…' }, graph: { kind: 'not-connected' } })
    assert.ok(texts(stage.app, 'p').includes('Looking for Archon…'))
    assert.equal(find(stage.app, (element) => element.tagName === 'svg'), null)
  })
})

describe('refetching as run detail does', () => {
  test('a hint that names the run reads it again once the second-long gap allows; a hint for another run does not', async () => {
    const stage = await open({ connection, graph: readyGraph })
    await stage.post('runs.changed', { types: ['run'], runs: ['other'] })
    await stage.clock.advance(2_000)
    assert.equal(reads(stage).length, 1)
    await stage.post('runs.changed', { types: ['run'], runs: [RUN_ID] })
    await stage.post('runs.changed', { types: ['run'], runs: [RUN_ID] })
    assert.equal(reads(stage).length, 2)
    await stage.post('runs.changed', { types: ['run'], runs: 'many' })
    assert.equal(reads(stage).length, 2)
    await stage.clock.advance(1_000)
    assert.equal(reads(stage).length, 3)
  })

  test('reads again every 30 seconds, and every 5 while live updates are off', async () => {
    const stage = await open({ connection, graph: readyGraph })
    await stage.clock.advance(29_000)
    assert.equal(reads(stage).length, 1)
    stage.answer.value = { connection: { kind: 'connected', live: false }, graph: readyGraph }
    await stage.clock.advance(1_000)
    assert.equal(reads(stage).length, 2)
    await stage.clock.advance(5_000)
    assert.equal(reads(stage).length, 3)
  })

  test('only the answer to the newest read is drawn', async () => {
    let release: (() => void) | undefined
    const stage = await open({ connection, graph: readyGraph })
    stage.answer.value = async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { connection, graph: { ...readyGraph, header: { ...header, workflow: 'old answer' } } }
    }
    await stage.clock.advance(30_000)
    stage.answer.value = { connection, graph: { ...readyGraph, header: { ...header, workflow: 'new answer' } } }
    const button = find(stage.app, (element) => element.tagName === 'button' && element.textContent === 'Refresh')
    button?.click()
    await settle()
    release?.()
    await settle()
    assert.deepEqual(texts(stage.app, 'h1'), ['new answer'])
  })

  test('a failed read keeps the graph under a warning line with Try again', async () => {
    const stage = await open({ connection, graph: readyGraph })
    stage.answer.value = { connection, graph: { kind: 'failed', message: 'Archon did not answer in time.' } }
    await stage.clock.advance(30_000)
    assert.match(live(stage).textContent, /Archon did not answer in time\./)
    assert.ok(find(stage.app, (element) => element.tagName === 'svg'))
  })

  test('closing the tab clears every timer and stops listening', async () => {
    const stage = await open({ connection, graph: readyGraph })
    tab?.stop()
    tab = undefined
    assert.deepEqual(stage.clock.waiting(), [])
    await stage.post('runs.changed', { types: ['run'], runs: [RUN_ID] })
    await stage.clock.advance(60_000)
    assert.equal(reads(stage).length, 1)
  })
})
