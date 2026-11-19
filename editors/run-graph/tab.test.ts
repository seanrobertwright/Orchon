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
  /** Tells the tab its graph area has this size, as Orca's frame would on a resize. */
  resize(width: number, height: number): void
}

async function open(first: GraphAnswer, text = POINTER): Promise<Stage> {
  host = mockEditorHost({ text })
  const doc = fakeDocument()
  const app = doc.getElementById('app')
  if (app === null) throw new Error('The stand-in document has no #app.')
  const clock = createClock()
  const sent: Sent[] = []
  const handlers = new Map<string, ((payload: unknown) => void)[]>()
  const sizes: ((width: number, height: number) => void)[] = []
  const stage: Stage = {
    resize(width, height) {
      for (const told of sizes) told(width, height)
    },
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
    },
    observeSize(_element, told) {
      sizes.push(told)
      told(800, 500)
      return { dispose: () => sizes.splice(sizes.indexOf(told), 1) }
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

/** The graph's visible region as numbers: its viewBox. */
function viewBox(stage: Stage): number[] {
  const svg = find(stage.app, (element) => (element.getAttribute('class') ?? '').split(' ').includes('graph'))
  return (svg?.getAttribute('viewBox') ?? '').split(' ').map(Number)
}
const near = (actual: number[], expected: number[]): void => {
  assert.equal(actual.length, expected.length, `${actual.join(' ')} is not ${expected.join(' ')}`)
  actual.forEach((value, index) => assert.ok(Math.abs(value - (expected[index] ?? NaN)) < 0.01, `${actual.join(' ')} is not ${expected.join(' ')}`))
}
const one = (root: FakeElement, name: string): FakeElement => {
  const [element] = withClass(root, name)
  if (element === undefined) throw new Error(`Nothing has the class ${name}.`)
  return element
}
const named = (root: FakeElement, name: string): FakeElement => {
  const element = find(root, (candidate) => candidate.tagName === 'button' && (candidate.getAttribute('aria-label') ?? candidate.textContent) === name)
  if (element === null) throw new Error(`No button is named ${name}.`)
  return element
}

// Two steps one under the other lay out 216 wide and 196 high: a step is 184 by 60, with 44
// between ranks and a margin of 16 all round.
describe('the canvas tools', () => {
  test('fits the graph to the tab, and fits again on resize until the user moves the view', async () => {
    const stage = await open({ connection, graph: readyGraph })
    near(viewBox(stage), [-292, -152, 800, 500])
    stage.resize(108, 98)
    near(viewBox(stage), [0, 0, 216, 196])
    one(stage.app, 'viewport').dispatch('keydown', { key: 'ArrowRight' })
    near(viewBox(stage), [96, 0, 216, 196])
    stage.resize(216, 196)
    near(viewBox(stage), [96, 0, 432, 392])
    one(stage.app, 'viewport').dispatch('keydown', { key: '0' })
    near(viewBox(stage), [0, 0, 216, 196])
    stage.resize(108, 98)
    near(viewBox(stage), [0, 0, 216, 196])
    stage.resize(216, 196)
    named(stage.app, 'Zoom in').click()
    named(stage.app, 'Fit').click()
    stage.resize(432, 392)
    near(viewBox(stage), [-108, -98, 432, 392])
  })

  test('arrow keys pan the view, on the canvas and on a step', async () => {
    const stage = await open({ connection, graph: readyGraph })
    stage.resize(216, 196)
    const viewport = one(stage.app, 'viewport')
    assert.equal(viewport.getAttribute('tabindex'), '0')
    const keys = ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'].map((key) => viewport.dispatch('keydown', { key }))
    assert.ok(keys.every((event) => event.defaultPrevented))
    near(viewBox(stage), [0, 0, 216, 196])
    withClass(stage.app, 'step')[0]?.dispatch('keydown', { key: 'ArrowDown' })
    near(viewBox(stage), [0, 48, 216, 196])
  })

  test('the plus and minus keys, the on-canvas buttons and the wheel zoom', async () => {
    const stage = await open({ connection, graph: readyGraph })
    stage.resize(216, 196)
    const viewport = one(stage.app, 'viewport')
    viewport.dispatch('keydown', { key: '+' })
    near(viewBox(stage), [21.6, 19.6, 172.8, 156.8])
    viewport.dispatch('keydown', { key: '-' })
    near(viewBox(stage), [0, 0, 216, 196])
    named(stage.app, 'Zoom in').click()
    near(viewBox(stage), [21.6, 19.6, 172.8, 156.8])
    named(stage.app, 'Zoom out').click()
    near(viewBox(stage), [0, 0, 216, 196])
    const wheel = viewport.dispatch('wheel', { deltaY: -100, clientX: 0, clientY: 0 })
    assert.ok(wheel.defaultPrevented)
    near(viewBox(stage), [0, 0, 172.8, 156.8])
  })

  test('dragging the canvas pans the view', async () => {
    const stage = await open({ connection, graph: readyGraph })
    stage.resize(216, 196)
    const viewport = one(stage.app, 'viewport')
    viewport.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    viewport.dispatch('pointermove', { clientX: 60, clientY: 80, pointerId: 1 })
    viewport.dispatch('pointerup', { clientX: 60, clientY: 80, pointerId: 1 })
    near(viewBox(stage), [40, 20, 216, 196])
    viewport.dispatch('pointermove', { clientX: 0, clientY: 0, pointerId: 1 })
    near(viewBox(stage), [40, 20, 216, 196])
  })

  test('panning and zooming move the drawing; they do not lay the graph out or draw it again', async () => {
    const stage = await open({ connection, graph: readyGraph })
    const svg = one(stage.app, 'graph')
    const steps = withClass(svg, 'step')
    const viewport = one(stage.app, 'viewport')
    viewport.dispatch('keydown', { key: 'ArrowRight' })
    viewport.dispatch('keydown', { key: '+' })
    viewport.dispatch('wheel', { deltaY: 100, clientX: 10, clientY: 10 })
    assert.equal(one(stage.app, 'graph'), svg)
    assert.deepEqual(withClass(stage.app, 'step'), steps)
  })

  test('a minimap shows each step coloured by state and a frame around the view, which a drag moves', async () => {
    const stage = await open({ connection, graph: readyGraph })
    stage.resize(216, 196)
    const minimap = one(stage.app, 'minimap')
    assert.deepEqual(
      withClass(minimap, 'mini-step').map((box) => box.getAttribute('class')),
      ['mini-step state-completed', 'mini-step state-waiting']
    )
    const frame = one(minimap, 'minimap-frame')
    near(['x', 'y', 'width', 'height'].map((name) => Number(frame.getAttribute(name))), [0, 0, 216, 196])
    const scale = Number(minimap.getAttribute('width')) / 216
    minimap.dispatch('pointerdown', { button: 0, clientX: 150 * scale, clientY: 100 * scale, pointerId: 2 })
    near(viewBox(stage), [42, 2, 216, 196])
    minimap.dispatch('pointermove', { clientX: 108 * scale, clientY: 98 * scale, pointerId: 2 })
    minimap.dispatch('pointerup', { pointerId: 2 })
    near(viewBox(stage), [0, 0, 216, 196])
    near(['x', 'y', 'width', 'height'].map((name) => Number(frame.getAttribute(name))), [0, 0, 216, 196])
    stage.resize(432, 392)
    near(viewBox(stage), [0, 0, 432, 392])
  })

  test('the zoom buttons, whose text is a sign, are named; the canvas says how to use the keys', async () => {
    const stage = await open({ connection, graph: readyGraph })
    for (const name of ['Zoom in', 'Zoom out']) assert.equal(named(stage.app, name).getAttribute('type'), 'button')
    const viewport = one(stage.app, 'viewport')
    assert.equal(viewport.getAttribute('aria-label'), 'Steps of archon-deliver-block')
    const help = stage.doc.getElementById(viewport.getAttribute('aria-describedby') ?? '')
    assert.equal(help?.textContent, 'Arrow keys pan, plus and minus zoom, and zero fits the graph.')
  })
})
