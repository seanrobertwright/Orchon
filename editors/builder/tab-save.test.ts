// The frame seam for the builder's Save and Validate (#16, #28): the tab driven through Orca's
// stand-in editor host, a scripted worker and a stand-in DOM. These tests press Save and Validate
// and the save keys as a person does, and read the requests the tab sends and what it draws: the
// header, the banners, the three choices after an outside change, and Archon's sentences at the
// top of the issues. The pointer file is never edited.
import { afterEach, assert, describe, mockEditorHost, test, type MockEditorHost } from 'orca/testing'
import { fakeDocument, find, findAll, withClass, type FakeDocument, type FakeElement } from '../../scripts/fake-dom.ts'
import { createClock, settle } from '../../scripts/scripted-archon.ts'
import type { TabConnection } from '../run-graph/graph-view.ts'
import { readPointer } from '../run-graph/tab.ts'
import type { BuilderAnswer, BuilderHeader, BuilderSaveOutcome, BuilderValidateOutcome } from './builder-view.ts'
import { startBuilderTab, type BuilderTab } from './tab.ts'

const IDENTITY = { name: 'small', codebaseId: 'cb-web', scope: 'project' }
const POINTER = `${JSON.stringify({ orchon: 'builder', ...IDENTITY })}\n`
const header: BuilderHeader = { name: 'small', source: 'project', file: 'C:/Projects/web/.archon/workflows/small.yaml', viewOnly: false, openYaml: false }
const connected: TabConnection = { kind: 'connected', live: true }
const searching: TabConnection = { kind: 'searching', banner: 'Looking for Archon again…', label: 'Looking for Archon…' }

/** A workflow with a field no release names, on a node and on the workflow. */
const SMALL = {
  name: 'small',
  description: 'Plan, then test',
  'x-team': { owner: 'someone' },
  nodes: [
    { id: 'plan', prompt: 'Plan it', teleport: { to: 'mars' } },
    { id: 'run', bash: 'npm test', depends_on: ['plan'] }
  ]
}
const readyFor = (definition: Record<string, unknown>, over: Partial<BuilderHeader> = {}, connection: TabConnection = connected): BuilderAnswer => ({
  connection,
  builder: { kind: 'ready', header: { ...header, ...over }, definition }
})

let host: MockEditorHost | undefined
let tab: BuilderTab | undefined
afterEach(() => {
  tab?.stop()
  tab = undefined
  host?.dispose()
  host = undefined
})

type Sent = { name: string; input: unknown }
type Stage = {
  doc: FakeDocument
  app: FakeElement
  sent: Sent[]
  /** What `builder.read` answers. */
  read: { value: BuilderAnswer }
  /** What `builder.save` answers, in turn; a pending promise holds the save open. */
  saves: (BuilderSaveOutcome | Promise<BuilderSaveOutcome>)[]
  validates: BuilderValidateOutcome[]
  /** Tells the tab it is shown again. */
  show(): Promise<void>
}

async function open(first: BuilderAnswer, text = POINTER): Promise<Stage> {
  host = mockEditorHost({ text })
  const doc = fakeDocument()
  const app = doc.getElementById('app')
  if (app === null) throw new Error('The stand-in document has no #app.')
  const clock = createClock()
  const sent: Sent[] = []
  const shown: (() => void)[] = []
  const stage: Stage = {
    doc,
    app,
    sent,
    read: { value: first },
    saves: [],
    validates: [],
    async show() {
      for (const listener of shown) listener()
      await settle()
    }
  }
  tab = startBuilderTab({
    doc: doc as unknown as Document,
    app: app as unknown as HTMLElement,
    readPointer,
    locale: 'en-GB',
    timers: clock.timers,
    async request(name, input) {
      sent.push({ name, input })
      if (name === 'builder.save') {
        const next = stage.saves.shift()
        if (next === undefined) throw new Error('No save was scripted.')
        return { connection: stage.read.value.connection, save: await next }
      }
      if (name === 'builder.validate') {
        const next = stage.validates.shift()
        if (next === undefined) throw new Error('No validation was scripted.')
        return { connection: stage.read.value.connection, validate: next }
      }
      return stage.read.value
    },
    on() {
      return { dispose: () => {} }
    },
    onShown(listener) {
      shown.push(listener)
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
const buttonNamed = (root: FakeElement, name: string): FakeElement => {
  const found = find(root, (element) => element.tagName === 'button' && (element.getAttribute('aria-label') ?? element.textContent) === name)
  if (found === null) throw new Error(`There is no button named ${name}.`)
  return found
}
const press = async (element: FakeElement): Promise<void> => {
  element.click()
  await settle()
}
const panelOf = (stage: Stage, name: string): FakeElement => {
  const tabButton = find(stage.app, (element) => element.getAttribute('role') === 'tab' && element.textContent === name)
  const id = tabButton?.getAttribute('aria-controls') ?? null
  const found = id === null ? null : stage.doc.getElementById(id)
  if (found === null) throw new Error(`There is no ${name} panel.`)
  return found
}
const control = (root: FakeElement, label: string): FakeElement => {
  const found = find(root, (element) => element.tagName === 'label' && element.textContent === label)
  const id = found?.getAttribute('for') ?? null
  const target = id === null ? null : find(root, (element) => element.id === id)
  if (target === null) throw new Error(`No control is labelled ${label}.`)
  return target
}
/** Changes the workflow's description, as typing into its field does. */
const describeAs = async (stage: Stage, text: string): Promise<void> => {
  const area = control(panelOf(stage, 'Inspector'), 'Workflow description')
  area.value = text
  area.dispatch('input')
  await settle()
}
const unsaved = (stage: Stage): string => withClass(stage.app, 'unsaved')[0]?.textContent ?? ''
const banners = (stage: Stage): string[] => texts(withClass(stage.app, 'banners')[0] as FakeElement, 'p')
const saves = (stage: Stage): Sent[] => stage.sent.filter((call) => call.name === 'builder.save')
const reads = (stage: Stage): Sent[] => stage.sent.filter((call) => call.name === 'builder.read')

describe("the builder's Save", () => {
  test('sends the identity, the definition as it stands and the copy it opened; on success Unsaved changes clears and the pointer file is untouched', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Plan, then test well')
    assert.equal(unsaved(stage), 'Unsaved changes')
    stage.saves.push({ kind: 'saved', source: 'project' })
    await press(buttonNamed(stage.app, 'Save'))
    const edited = { ...SMALL, description: 'Plan, then test well' }
    assert.deepEqual(saves(stage), [{ name: 'builder.save', input: { ...IDENTITY, locale: 'en-GB', definition: edited, base: { source: 'project', authored: SMALL } } }])
    assert.equal(unsaved(stage), '')
    assert.ok(banners(stage).includes('Saved.'))
    assert.deepEqual(host?.edits, [])
    assert.equal(host?.text, POINTER)
  })

  test('Ctrl+S or Cmd+S inside the frame saves, from a field too, and the key goes no further', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Changed')
    const area = control(panelOf(stage, 'Inspector'), 'Workflow description')
    stage.saves.push({ kind: 'saved', source: 'project' }, { kind: 'saved', source: 'project' })
    const ctrl = area.dispatch('keydown', { key: 's', ctrlKey: true })
    await settle()
    const cmd = stage.app.dispatch('keydown', { key: 's', metaKey: true })
    await settle()
    assert.equal(ctrl.defaultPrevented, true)
    assert.equal(cmd.defaultPrevented, true)
    assert.equal(saves(stage).length, 2)
  })

  test('an error that blocks saving stops the save in the tab, and nothing is sent', async () => {
    const stage = await open(readyFor({ name: 'small', nodes: [{ id: 'a', prompt: 'p' }, { id: 'a', prompt: 'q' }] }))
    await press(buttonNamed(stage.app, 'Save'))
    assert.deepEqual(saves(stage), [])
    assert.ok(banners(stage).includes('Fix the errors that block saving before you save: they are listed under Issues. Nothing was sent.'))
  })

  test('a warning does not stop the save', async () => {
    const stage = await open(readyFor({ name: 'small', nodes: [{ id: 'a', prompt: 'Use $nobody.output' }] }))
    stage.saves.push({ kind: 'saved', source: 'project' })
    await press(buttonNamed(stage.app, 'Save'))
    assert.equal(saves(stage).length, 1)
  })

  test("a draft Archon's validation rejects is not saved: Unsaved changes stays and its sentences show as text at the top of the issues", async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Changed')
    stage.saves.push({ kind: 'invalid', errors: ["Node 'a' depends_on unknown node '<b>missing</b>'"], more: 2 })
    await press(buttonNamed(stage.app, 'Save'))
    assert.equal(unsaved(stage), 'Unsaved changes')
    assert.ok(banners(stage).includes("Archon's validation rejected this workflow, so it was not saved. Its sentences are at the top of Issues."))
    const strip = withClass(stage.app, 'issues-strip')[0] as FakeElement
    const server = withClass(strip, 'server-check')[0] as FakeElement
    assert.equal(strip.children[1], server)
    assert.deepEqual(texts(server, 'li'), ["✖ Archon: Node 'a' depends_on unknown node '<b>missing</b>'"])
    assert.ok(texts(server, 'p').includes('2 more sentences are not shown.'))
    assert.equal(find(stage.app, (element) => element.markupWritten), null)
  })

  test('an outside change stops the save and offers three choices; Keep editing keeps the edits and asks nothing more', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Mine')
    const outside = { ...SMALL, description: 'Theirs' }
    stage.saves.push({ kind: 'changed', message: 'This workflow changed outside the builder since you opened it, so nothing was written.', current: { source: 'project', authored: outside } })
    await press(buttonNamed(stage.app, 'Save'))
    const prompt = withClass(stage.app, 'outside-change')[0] as FakeElement
    assert.equal(prompt.hidden, false)
    assert.deepEqual(texts(prompt, 'p'), ['This workflow changed outside the builder since you opened it, so nothing was written.'])
    assert.deepEqual(texts(prompt, 'button'), ['Reload and lose my edits', 'Overwrite the outside change', 'Keep editing'])
    await press(buttonNamed(prompt, 'Keep editing'))
    assert.equal(prompt.hidden, true)
    assert.equal(unsaved(stage), 'Unsaved changes')
    assert.equal(control(panelOf(stage, 'Inspector'), 'Workflow description').value, 'Mine')
  })

  test('Overwrite saves again over the outside change the person was shown', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Mine')
    const current = { source: 'project', authored: { ...SMALL, description: 'Theirs' } }
    stage.saves.push({ kind: 'changed', message: 'Changed outside.', current }, { kind: 'saved', source: 'project' })
    await press(buttonNamed(stage.app, 'Save'))
    await press(buttonNamed(withClass(stage.app, 'outside-change')[0] as FakeElement, 'Overwrite the outside change'))
    const sent = saves(stage).map((call) => call.input as { base: unknown; definition: { description: string } })
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[1]?.base, current)
    assert.equal(sent[1]?.definition.description, 'Mine')
    assert.equal(unsaved(stage), '')
  })

  test('Reload and lose my edits reads the workflow again and opens what Archon serves in place of the edits', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Mine')
    stage.saves.push({ kind: 'changed', message: 'Changed outside.', current: { source: 'project', authored: { ...SMALL, description: 'Theirs' } } })
    await press(buttonNamed(stage.app, 'Save'))
    stage.read.value = readyFor({ ...SMALL, description: 'Theirs' })
    await press(buttonNamed(withClass(stage.app, 'outside-change')[0] as FakeElement, 'Reload and lose my edits'))
    assert.equal(reads(stage).length, 2)
    assert.equal(control(panelOf(stage, 'Inspector'), 'Workflow description').value, 'Theirs')
    assert.equal(unsaved(stage), '')
    assert.equal((withClass(stage.app, 'outside-change')[0] as FakeElement).hidden, true)
  })

  test('after a save, the saved copy is what later checks compare against: the next save sends it as the base, and a read of it asks nothing', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'First')
    stage.saves.push({ kind: 'saved', source: 'project' }, { kind: 'saved', source: 'project' })
    await press(buttonNamed(stage.app, 'Save'))
    // Archon serves the saved copy back with its keys in another order.
    const { nodes, ...rest } = { ...SMALL, description: 'First' }
    stage.read.value = readyFor({ nodes, ...rest })
    await describeAs(stage, 'Second')
    await stage.show()
    assert.equal((withClass(stage.app, 'outside-change')[0] as FakeElement).hidden, true)
    await press(buttonNamed(stage.app, 'Save'))
    const second = saves(stage)[1]?.input as { base: { source: string; authored: { description: string } } }
    assert.equal(second.base.source, 'project')
    assert.equal(second.base.authored.description, 'First')
  })

  test('a save that timed out says whether it landed; one that landed clears Unsaved changes, one that did not keeps them', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Mine')
    stage.saves.push({ kind: 'timeout', landed: false, message: 'Not landed.', source: null })
    await press(buttonNamed(stage.app, 'Save'))
    assert.ok(banners(stage).includes('Not landed.'))
    assert.equal(unsaved(stage), 'Unsaved changes')
    stage.saves.push({ kind: 'timeout', landed: true, message: 'Landed.', source: 'project' })
    await press(buttonNamed(stage.app, 'Save'))
    assert.ok(banners(stage).includes('Landed.'))
    assert.equal(unsaved(stage), '')
    assert.equal(saves(stage).length, 2)
  })

  test('one save at a time: Save is disabled, and says why, while a save waits', async () => {
    const stage = await open(readyFor(SMALL))
    let finish: (outcome: BuilderSaveOutcome) => void = () => {}
    stage.saves.push(new Promise((resolve) => (finish = resolve)))
    await press(buttonNamed(stage.app, 'Save'))
    const saveButton = buttonNamed(stage.app, 'Save')
    assert.equal(saveButton.getAttribute('aria-disabled'), 'true')
    assert.equal(saveButton.getAttribute('title'), 'A save is waiting for Archon.')
    await press(saveButton)
    stage.app.dispatch('keydown', { key: 's', ctrlKey: true })
    await settle()
    assert.equal(saves(stage).length, 1)
    finish({ kind: 'saved', source: 'project' })
    await settle()
    assert.equal(saveButton.getAttribute('aria-disabled'), null)
  })

  test('a bundled workflow saved as the project copy is read as the project one from then on, and its file is untouched', async () => {
    const stage = await open(readyFor(SMALL, { source: 'bundled' }), `${JSON.stringify({ orchon: 'builder', ...IDENTITY, scope: 'bundled' })}\n`)
    await describeAs(stage, 'Mine')
    stage.saves.push({ kind: 'saved', source: 'project' })
    stage.read.value = readyFor({ ...SMALL, description: 'Mine' })
    await press(buttonNamed(stage.app, 'Save'))
    assert.deepEqual((saves(stage)[0]?.input as { base: unknown }).base, { source: 'bundled', authored: SMALL })
    assert.deepEqual(reads(stage).map((call) => (call.input as { scope: string }).scope), ['bundled', 'project'])
    assert.equal(unsaved(stage), '')
    assert.deepEqual(host?.edits, [])
  })

  test("an installed workflow stays view-only: it has no Save or Validate, and the save keys send nothing", async () => {
    const stage = await open(readyFor(SMALL, { source: 'installed', viewOnly: true }))
    assert.equal(find(stage.app, (element) => element.tagName === 'button' && element.textContent === 'Save'), null)
    assert.equal(find(stage.app, (element) => element.tagName === 'button' && element.textContent === 'Validate'), null)
    stage.app.dispatch('keydown', { key: 's', ctrlKey: true })
    await settle()
    assert.deepEqual(saves(stage), [])
  })
})

describe("the builder's Validate", () => {
  test("asks the worker with the definition as it stands, shows Archon's sentences at the top of the issues, and writes nothing", async () => {
    const stage = await open(readyFor(SMALL))
    stage.validates.push({ kind: 'invalid', errors: ['First problem', 'Second problem'], more: 0 }, { kind: 'valid' })
    await press(buttonNamed(stage.app, 'Validate'))
    assert.deepEqual(stage.sent.filter((call) => call.name === 'builder.validate'), [{ name: 'builder.validate', input: { definition: SMALL, locale: 'en-GB' } }])
    assert.deepEqual(saves(stage), [])
    const strip = withClass(stage.app, 'issues-strip')[0] as FakeElement
    assert.deepEqual(texts(withClass(strip, 'server-check')[0] as FakeElement, 'li'), ['✖ Archon: First problem', '✖ Archon: Second problem'])
    await press(buttonNamed(stage.app, 'Validate'))
    assert.deepEqual(texts(withClass(strip, 'server-check')[0] as FakeElement, 'p'), ["Archon's validation found no problems."])
  })

  test("Archon's sentences are let go once the copy they were about changes", async () => {
    const stage = await open(readyFor(SMALL))
    stage.validates.push({ kind: 'invalid', errors: ['A problem'], more: 0 })
    await press(buttonNamed(stage.app, 'Validate'))
    await describeAs(stage, 'Changed')
    assert.deepEqual(withClass(stage.app, 'server-check'), [])
  })
})

describe('Save and Validate while not connected', () => {
  for (const [name, connection] of [
    ['Searching', searching],
    ['a state screen', { kind: 'screen', screen: { title: 'Orchon could not find Archon.', lines: [], command: null, after: [], tryAgain: true, install: null } }]
  ] as const) {
    test(`are disabled in ${name}, say why on focus and on hover, and send nothing`, async () => {
      const stage = await open(readyFor(SMALL))
      stage.read.value = { connection: connection as TabConnection, builder: { kind: 'not-connected' } }
      await press(buttonNamed(stage.app, 'Reload'))
      for (const label of ['Save', 'Validate']) {
        const writeButton = buttonNamed(stage.app, label)
        assert.equal(writeButton.getAttribute('aria-disabled'), 'true')
        assert.equal(writeButton.getAttribute('title'), 'Orchon is not connected to Archon, so this workflow cannot be saved or validated now.')
        const reasonId = writeButton.getAttribute('aria-describedby')
        const reason = reasonId === null ? null : stage.doc.getElementById(reasonId)
        assert.equal(reason?.textContent, 'Orchon is not connected to Archon, so this workflow cannot be saved or validated now.')
        assert.equal(reason?.hidden, true)
        writeButton.dispatch('focus')
        assert.equal(reason?.hidden, false)
        writeButton.dispatch('blur')
        assert.equal(reason?.hidden, true)
        writeButton.dispatch('mouseenter')
        assert.equal(reason?.hidden, false)
        writeButton.dispatch('mouseleave')
        await press(writeButton)
      }
      stage.app.dispatch('keydown', { key: 's', ctrlKey: true })
      await settle()
      assert.deepEqual(stage.sent.filter((call) => call.name === 'builder.save' || call.name === 'builder.validate'), [])
      stage.read.value = readyFor(SMALL)
      await press(buttonNamed(stage.app, 'Reload'))
      assert.equal(buttonNamed(stage.app, 'Save').getAttribute('aria-disabled'), null)
    })
  }
})

describe('the tab shown again', () => {
  test('reads the workflow again; an outside change replaces a copy with no unsaved changes, with a notice', async () => {
    const stage = await open(readyFor(SMALL))
    stage.read.value = readyFor({ ...SMALL, description: 'Theirs' })
    await stage.show()
    assert.equal(reads(stage).length, 2)
    assert.equal(control(panelOf(stage, 'Inspector'), 'Workflow description').value, 'Theirs')
    assert.ok(banners(stage).includes('This workflow changed outside the builder while the tab was away. The builder now shows the copy Archon serves.'))
  })

  test('over unsaved changes it asks before anything is replaced, and the same copy asks nothing', async () => {
    const stage = await open(readyFor(SMALL))
    await describeAs(stage, 'Mine')
    await stage.show()
    const prompt = withClass(stage.app, 'outside-change')[0] as FakeElement
    assert.equal(prompt.hidden, true)
    stage.read.value = readyFor({ ...SMALL, description: 'Theirs' })
    await stage.show()
    assert.equal(prompt.hidden, false)
    assert.deepEqual(texts(prompt, 'p'), ['This workflow changed outside the builder. Your unsaved changes are kept until you choose.'])
    assert.equal(control(panelOf(stage, 'Inspector'), 'Workflow description').value, 'Mine')
  })
})
