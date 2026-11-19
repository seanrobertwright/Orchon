// The frame seam for builder drafts (#61): the tab driven through Orca's stand-in editor host, a
// scripted worker and a stand-in DOM. These tests cover a draft given back by the worker's read:
// restored before the first paint under a notice with Discard, the edits handed to the worker
// after a pause, what Save and Discard do to it, a draft made on another Archon, the banner while
// Archon is away, and a new workflow that Archon does not hold yet.
import { afterEach, assert, describe, mockEditorHost, test, type MockEditorHost } from 'orca/testing'
import { fakeDocument, find, findAll, withClass, type FakeDocument, type FakeElement } from '../../scripts/fake-dom.ts'
import { createClock, settle, type Clock } from '../../scripts/scripted-archon.ts'
import type { TabConnection } from '../run-graph/graph-view.ts'
import { readPointer } from '../run-graph/tab.ts'
import type { BuilderAnswer, BuilderDraftView, BuilderDraftWriteAnswer, BuilderHeader, BuilderSaveOutcome } from './builder-view.ts'
import { startBuilderTab, type BuilderTab } from './tab.ts'

const IDENTITY = { name: 'small', codebaseId: 'cb-web', scope: 'project' }
const POINTER = `${JSON.stringify({ orchon: 'builder', ...IDENTITY })}\n`
const FILE = 'C:/Projects/web/.archon/workflows/small.yaml'
const header: BuilderHeader = { name: 'small', source: 'project', file: FILE, viewOnly: false, openYaml: false }
const connected: TabConnection = { kind: 'connected', live: true }
const notFound: TabConnection = {
  kind: 'screen',
  screen: { title: 'Orchon could not find Archon.', lines: ['Nothing answered.'], command: 'archon serve', after: [], tryAgain: true, install: null }
}

const SMALL = { name: 'small', description: 'Plan, then test', nodes: [{ id: 'plan', prompt: 'Plan it' }] }
const MINE = { ...SMALL, description: 'My half-hour of edits' }
const draftOf = (over: Partial<BuilderDraftView> = {}): BuilderDraftView => ({ definition: MINE, base: { source: 'project', authored: SMALL }, file: FILE, isNew: false, otherArchon: false, ...over })
const answerOf = (draft: BuilderDraftView | null, definition: Record<string, unknown> = SMALL, connection: TabConnection = connected): BuilderAnswer => ({
  connection,
  builder: connection.kind === 'connected' ? { kind: 'ready', header, definition } : { kind: 'not-connected' },
  draft
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
  clock: Clock
  sent: Sent[]
  read: { value: BuilderAnswer }
  saves: BuilderSaveOutcome[]
  /** What `builder.draft.write` answers, in turn, or an error it fails with; kept when none is scripted. */
  writes: (BuilderDraftWriteAnswer | Error)[]
}

async function open(first: BuilderAnswer, text = POINTER): Promise<Stage> {
  host = mockEditorHost({ text })
  const doc = fakeDocument()
  const app = doc.getElementById('app')
  if (app === null) throw new Error('The stand-in document has no #app.')
  const clock = createClock()
  const sent: Sent[] = []
  const stage: Stage = { doc, app, clock, sent, read: { value: first }, saves: [], writes: [] }
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
        return { connection: stage.read.value.connection, save: next }
      }
      if (name === 'builder.draft.write') {
        const next = stage.writes.shift() ?? { kept: true }
        if (next instanceof Error) throw next
        return next
      }
      if (name === 'builder.draft.discard' || name === 'connection.retry') return null
      return stage.read.value
    },
    on() {
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
const description = (stage: Stage): string => {
  const found = find(panelOf(stage, 'Inspector'), (element) => element.tagName === 'textarea')
  if (found === null) throw new Error('There is no description field.')
  return found.value
}
const describeAs = async (stage: Stage, text: string): Promise<void> => {
  const area = find(panelOf(stage, 'Inspector'), (element) => element.tagName === 'textarea')
  if (area === null) throw new Error('There is no description field.')
  area.value = text
  area.dispatch('input')
  await settle()
}
const unsaved = (stage: Stage): string => withClass(stage.app, 'unsaved')[0]?.textContent ?? ''
const banners = (stage: Stage): string[] => texts(withClass(stage.app, 'banners')[0] as FakeElement, 'p')
const named = (stage: Stage, name: string): Sent[] => stage.sent.filter((call) => call.name === name)
const notice = (stage: Stage): FakeElement | undefined => withClass(stage.app, 'draft-notice').find((element) => !element.hidden)

describe('a draft given back on open', () => {
  test('is restored before the first paint, as unsaved, under a notice with Discard', async () => {
    const stage = await open(answerOf(draftOf()))
    assert.equal(named(stage, 'builder.read').length, 1)
    assert.equal(description(stage), 'My half-hour of edits')
    assert.equal(unsaved(stage), 'Unsaved changes')
    const shown = notice(stage)
    assert.ok(shown)
    assert.deepEqual(texts(shown, 'p'), ['Your unsaved changes from before are restored from a draft.'])
    assert.ok(buttonNamed(shown, 'Discard the draft'))
  })

  test('whose base differs from what Archon serves now goes through the three choices, and Overwrite sends what Archon serves as the base', async () => {
    const elsewhere = { ...SMALL, description: 'Changed elsewhere' }
    const stage = await open(answerOf(draftOf(), elsewhere))
    assert.equal(description(stage), 'My half-hour of edits')
    assert.ok(texts(stage.app, 'p').includes('This workflow changed outside the builder since your draft was made. Your draft is kept until you choose.'))
    for (const name of ['Reload and lose my edits', 'Overwrite the outside change', 'Keep editing']) assert.ok(buttonNamed(stage.app, name))
    assert.deepEqual(named(stage, 'builder.save'), [])
    stage.saves.push({ kind: 'saved', source: 'project' })
    await press(buttonNamed(stage.app, 'Overwrite the outside change'))
    assert.deepEqual(
      named(stage, 'builder.save').map((call) => (call.input as { base: unknown }).base),
      [{ source: 'project', authored: elsewhere }]
    )
  })

  test('Reload and lose my edits deletes the draft and shows what Archon serves', async () => {
    const elsewhere = { ...SMALL, description: 'Changed elsewhere' }
    const stage = await open(answerOf(draftOf(), elsewhere))
    stage.read.value = answerOf(null, elsewhere)
    await press(buttonNamed(stage.app, 'Reload and lose my edits'))
    assert.deepEqual(named(stage, 'builder.draft.discard').map((call) => call.input), [IDENTITY])
    assert.equal(description(stage), 'Changed elsewhere')
    assert.equal(notice(stage), undefined)
  })
})

describe('edits and the draft', () => {
  test('a burst of edits goes to the worker as one draft after a pause, with the copy it started from and the file', async () => {
    const stage = await open(answerOf(null))
    await describeAs(stage, 'One')
    await describeAs(stage, 'One two')
    assert.deepEqual(named(stage, 'builder.draft.write'), [])
    await stage.clock.advance(500)
    assert.deepEqual(
      named(stage, 'builder.draft.write').map((call) => call.input),
      [{ ...IDENTITY, definition: { ...SMALL, description: 'One two' }, base: { source: 'project', authored: SMALL }, file: FILE }]
    )
  })

  test('an edit still waiting for the pause is handed over when the tab closes', async () => {
    const stage = await open(answerOf(null))
    await describeAs(stage, 'Closing now')
    tab?.stop()
    tab = undefined
    assert.equal(named(stage, 'builder.draft.write').length, 1)
  })

  test('edits undone back to the copy opened discard the draft', async () => {
    const stage = await open(answerOf(draftOf()))
    await describeAs(stage, SMALL.description)
    await stage.clock.advance(500)
    assert.deepEqual(named(stage, 'builder.draft.write'), [])
    assert.deepEqual(named(stage, 'builder.draft.discard').map((call) => call.input), [IDENTITY])
  })

  test('a draft the worker refuses at the cap is said in the banner, and the copy stays editable', async () => {
    const stage = await open(answerOf(null))
    const reason = 'Orchon keeps at most 20 builder drafts, so this one is not kept. Save or discard another draft first.'
    stage.writes.push({ kept: false, reason })
    await describeAs(stage, 'Twenty-first')
    await stage.clock.advance(500)
    assert.ok(banners(stage).includes(reason))
    assert.equal(description(stage), 'Twenty-first')
  })

  test('a draft the worker does not answer is said in the banner', async () => {
    const stage = await open(answerOf(null))
    stage.writes.push(new Error('The worker stopped.'))
    await describeAs(stage, 'Lost?')
    await stage.clock.advance(500)
    assert.ok(banners(stage).includes("Orchon's worker did not answer, so your latest changes may not be kept as a draft."))
    await describeAs(stage, 'Kept')
    await stage.clock.advance(500)
    assert.ok(!banners(stage).includes("Orchon's worker did not answer, so your latest changes may not be kept as a draft."))
  })

  test('Discard deletes the draft at once and shows the copy Archon serves', async () => {
    const stage = await open(answerOf(draftOf()))
    stage.read.value = answerOf(null)
    await press(buttonNamed(stage.app, 'Discard the draft'))
    assert.deepEqual(named(stage, 'builder.draft.discard').map((call) => call.input), [IDENTITY])
    assert.equal(description(stage), 'Plan, then test')
    assert.equal(unsaved(stage), '')
    assert.equal(notice(stage), undefined)
  })

  test('a save lets the notice go, and nothing more is sent as a draft until the next edit', async () => {
    const stage = await open(answerOf(draftOf()))
    stage.saves.push({ kind: 'saved', source: 'project' })
    await press(buttonNamed(stage.app, 'Save'))
    assert.equal(unsaved(stage), '')
    assert.equal(notice(stage), undefined)
    await stage.clock.advance(500)
    assert.deepEqual(named(stage, 'builder.draft.write'), [])
    assert.deepEqual(named(stage, 'builder.draft.discard'), [])
  })
})

describe('a draft made on a different Archon', () => {
  test('stays editable with Save disabled under the sentence, and is neither discarded nor saved', async () => {
    const stage = await open(answerOf(draftOf({ otherArchon: true }), { ...SMALL, description: 'The copy this Archon holds' }))
    assert.equal(description(stage), 'My half-hour of edits')
    assert.ok(banners(stage).includes('This draft was made on a different Archon.'))
    const save = buttonNamed(stage.app, 'Save')
    assert.equal(save.getAttribute('aria-disabled'), 'true')
    assert.equal(save.getAttribute('title'), 'This draft was made on a different Archon.')
    await press(save)
    assert.equal(withClass(stage.app, 'outside-change')[0]?.hidden, true)
    await describeAs(stage, 'Still mine')
    await stage.clock.advance(500)
    assert.equal(named(stage, 'builder.draft.write').length, 1)
    assert.deepEqual(named(stage, 'builder.save'), [])
    assert.deepEqual(named(stage, 'builder.draft.discard'), [])
  })
})

describe('while Archon is away', () => {
  test('a draft opens editable under the status sentence, the draft line and Try again', async () => {
    const stage = await open(answerOf(draftOf(), SMALL, notFound))
    assert.equal(description(stage), 'My half-hour of edits')
    assert.deepEqual(banners(stage), ['Orchon could not find Archon.', 'Your changes are kept as a draft.'])
    assert.ok(texts(stage.app, 'p').includes(`File: ${FILE}`))
    await describeAs(stage, 'Edited offline')
    await stage.clock.advance(500)
    assert.equal(named(stage, 'builder.draft.write').length, 1)
    await press(buttonNamed(withClass(stage.app, 'banners')[0] as FakeElement, 'Try again'))
    assert.equal(named(stage, 'connection.retry').length, 1)
  })

  test('Searching keeps the copy under its banner and the draft line, with no Try again', async () => {
    const searching: TabConnection = { kind: 'searching', banner: 'Archon stopped answering. Reconnecting…', label: 'Looking for Archon…' }
    const stage = await open(answerOf(draftOf(), SMALL, searching))
    assert.deepEqual(banners(stage), ['Archon stopped answering. Reconnecting…', 'Your changes are kept as a draft.'])
    assert.equal(find(withClass(stage.app, 'banners')[0] as FakeElement, (element) => element.tagName === 'button'), null)
  })
})

describe('a new workflow', () => {
  const NEW = { name: 'small', description: '', nodes: [{ id: 'prompt-1', prompt: '' }] }
  const newDraft = draftOf({ definition: NEW, base: null, isNew: true, file: "small.yaml in the project's .archon/workflows folder, once saved" })
  const gone: BuilderAnswer = { connection: connected, builder: { kind: 'gone', message: 'Archon has no workflow named small here.' }, draft: newDraft }

  test('opens its one empty prompt node as unsaved, says Archon does not hold it yet, and saves expecting none', async () => {
    const stage = await open(gone)
    assert.ok(find(panelOf(stage, 'Outline'), (element) => element.tagName === 'button' && element.textContent.includes('prompt-1')))
    assert.equal(unsaved(stage), 'Unsaved changes')
    assert.deepEqual(banners(stage), [])
    assert.deepEqual(texts(notice(stage) as FakeElement, 'p'), ['This new workflow is not in Archon yet: the first Save writes it.'])
    stage.saves.push({ kind: 'saved', source: 'project' })
    await press(buttonNamed(stage.app, 'Save'))
    assert.deepEqual(named(stage, 'builder.save').map((call) => call.input), [{ ...IDENTITY, locale: 'en-GB', definition: NEW, base: null }])
  })

  test('Discard deletes it and leaves the tab with nothing to show, reading nothing from Archon', async () => {
    const stage = await open(gone)
    await press(buttonNamed(stage.app, 'Discard the draft'))
    assert.deepEqual(named(stage, 'builder.draft.discard').map((call) => call.input), [IDENTITY])
    assert.equal(named(stage, 'builder.read').length, 1)
    assert.ok(texts(stage.app, 'p').includes('This new workflow was discarded. Nothing was written to Archon.'))
  })
})
