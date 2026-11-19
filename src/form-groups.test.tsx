// The frame seam for the panel: src/panel.tsx mounted on a scripted worker. These tests cover the
// editable groups of the Settings section, Defaults and Model tiers: what is drawn from the
// worker's view model, and which requests a person's actions send.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answering, connected, searching, systemRead } from '../scripts/connection-samples.ts'
import { formsRead, formsUnread, formsWithEdits } from '../scripts/forms-samples.ts'
import type { ConnectionView } from './connection-view'
import { EMPTY_CHOICE, TYPING_PAUSE_MS } from './form-groups'
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

/** Opens a closed group, as a person does. */
async function open(view: TestPanel, title: string): Promise<void> {
  await view.toggle({ type: 'Collapsible', label: title })
}

/** The elements of a type drawn inside a group. */
function inside(view: TestPanel, title: string, type: string): ReturnType<TestPanel['findAll']> {
  const group = view.find({ type: 'Collapsible', label: title })
  assert.ok(group, `no ${title} group`)
  return view.findAll({ type }).filter((element) => element.path.startsWith(`${group.path}/`))
}

/** The forms requests sent, with their inputs. */
const formsRequests = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .map((params) => params as { name: string; input?: unknown })
    .filter((params) => params.name.startsWith('forms.'))
    .map((params) => (params.input === undefined ? params.name : [params.name, params.input]))

const button = (view: TestPanel, title: string, text: string): ReturnType<TestPanel['find']> =>
  inside(view, title, 'Button').find((element) => element.text === text) ?? null

describe('the editable groups', () => {
  test('are closed, with a one-line summary each', async () => {
    const view = await mountOn(connected, formsRead)
    const groups = view.findAll({ type: 'Collapsible' }).filter((group) => group.label === 'Defaults' || group.label === 'Model tiers')
    assert.deepEqual(
      groups.map((group) => [group.label, group.props.defaultOpen === true, group.props.description]),
      [
        ['Defaults', false, 'Claude (Anthropic), model Inherit'],
        ['Model tiers', false, 'Small claude/haiku, medium claude/sonnet, large claude/opus']
      ]
    )
    clean(view)
  })

  test('Defaults stacks one labelled field per line, with Save and Discard off while nothing changed', async () => {
    const view = await mountOn(connected, formsRead)
    await open(view, 'Defaults')
    assert.deepEqual(
      inside(view, 'Defaults', 'Field').map((field) => field.label),
      ['Default assistant', 'OpenCode (community) model', 'Claude (Anthropic) model']
    )
    const assistant = view.find({ type: 'Select', label: 'Default assistant' })
    assert.equal(assistant?.props.value, 'claude')
    const model = view.find({ type: 'Input', label: 'Claude (Anthropic) model' })
    assert.equal(model?.props.placeholder, 'Inherit')
    assert.equal(model?.props.maxLength, 200)
    assert.equal(button(view, 'Defaults', 'Save')?.disabled, true)
    assert.equal(button(view, 'Defaults', 'Discard')?.disabled, true)
    clean(view)
  })

  test('Model tiers shows an unreadable preset by its key, with no fields', async () => {
    const view = await mountOn(connected, formsRead)
    await open(view, 'Model tiers')
    assert.ok(view.find({ type: 'Text', text: 'Medium tier: Unreadable' }))
    assert.equal(view.find({ type: 'Select', label: 'Medium provider' }), null)
    assert.equal(view.find({ type: 'Input', label: 'Large model' })?.props.placeholder, 'No built-in default')
    assert.equal(view.find({ type: 'Select', label: 'Small effort' })?.props.value, EMPTY_CHOICE)
    clean(view)
  })

  test('says "Unsaved changes", shows a failed check on its field and Archon\'s message under the group', async () => {
    const view = await mountOn(connected, formsWithEdits)
    assert.equal(view.find({ type: 'Collapsible', label: 'Defaults' })?.props.description, 'Unsaved changes')
    await open(view, 'Defaults')
    const field = inside(view, 'Defaults', 'Field').find((one) => one.label === 'Claude (Anthropic) model')
    assert.equal(field?.props.error, 'A saved value can be replaced here but not removed. Edit config.yaml to remove it.')
    assert.equal(view.find({ type: 'Input', label: 'Claude (Anthropic) model' })?.props.invalid, true)
    const notice = inside(view, 'Defaults', 'Callout')
    assert.equal(notice.length, 1)
    assert.equal(notice[0]?.props.tone, 'danger')
    assert.match(notice[0]?.text ?? '', /Unknown provider: 'nope'/)
    assert.equal(button(view, 'Defaults', 'Save')?.disabled, false)
    clean(view)
  })

  test('a choice is sent at once, and Save and Discard send their requests', async () => {
    const view = await mountOn(connected, formsWithEdits)
    await open(view, 'Defaults')
    await view.select({ type: 'Select', label: 'Default assistant' }, 'opencode')
    await view.select({ type: 'Select', label: 'Default assistant' }, EMPTY_CHOICE)
    await view.press(button(view, 'Defaults', 'Save') ?? { text: 'Save' })
    await view.press(button(view, 'Defaults', 'Discard') ?? { text: 'Discard' })
    await view.settled()
    assert.deepEqual(formsRequests(view), [
      'forms.read',
      ['forms.edit', { group: 'defaults', edits: { assistant: 'opencode' } }],
      ['forms.edit', { group: 'defaults', edits: { assistant: '' } }],
      ['forms.save', { group: 'defaults' }],
      ['forms.discard', { group: 'defaults' }]
    ])
    clean(view)
  })

  test('typed text is sent after a pause, or at once when Save is pressed', async () => {
    const view = await mountOn(connected, formsWithEdits)
    await open(view, 'Defaults')
    await view.type({ type: 'Input', label: 'Claude (Anthropic) model' }, 'abc')
    // Nothing yet: the pause has not passed.
    assert.deepEqual(formsRequests(view), ['forms.read'])
    await new Promise((resolve) => setTimeout(resolve, TYPING_PAUSE_MS + 100))
    await view.settled()
    assert.deepEqual(formsRequests(view), ['forms.read', ['forms.edit', { group: 'defaults', edits: { 'model:claude': 'abc' } }]])
    await view.type({ type: 'Input', label: 'OpenCode (community) model' }, 'x')
    await view.press(button(view, 'Defaults', 'Save') ?? { text: 'Save' })
    await view.settled()
    assert.deepEqual(formsRequests(view).slice(2), [
      ['forms.edit', { group: 'defaults', edits: { 'model:opencode': 'x' } }],
      ['forms.save', { group: 'defaults' }]
    ])
    clean(view)
  })

  test('a save stopped by an outside change offers load, overwrite or keep editing', async () => {
    const view = await mountOn(connected, formsWithEdits)
    await open(view, 'Model tiers')
    const callout = inside(view, 'Model tiers', 'Callout')[0]
    assert.match(callout?.text ?? '', /changed elsewhere since this group loaded: Small tier\. Nothing was saved\./)
    for (const [text, choice] of [
      ['Load saved values', 'load'],
      ['Overwrite', 'overwrite'],
      ['Keep editing', 'keep']
    ] as const) {
      await view.press(button(view, 'Model tiers', text) ?? { text })
      await view.settled()
      assert.deepEqual(formsRequests(view).at(-1), ['forms.resolve', { group: 'tiers', choice }])
    }
    clean(view)
  })

  test('in Searching every field, Save and Discard are disabled, and the edits are kept', async () => {
    const view = await mountOn(searching, formsWithEdits)
    await open(view, 'Defaults')
    for (const type of ['Select', 'Input']) {
      const controls = inside(view, 'Defaults', type)
      assert.ok(controls.length > 0)
      assert.deepEqual(
        controls.map((control) => control.disabled),
        controls.map(() => true),
        type
      )
    }
    assert.equal(button(view, 'Defaults', 'Save')?.disabled, true)
    assert.equal(button(view, 'Defaults', 'Discard')?.disabled, true)
    assert.equal(view.find({ type: 'Collapsible', label: 'Defaults' })?.props.description, 'Unsaved changes')
    clean(view)
  })

  test('reads the groups on opening the section and on Refresh, and a posted view replaces the one shown', async () => {
    const view = await mountOn(connected, formsUnread)
    assert.deepEqual(formsRequests(view), ['forms.read'])
    await view.press({ type: 'Button', text: 'Refresh' })
    assert.deepEqual(formsRequests(view), ['forms.read', 'forms.read'])
    await view.post('forms.changed', { ...formsRead, since: 100 })
    assert.equal(view.find({ type: 'Collapsible', label: 'Defaults' })?.props.description, 'Claude (Anthropic), model Inherit')
    // An older view arriving late changes nothing.
    await view.post('forms.changed', { ...formsWithEdits, since: 50 })
    assert.equal(view.find({ type: 'Collapsible', label: 'Defaults' })?.props.description, 'Claude (Anthropic), model Inherit')
    clean(view)
  })

  test('a failed first read shows the error in the group with "Try again"', async () => {
    const view = await mountOn(connected, { ...formsUnread, failure: 'Archon did not answer within 10 seconds.' })
    await open(view, 'Defaults')
    const callout = inside(view, 'Defaults', 'Callout')[0]
    assert.match(callout?.text ?? '', /^Archon did not answer within 10 seconds\./)
    await view.press(button(view, 'Defaults', 'Try again') ?? { text: 'Try again' })
    assert.equal(formsRequests(view).at(-1), 'forms.read')
    clean(view)
  })
})
