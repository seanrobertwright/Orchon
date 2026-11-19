// The frame seam for the builder tab: the tab driven through Orca's stand-in editor host, a
// scripted worker and a stand-in DOM. These tests cover what the tab draws in its own HTML (the
// layout of #28, the canvas, the outline, the inspector, the YAML and the issues), which requests
// it sends, and that it never edits its file.
import { afterEach, assert, describe, mockEditorHost, test, type MockEditorHost } from 'orca/testing'
import { fakeDocument, find, findAll, markupWritten, withClass, type FakeDocument, type FakeElement } from '../../scripts/fake-dom.ts'
import { readRepoText } from '../../scripts/repo-files.ts'
import { createClock, settle } from '../../scripts/scripted-archon.ts'
import type { TabConnection } from '../run-graph/graph-view.ts'
import { readPointer } from '../run-graph/tab.ts'
import type { BuilderAnswer, BuilderHeader, BuilderView } from './builder-view.ts'
import { startBuilderTab, type BuilderTab } from './tab.ts'

const IDENTITY = { name: 'mixed', codebaseId: 'cb-web', scope: 'project' }
const POINTER = `${JSON.stringify({ orchon: 'builder', ...IDENTITY })}\n`

const header: BuilderHeader = { name: 'mixed', source: 'project', file: 'C:/Projects/web/.archon/workflows/sub/mixed.yaml', viewOnly: false, openYaml: true }
const definition = {
  name: 'mixed',
  description: 'Every kind',
  inputs: { goal: { required: true } },
  nodes: [
    { id: 'plan', prompt: 'Plan it' },
    { id: 'run', bash: 'npm test', depends_on: ['plan'] },
    { id: 'rounds', loop_group: { nodes: [{ id: 'inner', prompt: 'p' }] }, depends_on: ['run'] },
    { id: 'shared', include: 'common.yaml', depends_on: ['nope'] }
  ]
}
const readyView: BuilderView = { kind: 'ready', header, definition }
const connection: TabConnection = { kind: 'connected', live: true }
const readyAnswer: BuilderAnswer = { connection, builder: readyView }

type Sent = { name: string; input: unknown }

let host: MockEditorHost | undefined
let tab: BuilderTab | undefined
afterEach(() => {
  tab?.stop()
  tab = undefined
  host?.dispose()
  host = undefined
})

type Stage = {
  doc: FakeDocument
  app: FakeElement
  sent: Sent[]
  post(event: string, payload: unknown): Promise<void>
  answer: { value: BuilderAnswer | ((sent: Sent) => BuilderAnswer) }
}

async function open(first: BuilderAnswer, text = POINTER): Promise<Stage> {
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
    sent,
    answer: { value: first },
    async post(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
      await settle()
    }
  }
  tab = startBuilderTab({
    doc: doc as unknown as Document,
    app: app as unknown as HTMLElement,
    readPointer,
    locale: 'en-GB',
    timers: clock.timers,
    request(name, input) {
      const call = { name, input }
      sent.push(call)
      if (name === 'connection.retry') return Promise.resolve(null)
      if (name === 'builder.openYaml') return Promise.resolve({ opened: true })
      const { value } = stage.answer
      return Promise.resolve(typeof value === 'function' ? value(call) : value)
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return { dispose: () => handlers.set(event, (handlers.get(event) ?? []).filter((held) => held !== handler)) }
    },
    observeSize(_element, told) {
      told(800, 500)
      return { dispose: () => {} }
    }
  })
  await settle()
  return stage
}

const reads = (stage: Stage): Sent[] => stage.sent.filter((call) => call.name === 'builder.read')
const texts = (root: FakeElement, tag: string): string[] => findAll(root, (element) => element.tagName === tag).map((element) => element.textContent)
const tabNamed = (root: FakeElement, name: string): FakeElement => {
  const found = find(root, (element) => element.getAttribute('role') === 'tab' && element.textContent === name)
  if (found === null) throw new Error(`There is no ${name} tab.`)
  return found
}
const panelOf = (stage: Stage, name: string): FakeElement => {
  const id = tabNamed(stage.app, name).getAttribute('aria-controls')
  const found = id === null ? null : stage.doc.getElementById(id)
  if (found === null) throw new Error(`The ${name} tab controls nothing.`)
  return found
}
const showTab = async (stage: Stage, name: string): Promise<void> => {
  tabNamed(stage.app, name).click()
  await settle()
}

describe('the builder tab', () => {
  test("reads the workflow's identity from its file, asks the worker for it in Orca's language, and never edits the file", async () => {
    const stage = await open(readyAnswer)
    assert.deepEqual(reads(stage), [{ name: 'builder.read', input: { ...IDENTITY, locale: 'en-GB' } }])
    assert.deepEqual(host?.edits, [])
    assert.equal(host?.text, POINTER)
  })

  test('a file that does not name a workflow says so and asks nothing', async () => {
    const stage = await open(readyAnswer, '{"orchon":"run-graph","runId":"x"}')
    assert.deepEqual(reads(stage), [])
    assert.ok(texts(stage.app, 'p').includes('Orchon could not read this file: it does not name a workflow.'))
  })

  test('a header shows the workflow, where Archon reads it from, and which file it is', async () => {
    const stage = await open(readyAnswer)
    assert.deepEqual(texts(stage.app, 'h1'), ['mixed'])
    assert.ok(texts(stage.app, 'p').includes('Source: project'))
    assert.ok(texts(stage.app, 'p').includes('File: C:/Projects/web/.archon/workflows/sub/mixed.yaml'))
  })

  test('the layout of #28: the canvas, a docked issues strip, and a sidecar with the tabs Inspector, Outline and YAML', async () => {
    const stage = await open(readyAnswer)
    const layout = withClass(stage.app, 'builder-layout')[0]
    assert.ok(layout)
    assert.deepEqual(
      layout.children.map((child) => child.getAttribute('class')),
      ['canvas-pane', 'sidecar', 'issues-strip']
    )
    const tabs = findAll(stage.app, (element) => element.getAttribute('role') === 'tab').map((element) => element.textContent)
    assert.deepEqual(tabs, ['Inspector', 'Outline', 'YAML'])
    const css = readRepoText('editors/builder/builder.css')
    assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) 310px/)
    assert.match(css, /grid-template-areas:\s*'canvas sidecar'\s*'issues sidecar'/)
    assert.match(css, /@media \(max-width: 860px\)\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 270px/)
  })

  test('sets every piece of outside text as text, never as markup', async () => {
    const stage = await open({ connection, builder: { kind: 'ready', header: { ...header, name: '<b>x</b>' }, definition: { ...definition, nodes: [{ id: '<i>y</i>', prompt: '<script>' }] } } })
    assert.equal(markupWritten(stage.app), false)
    assert.ok(texts(stage.app, 'h1').includes('<b>x</b>'))
  })
})

describe('the canvas', () => {
  test("is the run graph's renderer: a box per node, named by its id and kind, with an arrow per dependency", async () => {
    const stage = await open(readyAnswer)
    const pane = withClass(stage.app, 'canvas-pane')[0]
    assert.ok(pane)
    const boxes = withClass(pane, 'step')
    assert.deepEqual(
      boxes.map((box) => box.getAttribute('aria-label')),
      ['plan, prompt, prompt', 'run, bash, bash', 'rounds, loop group, read-only', 'shared, include, read-only']
    )
    assert.equal(withClass(pane, 'edge').length, 2)
  })

  test('draws a read-only node dashed and muted, with a lock glyph and a "read-only" line', async () => {
    const stage = await open(readyAnswer)
    const readOnly = withClass(stage.app, 'step').filter((box) => (box.getAttribute('class') ?? '').split(' ').includes('read-only'))
    assert.equal(readOnly.length, 2)
    for (const box of readOnly) {
      const lines = findAll(box, (element) => element.tagName === 'text').map((element) => element.textContent)
      assert.ok(lines.some((line) => line.startsWith('🔒 ')), lines.join(' | '))
      assert.ok(lines.includes('read-only'), lines.join(' | '))
    }
    const css = readRepoText('editors/builder/builder.css')
    assert.match(css, /\.step\.read-only \.box \{[^}]*stroke-dasharray[^}]*fill: var\(--orca-muted\)/)
  })

  test('a node pressed on the canvas shows in the inspector, and the focus stays where it was', async () => {
    const stage = await open(readyAnswer)
    await showTab(stage, 'Outline')
    const box = withClass(stage.app, 'step')[2]
    box?.focus()
    box?.click()
    await settle()
    assert.equal(tabNamed(stage.app, 'Inspector').getAttribute('aria-selected'), 'true')
    assert.equal(texts(panelOf(stage, 'Inspector'), 'h2')[0], 'rounds')
    assert.equal(stage.doc.activeElement, box)
  })
})

describe('the outline', () => {
  test('lists every node with its kind, and an ro badge on each read-only node', async () => {
    const stage = await open(readyAnswer)
    const outline = panelOf(stage, 'Outline')
    const items = withClass(outline, 'outline-node')
    assert.deepEqual(
      items.map((item) => item.getAttribute('aria-label')),
      ['plan, prompt', 'run, bash', 'rounds, loop group, read-only', 'shared, include, read-only']
    )
    assert.deepEqual(
      items.map((item) => withClass(item, 'ro').map((badge) => badge.textContent)),
      [[], [], ['ro'], ['ro']]
    )
    assert.ok(texts(outline, 'p').includes('4 nodes'))
  })

  test('choosing a node selects it on the canvas too and shows it in the inspector', async () => {
    const stage = await open(readyAnswer)
    await showTab(stage, 'Outline')
    withClass(panelOf(stage, 'Outline'), 'outline-node')[1]?.click()
    await settle()
    assert.equal(withClass(panelOf(stage, 'Outline'), 'outline-node')[1]?.getAttribute('aria-pressed'), 'true')
    assert.equal(withClass(stage.app, 'step')[1]?.getAttribute('aria-pressed'), 'true')
    assert.equal(texts(panelOf(stage, 'Inspector'), 'h2')[0], 'run')
  })
})

describe('the inspector', () => {
  test('with no node chosen shows the workflow and its other settings as read-only YAML', async () => {
    const stage = await open(readyAnswer)
    const inspector = panelOf(stage, 'Inspector')
    assert.equal(texts(inspector, 'h2')[0], 'mixed')
    assert.ok(texts(inspector, 'p').includes('Every kind'))
    assert.ok(texts(inspector, 'pre').includes('inputs:\n  goal:\n    required: true'))
  })

  test('a read-only node has a banner and a "Not editable here" group listing its fields', async () => {
    const stage = await open(readyAnswer)
    withClass(panelOf(stage, 'Outline'), 'outline-node')[3]?.click()
    await settle()
    const inspector = panelOf(stage, 'Inspector')
    assert.ok(texts(inspector, 'p').includes('🔒 Read-only. An include has no editor here. It is saved unchanged.'))
    const group = withClass(inspector, 'not-editable')[0]
    assert.ok(group)
    assert.deepEqual(texts(group, 'h3'), ['Not editable here'])
    assert.deepEqual(texts(group, 'li'), ['depends_on', 'include'])
    assert.ok(texts(inspector, 'li').includes('nope'))
  })

  test('an editable node has no banner, and no group when every field has an editor', async () => {
    const stage = await open(readyAnswer)
    withClass(panelOf(stage, 'Outline'), 'outline-node')[1]?.click()
    await settle()
    const inspector = panelOf(stage, 'Inspector')
    assert.equal(withClass(inspector, 'read-only-banner').length, 0)
    assert.equal(withClass(inspector, 'not-editable').length, 0)
    assert.ok(texts(inspector, 'p').includes('Kind: bash'))
    assert.ok(texts(inspector, 'li').includes('plan'))
  })
})

describe('the YAML tab', () => {
  test('is a read-only view of what a save would write', async () => {
    const stage = await open({ connection, builder: { kind: 'ready', header, definition: { name: 'small', nodes: [{ id: 'plan', prompt: 'Plan it' }] } } })
    await showTab(stage, 'YAML')
    const yaml = panelOf(stage, 'YAML')
    assert.deepEqual(texts(yaml, 'pre'), ['name: small\n\nnodes:\n  - id: plan\n    prompt: Plan it\n'])
    assert.equal(findAll(yaml, (element) => ['textarea', 'input'].includes(element.tagName)).length, 0)
  })
})

describe('the issues strip', () => {
  test('lists what opening and the local rules found, each with its severity in a word and its node', async () => {
    const stage = await open(readyAnswer)
    const strip = withClass(stage.app, 'issues-strip')[0]
    assert.ok(strip)
    const lines = texts(strip, 'li')
    assert.ok(lines.some((line) => line.startsWith('Error: ') && line.endsWith('(node shared)')), lines.join(' | '))
    assert.ok(lines.some((line) => line.startsWith('Info: ') && line.endsWith('(node rounds)')), lines.join(' | '))
    assert.match(texts(strip, 'h2')[0] ?? '', /^Issues \(\d+\)$/)
  })
})

describe('the sidecar tabs', () => {
  test('follow the tab keyboard pattern: one tab in the tab order, arrows and Home and End move between them', async () => {
    const stage = await open(readyAnswer)
    const list = find(stage.app, (element) => element.getAttribute('role') === 'tablist')
    assert.ok(list)
    const order = (): string[] =>
      findAll(list, (element) => element.getAttribute('role') === 'tab').map(
        (element) => `${element.textContent}:${element.getAttribute('aria-selected') ?? ''}:${element.getAttribute('tabindex') ?? ''}`
      )
    assert.deepEqual(order(), ['Inspector:true:0', 'Outline:false:-1', 'YAML:false:-1'])
    tabNamed(stage.app, 'Inspector').focus()
    list.dispatch('keydown', { key: 'ArrowRight' })
    assert.deepEqual(order(), ['Inspector:false:-1', 'Outline:true:0', 'YAML:false:-1'])
    assert.equal(stage.doc.activeElement, tabNamed(stage.app, 'Outline'))
    assert.equal(panelOf(stage, 'Outline').hidden, false)
    assert.equal(panelOf(stage, 'Inspector').hidden, true)
    list.dispatch('keydown', { key: 'End' })
    assert.equal(tabNamed(stage.app, 'YAML').getAttribute('aria-selected'), 'true')
    list.dispatch('keydown', { key: 'ArrowRight' })
    assert.equal(tabNamed(stage.app, 'Inspector').getAttribute('aria-selected'), 'true')
    list.dispatch('keydown', { key: 'ArrowLeft' })
    assert.equal(tabNamed(stage.app, 'YAML').getAttribute('aria-selected'), 'true')
    list.dispatch('keydown', { key: 'Home' })
    assert.equal(tabNamed(stage.app, 'Inspector').getAttribute('aria-selected'), 'true')
  })
})

describe('past 300 nodes', () => {
  test('the canvas gives way to a notice with the node count, and the outline still lists every node', async () => {
    const nodes = Array.from({ length: 301 }, (_, index) => ({ id: `n${String(index)}`, prompt: 'p' }))
    const stage = await open({ connection, builder: { kind: 'ready', header, definition: { name: 'big', nodes } } })
    const pane = withClass(stage.app, 'canvas-pane')[0]
    assert.ok(pane)
    assert.equal(withClass(pane, 'step').length, 0)
    assert.ok(texts(pane, 'p').includes('This workflow has 301 nodes. The canvas draws at most 300, so it gives way here. Every node is listed under Outline.'))
    const items = withClass(panelOf(stage, 'Outline'), 'outline-node')
    assert.equal(items.length, 301)
    items[300]?.click()
    await settle()
    assert.equal(texts(panelOf(stage, 'Inspector'), 'h2')[0], 'n300')
  })
})

describe('a definition over 1 MiB', () => {
  test('does not open, and the builder says so under the header', async () => {
    const stage = await open({ connection, builder: { kind: 'too-large', header, bytes: 3 * 1024 * 1024, cap: 1024 * 1024 } })
    assert.deepEqual(texts(stage.app, 'h1'), ['mixed'])
    assert.ok(texts(stage.app, 'p').includes("This workflow's definition is 3.0 MiB. The builder opens definitions of at most 1.0 MiB, so it does not open this one."))
    assert.equal(withClass(stage.app, 'builder-layout').length, 0)
  })
})

describe('an installed workflow', () => {
  test('is view-only, and says so', async () => {
    const stage = await open({ connection, builder: { kind: 'ready', header: { ...header, source: 'installed', viewOnly: true, openYaml: false }, definition } })
    assert.ok(texts(stage.app, 'p').includes('This workflow is installed, so it can only be viewed here.'))
  })
})

describe('Open YAML', () => {
  test("is offered when the worker can open the file, and asks it to with the workflow's identity", async () => {
    const stage = await open(readyAnswer)
    const button = find(stage.app, (element) => element.tagName === 'button' && element.textContent === 'Open YAML')
    assert.ok(button)
    button.click()
    await settle()
    assert.deepEqual(
      stage.sent.filter((call) => call.name === 'builder.openYaml'),
      [{ name: 'builder.openYaml', input: IDENTITY }]
    )
  })

  test('is hidden when the file cannot be resolved', async () => {
    const stage = await open({ connection, builder: { kind: 'ready', header: { ...header, openYaml: false }, definition } })
    assert.equal(find(stage.app, (element) => element.tagName === 'button' && element.textContent === 'Open YAML'), null)
  })
})

const notFound: TabConnection = {
  kind: 'screen',
  screen: { title: 'Orchon could not find Archon.', lines: ['Nothing answered at `http://127.0.0.1:3090` (the default address). Start it in a terminal:'], command: 'archon serve', after: [], tryAgain: true, install: null }
}

describe('a tab reopened with nothing to show', () => {
  test('draws the state screen, then loads once the worker says it is Connected', async () => {
    const stage = await open({ connection: notFound, builder: { kind: 'not-connected' } })
    assert.deepEqual(texts(stage.app, 'h2'), ['Orchon could not find Archon.'])
    assert.ok(texts(stage.app, 'code').includes('archon serve'))
    stage.answer.value = readyAnswer
    await stage.post('connection.changed', { kind: 'connected' })
    assert.equal(reads(stage).length, 2)
    assert.deepEqual(texts(stage.app, 'h1'), ['mixed'])
    assert.equal(withClass(stage.app, 'builder-layout').length, 1)
  })

  test('while Searching with nothing loaded says it is looking', async () => {
    const stage = await open({ connection: { kind: 'searching', banner: 'Archon stopped answering. Reconnecting…', label: 'Looking for Archon…' }, builder: { kind: 'not-connected' } })
    assert.ok(texts(stage.app, 'p').includes('Looking for Archon…'))
  })
})

describe('when Archon is lost with a workflow shown', () => {
  test('the builder keeps its canvas under the banner, in the polite live region', async () => {
    const stage = await open(readyAnswer)
    stage.answer.value = { connection: { kind: 'searching', banner: 'Archon stopped answering at 12:00. Reconnecting…', label: 'Looking for Archon…' }, builder: { kind: 'not-connected' } }
    await stage.post('connection.changed', { kind: 'searching' })
    const region = find(stage.app, (element) => element.getAttribute('aria-live') === 'polite')
    assert.ok(region)
    assert.deepEqual(texts(region, 'p'), ['Archon stopped answering at 12:00. Reconnecting…'])
    assert.equal(withClass(stage.app, 'step').length, 4)
    stage.answer.value = readyAnswer
    await stage.post('connection.changed', { kind: 'connected' })
    assert.deepEqual(texts(region, 'p'), [])
  })

  test('a post while Connected and shown reads nothing again', async () => {
    const stage = await open(readyAnswer)
    await stage.post('connection.changed', { kind: 'connected' })
    assert.equal(reads(stage).length, 1)
  })
})

describe('a workflow Archon no longer has', () => {
  test("says so in the worker's words, with Try again", async () => {
    const stage = await open({ connection, builder: { kind: 'gone', message: 'Archon has no workflow named mixed here.' } })
    assert.ok(texts(stage.app, 'p').includes('Archon has no workflow named mixed here.'))
    const again = find(stage.app, (element) => element.tagName === 'button' && element.textContent === 'Try again')
    assert.ok(again)
    again.click()
    await settle()
    assert.equal(reads(stage).length, 2)
  })
})

describe('a node with many dependencies', () => {
  test('the inspector lists the first 200 and says how many are not shown', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `d${String(index)}`)
    const nodes = [...ids.map((id) => ({ id, prompt: 'p' })), { id: 'last', prompt: 'p', depends_on: ids }]
    const stage = await open({ connection, builder: { kind: 'ready', header, definition: { name: 'wide', nodes } } })
    withClass(panelOf(stage, 'Outline'), 'outline-node')[205]?.click()
    await settle()
    const inspector = panelOf(stage, 'Inspector')
    assert.equal(texts(inspector, 'li').filter((line) => /^d\d+$/.test(line)).length, 200)
    assert.ok(texts(inspector, 'p').includes('5 more dependencies are not shown.'))
  })
})
