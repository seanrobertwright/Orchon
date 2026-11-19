// The frame seam for the panel: src/panel.tsx mounted on a scripted worker. These tests cover the
// Aliases group of the Settings section: what is drawn from the worker's view model, and which
// requests Remove, Undo and "Add alias" send.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answering, connected, searching, systemRead } from '../scripts/connection-samples.ts'
import { aliasesRead, formsRead } from '../scripts/forms-samples.ts'
import type { ConnectionView } from './connection-view'
import type { FormsView } from './forms-view'
import * as panelModule from './panel'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

async function mountOn(state: ConnectionView, forms: FormsView): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answering(state, systemRead, forms)),
    persisted: { workspace: { section: 'settings' } }
  })
  return panel
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

function inside(view: TestPanel, type: string): ReturnType<TestPanel['findAll']> {
  const group = view.find({ type: 'Collapsible', label: 'Aliases' })
  assert.ok(group, 'no Aliases group')
  return view.findAll({ type }).filter((element) => element.path.startsWith(`${group.path}/`))
}

const button = (view: TestPanel, text: string): ReturnType<TestPanel['find']> => inside(view, 'Button').find((element) => element.text === text) ?? null

const aliasEdits = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .map((params) => params as { name: string; input?: unknown })
    .filter((params) => params.name === 'forms.edit')
    .map((params) => params.input)

describe('the Aliases group', () => {
  test('is closed with the number of aliases, and draws each row, the struck removal and what is not shown', async () => {
    const view = await mountOn(connected, formsRead)
    const group = view.find({ type: 'Collapsible', label: 'Aliases' })
    assert.equal(group?.props.defaultOpen === true, false)
    assert.equal(group?.props.description, '102 aliases')
    await view.toggle({ type: 'Collapsible', label: 'Aliases' })
    const texts = inside(view, 'Text').map((element) => element.text)
    assert.ok(texts.includes('Alias: @fast'))
    // The removed name is struck through, and says so in words.
    assert.ok(texts.includes('Alias: @̶o̶l̶d̶ (removed on Save)'))
    assert.ok(texts.includes('Alias @broken: Unreadable'))
    assert.ok(texts.includes('2 more aliases are not shown. Edit them in config.yaml.'))
    assert.equal(view.find({ type: 'Select', label: '@fast provider' })?.props.value, 'claude')
    assert.equal(view.find({ type: 'Input', label: '@fast model' })?.props.value, 'haiku')
    assert.equal(button(view, 'Remove @fast')?.disabled, false)
    assert.equal(button(view, 'Undo removing @old')?.disabled, false)
    assert.equal(button(view, 'Add alias')?.disabled, true)
    assert.equal(button(view, 'Save')?.disabled, false)
    clean(view)
  })

  test('Remove, Undo and Add alias send their edits', async () => {
    const addable: FormsView = {
      ...formsRead,
      aliases: { ...aliasesRead, fields: aliasesRead.fields.map((one) => (one.kind === 'button' && one.id === 'add' ? { ...one, disabled: false } : one)) }
    }
    const view = await mountOn(connected, addable)
    await view.toggle({ type: 'Collapsible', label: 'Aliases' })
    for (const text of ['Remove @fast', 'Undo removing @old', 'Add alias']) {
      await view.press(button(view, text) ?? { text })
      await view.settled()
    }
    assert.deepEqual(aliasEdits(view), [
      { group: 'aliases', edits: { 'saved:@fast:remove': 'remove' } },
      { group: 'aliases', edits: { 'saved:@old:remove': 'undo' } },
      { group: 'aliases', edits: { add: 'add' } }
    ])
    clean(view)
  })

  test('in Searching every button of the group is disabled', async () => {
    const view = await mountOn(searching, formsRead)
    await view.toggle({ type: 'Collapsible', label: 'Aliases' })
    const buttons = inside(view, 'Button')
    assert.ok(buttons.length > 0)
    assert.deepEqual(
      buttons.map((one) => [one.text, one.disabled]),
      buttons.map((one) => [one.text, true])
    )
    clean(view)
  })
})
