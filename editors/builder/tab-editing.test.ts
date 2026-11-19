// The frame seam for editing in the builder tab (#16, #28): the tab driven through Orca's stand-in
// editor host, a scripted worker and a stand-in DOM. These tests edit as a person does, by the
// inspector's form, the outline, the canvas and the keys, and read what the tab draws: the YAML a
// save would write, the canvas, the issues and the header. Nothing is written to the file.
import { afterEach, assert, describe, mockEditorHost, test, type MockEditorHost } from 'orca/testing'
import { fakeDocument, find, findAll, withClass, type FakeDocument, type FakeElement } from '../../scripts/fake-dom.ts'
import { createClock, settle } from '../../scripts/scripted-archon.ts'
import type { TabConnection } from '../run-graph/graph-view.ts'
import { readPointer } from '../run-graph/tab.ts'
import type { BuilderAnswer, BuilderHeader } from './builder-view.ts'
import { startBuilderTab, type BuilderTab } from './tab.ts'

const IDENTITY = { name: 'mixed', codebaseId: 'cb-web', scope: 'project' }
const POINTER = `${JSON.stringify({ orchon: 'builder', ...IDENTITY })}\n`
const header: BuilderHeader = { name: 'mixed', source: 'project', file: 'C:/Projects/web/.archon/workflows/mixed.yaml', viewOnly: false, openYaml: true }
const connection: TabConnection = { kind: 'connected', live: true }
const answerFor = (definition: Record<string, unknown>, over: Partial<BuilderHeader> = {}): BuilderAnswer => ({ connection, builder: { kind: 'ready', header: { ...header, ...over }, definition } })

const SMALL = {
  name: 'small',
  description: 'Plan, then test',
  nodes: [
    { id: 'plan', prompt: 'Plan it', teleport: { to: 'mars' } },
    { id: 'run', bash: 'npm test', depends_on: ['plan'] },
    { id: 'shared', include: 'common.yaml' }
  ]
}

let host: MockEditorHost | undefined
let tab: BuilderTab | undefined
afterEach(() => {
  tab?.stop()
  tab = undefined
  host?.dispose()
  host = undefined
})

type Sent = { name: string; input: unknown }
type Stage = { doc: FakeDocument; app: FakeElement; sent: Sent[]; answer: { value: BuilderAnswer }; post(event: string, payload: unknown): Promise<void> }

async function open(first: BuilderAnswer): Promise<Stage> {
  host = mockEditorHost({ text: POINTER })
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
      sent.push({ name, input })
      return Promise.resolve(stage.answer.value)
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return { dispose: () => {} }
    },
    observeSize(_element, told) {
      told(800, 500)
      return { dispose: () => {} }
    }
  })
  await settle()
  return stage
}

const texts = (root: FakeElement, tag: string): string[] => findAll(root, (element) => element.tagName === tag).map((element) => element.textContent)
const panelOf = (stage: Stage, name: string): FakeElement => {
  const tabButton = find(stage.app, (element) => element.getAttribute('role') === 'tab' && element.textContent === name)
  const id = tabButton?.getAttribute('aria-controls') ?? null
  const found = id === null ? null : stage.doc.getElementById(id)
  if (found === null) throw new Error(`There is no ${name} panel.`)
  return found
}
const buttonNamed = (root: FakeElement, name: string): FakeElement => {
  const found = find(root, (element) => element.tagName === 'button' && (element.getAttribute('aria-label') ?? element.textContent) === name)
  if (found === null) throw new Error(`There is no button named ${name}.`)
  return found
}
const press = async (element: FakeElement): Promise<void> => {
  element.click()
  await settle()
}
const key = async (target: FakeElement, name: string, fields: { ctrlKey?: boolean; shiftKey?: boolean } = {}): Promise<void> => {
  target.dispatch('keydown', { key: name, ...fields })
  await settle()
}
/** The control a label names, by the label's `for`. */
const control = (root: FakeElement, label: string): FakeElement => {
  const found = find(root, (element) => element.tagName === 'label' && element.textContent === label)
  const id = found?.getAttribute('for') ?? null
  const target = id === null ? null : find(root, (element) => element.id === id)
  if (target === null) throw new Error(`No control is labelled ${label}.`)
  return target
}
const type = async (input: FakeElement, value: string): Promise<void> => {
  input.value = value
  input.dispatch(input.tagName === 'select' ? 'change' : 'input')
  await settle()
}
const choose = async (stage: Stage, index: number): Promise<void> => press(withClass(panelOf(stage, 'Outline'), 'outline-node')[index] as FakeElement)
const yaml = (stage: Stage): string => texts(panelOf(stage, 'YAML'), 'pre')[0] ?? ''
/** The YAML lines of one node, its item under `nodes:`, unindented. */
const nodeYaml = (stage: Stage, id: string): string[] => {
  const item = yaml(stage).split('\n  - ').find((part) => part.startsWith(`id: ${id}\n`)) ?? ''
  return item.split('\n').map((line) => line.replace(/^ {4}/, ''))
}
const boxes = (stage: Stage): FakeElement[] => withClass(stage.app, 'step')
const unsaved = (stage: Stage): boolean => texts(stage.app, 'p').includes('Unsaved changes')
const banner = (stage: Stage): string[] => texts(find(stage.app, (element) => element.getAttribute('aria-live') === 'polite') as FakeElement, 'p')

describe('the inspector form', () => {
  const EVERY_KIND = {
    name: 'kinds',
    nodes: [
      { id: 'p', prompt: 'Plan' },
      { id: 'c', command: 'review' },
      { id: 'b', bash: 'ls' },
      { id: 's', script: 'index', runtime: 'bun' },
      { id: 'l', loop: { prompt: 'again', until: 'DONE', max_iterations: 3, fresh_context: false } },
      { id: 'a', approval: { message: 'OK?' } },
      { id: 'w', wait: { duration_ms: 1000 } },
      { id: 'x', cancel: 'Stop' }
    ]
  }
  const FIRST_FIELD = ['Prompt', 'Command', 'Bash script', 'Script', 'Prompt for each iteration', 'Message', 'Wait for', 'Reason']

  test('each editable kind has a form whose every input has a label; the id is a heading, never an input', async () => {
    const stage = await open(answerFor(EVERY_KIND))
    for (const [index, first] of FIRST_FIELD.entries()) {
      await choose(stage, index)
      const inspector = panelOf(stage, 'Inspector')
      const inputs = findAll(inspector, (element) => ['input', 'textarea', 'select'].includes(element.tagName))
      assert.ok(inputs.length >= 5, `node ${String(index)} has ${String(inputs.length)} inputs`)
      for (const input of inputs) {
        const labelled = find(inspector, (element) => element.tagName === 'label' && element.getAttribute('for') === input.id)
        assert.ok(input.id !== '' && labelled !== null, `an input of node ${String(index)} has no label`)
      }
      assert.ok(texts(inspector, 'label').includes(first), texts(inspector, 'label').join(' | '))
      assert.ok(texts(inspector, 'label').includes('Description'))
      assert.equal(texts(inspector, 'h2')[0], EVERY_KIND.nodes[index]?.id)
      assert.equal(findAll(inspector, (element) => element.tagName === 'label' && /^id$/i.test(element.textContent)).length, 0)
    }
  })

  test('an edit shows in the YAML at once, keeps the fields with no editor, and the header says "Unsaved changes"', async () => {
    const stage = await open(answerFor(SMALL))
    assert.equal(unsaved(stage), false)
    await choose(stage, 0)
    await type(control(panelOf(stage, 'Inspector'), 'Prompt'), 'Plan it well')
    assert.match(yaml(stage), /prompt: Plan it well/)
    assert.match(yaml(stage), /teleport:\n\s+to: mars/)
    assert.equal(unsaved(stage), true)
    assert.ok(texts(withClass(panelOf(stage, 'Inspector'), 'not-editable')[0] as FakeElement, 'li').includes('teleport'))
  })

  test('the workflow description is editable and its name is not', async () => {
    const stage = await open(answerFor(SMALL))
    const inspector = panelOf(stage, 'Inspector')
    assert.equal(texts(inspector, 'h2')[0], 'small')
    await type(control(inspector, 'Workflow description'), 'Plan, test, ship')
    assert.match(yaml(stage), /description: Plan, test, ship/)
    assert.match(yaml(stage), /^name: small/)
  })

  test('a number field that holds letters is refused and says why, and nothing changes', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 1)
    const timeout = control(panelOf(stage, 'Inspector'), 'Timeout (ms)')
    await type(timeout, '12x')
    assert.equal(timeout.getAttribute('aria-invalid'), 'true')
    assert.ok(texts(panelOf(stage, 'Inspector'), 'p').includes('Enter a whole number, 0 or more.'))
    assert.equal(unsaved(stage), false)
    await type(timeout, '5000')
    assert.equal(timeout.getAttribute('aria-invalid'), null)
    assert.match(yaml(stage), /timeout: 5000/)
  })

  test("a read-only node's shared fields and dependencies stay editable, and its own fields are kept", async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 2)
    const inspector = panelOf(stage, 'Inspector')
    assert.ok(texts(inspector, 'p').some((line) => line.startsWith('🔒 Read-only.')))
    await type(control(inspector, 'Runs when'), "$plan.output == 'go'")
    await type(control(panelOf(stage, 'Inspector'), 'Add a dependency'), 'run')
    await press(buttonNamed(panelOf(stage, 'Inspector'), 'Add'))
    assert.deepEqual(nodeYaml(stage, 'shared').sort(), ['id: shared', `when: "$plan.output == 'go'"`, 'depends_on:', '  - run', 'include: common.yaml', ''].sort())
  })
})

describe('undo and redo', () => {
  test('step back and forward through the edits from the header', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 0)
    await type(control(panelOf(stage, 'Inspector'), 'Prompt'), 'Changed')
    assert.equal(buttonNamed(stage.app, 'Redo').disabled, true)
    await press(buttonNamed(stage.app, 'Undo'))
    assert.match(yaml(stage), /prompt: Plan it/)
    assert.equal(unsaved(stage), false)
    assert.equal(buttonNamed(stage.app, 'Undo').disabled, true)
    await press(buttonNamed(stage.app, 'Redo'))
    assert.match(yaml(stage), /prompt: Changed/)
  })

  test('Ctrl+Z and Ctrl+Shift+Z undo and redo outside a text field', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 0)
    await press(buttonNamed(panelOf(stage, 'Inspector'), 'Remove'))
    assert.equal(boxes(stage).length, 2)
    await key(stage.app, 'z', { ctrlKey: true })
    assert.equal(boxes(stage).length, 3)
    await key(stage.app, 'z', { ctrlKey: true, shiftKey: true })
    assert.equal(boxes(stage).length, 2)
  })
})

describe('nodes', () => {
  test('are added from the Add node menu, selected, and laid out on the canvas', async () => {
    const stage = await open(answerFor(SMALL))
    const menuButton = buttonNamed(stage.app, 'Add node')
    assert.equal(menuButton.getAttribute('aria-expanded'), 'false')
    await press(menuButton)
    assert.equal(menuButton.getAttribute('aria-expanded'), 'true')
    const menu = stage.doc.getElementById(menuButton.getAttribute('aria-controls') ?? '')
    assert.ok(menu)
    assert.deepEqual(texts(menu, 'button'), ['Prompt', 'Command', 'Bash', 'Script', 'Loop', 'Approval', 'Wait', 'Cancel'])
    await press(buttonNamed(menu, 'Bash'))
    assert.equal(menuButton.getAttribute('aria-expanded'), 'false')
    assert.equal(boxes(stage).length, 4)
    assert.equal(texts(panelOf(stage, 'Inspector'), 'h2')[0], 'bash-1')
    assert.match(yaml(stage), /- id: bash-1\n\s+bash: ""/)
  })

  test('are duplicated and removed from the outline', async () => {
    const stage = await open(answerFor(SMALL))
    await press(buttonNamed(panelOf(stage, 'Outline'), 'Duplicate run'))
    assert.match(yaml(stage), /- id: run-copy\n\s+bash: npm test/)
    await press(buttonNamed(panelOf(stage, 'Outline'), 'Remove plan'))
    assert.ok(!/id: plan/.test(yaml(stage)))
    assert.ok(!/depends_on/.test(yaml(stage)))
    assert.equal(withClass(panelOf(stage, 'Outline'), 'outline-node').length, 3)
  })

  test('are duplicated and removed from the canvas, for the node chosen there', async () => {
    const stage = await open(answerFor(SMALL))
    await press(boxes(stage)[0] as FakeElement)
    const pane = withClass(stage.app, 'canvas-pane')[0] as FakeElement
    await press(buttonNamed(pane, 'Duplicate'))
    assert.equal(boxes(stage).length, 4)
    await press(buttonNamed(pane, 'Remove'))
    assert.equal(boxes(stage).length, 3)
  })
})

describe('dependencies', () => {
  test('are added from a select in the "Depends on" list and removed there', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 1)
    const inspector = panelOf(stage, 'Inspector')
    const select = control(inspector, 'Add a dependency')
    assert.deepEqual(texts(select, 'option'), ['Choose a node', 'shared'])
    await type(select, 'shared')
    await press(buttonNamed(inspector, 'Add'))
    assert.equal(withClass(stage.app, 'edge').length, 2)
    await press(buttonNamed(panelOf(stage, 'Inspector'), 'Remove the dependency on plan'))
    assert.equal(withClass(stage.app, 'edge').length, 1)
    assert.match(yaml(stage), /- id: run\n\s+depends_on:\n\s+- shared/)
  })

  test('connect mode: the Connect button shows a banner, a target pressed on the canvas gets the dependency', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 0)
    await press(buttonNamed(panelOf(stage, 'Inspector'), 'Connect'))
    assert.deepEqual(banner(stage), ['Connecting from plan: choose the node that runs after it. Esc cancels.'])
    await press(boxes(stage)[2] as FakeElement)
    assert.deepEqual(banner(stage), [])
    assert.match(yaml(stage), /- id: shared\n\s+depends_on:\n\s+- plan/)
    assert.equal(withClass(stage.app, 'edge').length, 2)
  })

  test('connect mode: C on a selected node starts it, Enter on a node in the outline ends it, Esc cancels it', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 2)
    await key(stage.app, 'c')
    assert.equal(banner(stage).length, 1)
    await key(stage.app, 'Escape')
    assert.deepEqual(banner(stage), [])
    await key(stage.app, 'c')
    const target = withClass(panelOf(stage, 'Outline'), 'outline-node')[0] as FakeElement
    target.focus()
    await key(target, 'Enter')
    await press(target)
    assert.ok(nodeYaml(stage, 'plan').join('\n').includes('depends_on:\n  - shared'))
    assert.deepEqual(banner(stage), [])
  })

  test('an edge pressed on the canvas is selected and offers Remove edge; Delete removes another', async () => {
    const stage = await open(answerFor({ name: 'e', nodes: [{ id: 'a', prompt: 'p' }, { id: 'b', prompt: 'p', depends_on: ['a'] }, { id: 'c', prompt: 'p', depends_on: ['a'] }] }))
    const edges = (): FakeElement[] => withClass(stage.app, 'edge')
    await press(edges()[0] as FakeElement)
    assert.ok((edges()[0]?.getAttribute('class') ?? '').split(' ').includes('selected'))
    const inspector = panelOf(stage, 'Inspector')
    assert.equal(texts(inspector, 'h2')[0], 'a → b')
    await press(buttonNamed(inspector, 'Remove edge'))
    assert.equal(edges().length, 1)
    await press(edges()[0] as FakeElement)
    await key(stage.app, 'Delete')
    assert.equal(edges().length, 0)
    assert.ok(!/depends_on/.test(yaml(stage)))
  })
})

describe('validation as the person edits', () => {
  test('a node at fault carries a glyph, the issues strip names the problem, and choosing it moves to the node', async () => {
    const stage = await open(answerFor(SMALL))
    assert.equal(withClass(stage.app, 'fault').length, 0)
    await choose(stage, 0)
    await type(control(panelOf(stage, 'Inspector'), 'Add a dependency'), 'run')
    await press(buttonNamed(panelOf(stage, 'Inspector'), 'Add'))
    const faulty = boxes(stage).filter((box) => (box.getAttribute('aria-label') ?? '').endsWith(', 1 error'))
    assert.deepEqual(
      faulty.map((box) => box.getAttribute('data-step')),
      ['n0']
    )
    assert.ok(findAll(faulty[0] as FakeElement, (element) => element.tagName === 'text').some((line) => line.textContent.startsWith('✖ 1 error')))
    assert.equal(withClass(panelOf(stage, 'Outline'), 'fault').length, 1)
    await choose(stage, 2)
    const strip = withClass(stage.app, 'issues-strip')[0] as FakeElement
    const issue = find(strip, (element) => element.tagName === 'button' && element.textContent.startsWith('Error: ') && element.textContent.endsWith('(node plan)'))
    assert.ok(issue, texts(strip, 'button').join(' | '))
    issue.focus()
    await press(issue)
    assert.equal(texts(panelOf(stage, 'Inspector'), 'h2')[0], 'plan')
    assert.equal(boxes(stage)[0]?.getAttribute('aria-pressed'), 'true')
    assert.equal(stage.doc.activeElement, issue)
    await press(buttonNamed(panelOf(stage, 'Inspector'), 'Remove the dependency on run'))
    assert.equal(withClass(stage.app, 'fault').length, 0)
  })
})

describe('what editing never does', () => {
  test('writes the file or sends anything but reads', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 0)
    await type(control(panelOf(stage, 'Inspector'), 'Prompt'), 'Changed')
    await press(buttonNamed(panelOf(stage, 'Outline'), 'Remove run'))
    assert.deepEqual(host?.edits, [])
    assert.equal(host?.text, POINTER)
    assert.deepEqual(
      [...new Set(stage.sent.map((call) => call.name))],
      ['builder.read']
    )
  })

  test('an installed workflow offers no edit: no form, no Add node, no outline actions', async () => {
    const stage = await open(answerFor(SMALL, { source: 'installed', viewOnly: true, openYaml: false }))
    await choose(stage, 0)
    assert.equal(findAll(stage.app, (element) => ['input', 'textarea', 'select'].includes(element.tagName)).length, 0)
    assert.equal(find(stage.app, (element) => element.tagName === 'button' && ['Add node', 'Undo', 'Connect', 'Remove plan'].includes(element.getAttribute('aria-label') ?? element.textContent)), null)
    await key(stage.app, 'c')
    assert.deepEqual(banner(stage), [])
  })
})

describe('past 300 nodes', () => {
  test('the notice stays, and the outline and the inspector still edit', async () => {
    const nodes = Array.from({ length: 301 }, (_, index) => ({ id: `n${String(index)}`, prompt: 'p' }))
    const stage = await open(answerFor({ name: 'big', nodes }))
    await press(buttonNamed(panelOf(stage, 'Outline'), 'Duplicate n3'))
    await choose(stage, 300)
    await type(control(panelOf(stage, 'Inspector'), 'Prompt'), 'last')
    await type(control(panelOf(stage, 'Inspector'), 'Add a dependency'), 'n0')
    await press(buttonNamed(panelOf(stage, 'Inspector'), 'Add'))
    assert.equal(boxes(stage).length, 0)
    assert.ok(texts(stage.app, 'p').some((line) => line.startsWith('This workflow has 302 nodes.')))
    assert.match(yaml(stage), /- id: n300\n\s+depends_on:\n\s+- n0\n\s+prompt: last/)
    assert.match(yaml(stage), /- id: n3-copy/)
  })
})

describe('a refetch while editing', () => {
  const CHANGED = { ...SMALL, nodes: [...SMALL.nodes, { id: 'extra', prompt: 'x' }] }

  test('with no unsaved changes shows the new copy', async () => {
    const stage = await open(answerFor(SMALL))
    stage.answer.value = answerFor(CHANGED)
    await press(buttonNamed(stage.app, 'Reload'))
    assert.equal(boxes(stage).length, 4)
  })

  test('with unsaved changes never replaces the copy being edited without asking', async () => {
    const stage = await open(answerFor(SMALL))
    await choose(stage, 0)
    await type(control(panelOf(stage, 'Inspector'), 'Prompt'), 'Mine')
    stage.answer.value = { connection: { kind: 'searching', banner: 'Reconnecting…', label: 'Looking…' }, builder: { kind: 'not-connected' } }
    await stage.post('connection.changed', { kind: 'searching' })
    stage.answer.value = answerFor(CHANGED)
    await stage.post('connection.changed', { kind: 'connected' })
    assert.equal(boxes(stage).length, 3)
    assert.match(yaml(stage), /prompt: Mine/)
    assert.ok(texts(stage.app, 'p').includes('This workflow changed outside the builder. Your unsaved changes are kept until you choose.'))
    await press(buttonNamed(stage.app, 'Keep editing'))
    assert.ok(!texts(stage.app, 'p').includes('This workflow changed outside the builder. Your unsaved changes are kept until you choose.'))
    assert.match(yaml(stage), /prompt: Mine/)
    await press(buttonNamed(stage.app, 'Reload'))
    assert.ok(texts(stage.app, 'p').includes('Reloading replaces the copy you are editing. Your unsaved changes are kept until you choose.'))
    await press(buttonNamed(stage.app, 'Load the saved copy'))
    assert.equal(boxes(stage).length, 4)
    assert.ok(!/Mine/.test(yaml(stage)))
    assert.equal(unsaved(stage), false)
  })
})
