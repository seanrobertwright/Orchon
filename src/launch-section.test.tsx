// The frame seam for the Launch section: src/panel.tsx mounted on a scripted worker that answers
// the Launch requests, the scope and the runs table. These tests cover what the form, the
// Starting view and the callout draw, and which requests the panel sends.
import { afterEach, assert, describe, mockHost, mount, test, type MountOptions, type TestPanel } from 'orca/testing'
import { answeringLaunch, emptyForm, webForm, type LaunchScript } from '../scripts/launch-samples.ts'
import type { LaunchStart, LaunchView } from './launch-view'
import * as panelModule from './panel'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const SECTION_BAR = { label: 'Orchon sections' }
const PROJECT = { type: 'Select', label: 'Project' }
const WORKFLOW = { type: 'Select', label: 'Workflow' }
const MESSAGE = { type: 'Textarea', label: 'Message' }
const START = { type: 'Button', text: 'Start' }
const button = (text: string): { type: string; text: string } => ({ type: 'Button', text })

async function mountLaunch(script: LaunchScript, options: MountOptions = {}): Promise<TestPanel> {
  panel = await mount(panelModule, { host: mockHost(answeringLaunch(script)), persisted: { workspace: { section: 'launch' } }, ...options })
  return panel
}

/** Every request of one name the panel sent, by its input, in order. */
function sent(view: TestPanel, name: string): unknown[] {
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

const starting = (launch: Extract<LaunchView, { kind: 'ready' }>, fields: Partial<NonNullable<typeof launch.starting>> = {}): LaunchView => ({
  ...launch,
  starting: { launchId: 'launch-1', workflow: 'deliver', project: 'acme/web', state: 'started', late: false, ...fields }
})

describe('the launch form', () => {
  test("draws the project, the workflow with its description, the message and the line about files, and reads Archon again when it opens", async () => {
    const view = await mountLaunch({ launch: () => webForm })
    assert.equal(view.valueOf(PROJECT), 'cb-web')
    assert.deepEqual(view.find(PROJECT)?.props.options, [
      { value: 'cb-api', label: 'acme/api' },
      { value: 'cb-web', label: 'acme/web' }
    ])
    assert.equal(view.valueOf(WORKFLOW), 'deliver')
    assert.ok(view.find({ type: 'Text', text: 'Delivers one change, end to end.' }))
    assert.equal(view.find(MESSAGE)?.props.maxLength, 16_000)
    assert.ok(view.find({ type: 'Text', text: 'To attach a file, save it in the project and name its path in the message.' }))
    // The panel's project is the default, and opening the section reads the lists again.
    assert.deepEqual(sent(view, 'launch.read')[0], { project: 'cb-web', reload: true })
    clean(view)
  })

  test('Start is disabled with its reason until a message is typed, then sends the message as typed, once', async () => {
    let launch: LaunchView = webForm
    const view = await mountLaunch({
      launch: () => launch,
      start: (input: LaunchStart) => {
        launch = starting(webForm)
        return input.message === '' ? webForm : launch
      }
    })
    assert.equal(view.find(START)?.disabled, true)
    assert.ok(view.find({ type: 'Text', text: 'Type a message.' }))
    await view.type(MESSAGE, '  Ship the fix.  ')
    assert.equal(view.find(START)?.disabled, false)
    await view.press(START)
    assert.deepEqual(sent(view, 'launch.start'), [{ codebaseId: 'cb-web', workflow: 'deliver', message: '  Ship the fix.  ' }])
    // The Starting view replaces the form: the workflow, the project by name, a spinner and "Launch another".
    assert.equal(view.find(MESSAGE), null)
    assert.ok(view.find({ type: 'Text', text: 'deliver' }))
    assert.ok(view.find({ type: 'Text', text: 'acme/web' }))
    assert.ok(view.find({ type: 'Spinner' }))
    assert.ok(view.find(button('Launch another')))
    clean(view)
  })

  test('with no project or no workflow, Start says which is missing', async () => {
    const view = await mountLaunch({ launch: () => emptyForm })
    await view.type(MESSAGE, 'Hello')
    assert.equal(view.find(START)?.disabled, true)
    assert.ok(view.find({ type: 'Text', text: 'Choose a project.' }))
    assert.equal(view.valueOf(PROJECT), '')
    clean(view)
  })
})

describe('the section bar', () => {
  test('New run in the Runs filter row opens the Launch section', async () => {
    const view = await mountLaunch({ launch: () => webForm }, { persisted: { workspace: { section: 'runs' } } })
    await view.press(button('New run'))
    assert.equal(view.valueOf(SECTION_BAR), 'launch')
    assert.ok(view.find(MESSAGE))
    clean(view)
  })
})
