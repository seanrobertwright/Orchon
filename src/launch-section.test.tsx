// The frame seam for the Launch section: src/panel.tsx mounted on a scripted worker that answers
// the Launch requests, the scope and the runs table. These tests cover what the form, the
// Starting view and the callout draw, and which requests the panel sends.
import { afterEach, assert, describe, mockHost, mount, test, type MountOptions, type TestPanel } from 'orca/testing'
import { connected } from '../scripts/connection-samples.ts'
import { answeringLaunch, deliver, emptyForm, review, webForm, type LaunchScript } from '../scripts/launch-samples.ts'
import { sampleDetail } from '../scripts/runs-samples.ts'
import { remote, unmatchedGit } from '../scripts/scope-samples.ts'
import { LOOKING_TEXT, QUEUED_TEXT, type LaunchNotice, type LaunchStart, type LaunchView } from './launch-view'
import type { RunDetailAnswer } from './run-detail-view'
import { DRAFT_PAUSE_MS } from './launch-section'
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

describe('the draft', () => {
  test("the message goes to the worker's draft once typing pauses, not on every keystroke", async () => {
    const view = await mountLaunch({ launch: () => webForm })
    await view.type(MESSAGE, 'Half')
    await view.type(MESSAGE, ' a thought')
    assert.deepEqual(sent(view, 'launch.edit'), [])
    await new Promise((resolve) => setTimeout(resolve, DRAFT_PAUSE_MS + 100))
    await view.settled()
    assert.deepEqual(sent(view, 'launch.edit'), [{ message: 'Half a thought' }])
    clean(view)
  })

  test('choosing a project or a workflow changes the draft at once', async () => {
    const view = await mountLaunch({ launch: () => webForm })
    await view.select(PROJECT, 'cb-api')
    await view.select(WORKFLOW, 'review')
    assert.deepEqual(sent(view, 'launch.edit'), [{ codebaseId: 'cb-api' }, { workflow: 'review' }])
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

/** A host whose worker also answers run detail, for a found run that opens. */
function withRun(script: LaunchScript): ReturnType<typeof answeringLaunch> {
  const host = answeringLaunch(script)
  const run = (): RunDetailAnswer => ({ connection: connected, run: { kind: 'ready', detail: sampleDetail(1, { id: 'run-found' }) } })
  return { ...host, requests: { ...host.requests, 'run.read': run } }
}

describe('Start and its outcomes', () => {
  test('a second press while posting is ignored', async () => {
    const draft = { ...webForm, message: 'Go.' }
    /** What Start looked like while the worker held its answer. */
    let whilePosting: { disabled: boolean | undefined; reason: boolean } | undefined
    panel = await mount(panelModule, {
      host: mockHost({
        requests: {
          ...answeringLaunch({ launch: () => draft }).requests,
          // The worker holds the press's answer a moment, and the test looks at Start meanwhile.
          'launch.start': () =>
            new Promise((resolve) => {
              setTimeout(() => {
                whilePosting = { disabled: panel?.find(START)?.disabled, reason: panel?.find({ type: 'Text', text: 'Starting…' }) !== null }
                resolve({ connection: connected, launch: starting(webForm), notices: [] })
              }, 20)
            })
        }
      }),
      persisted: { workspace: { section: 'launch' } }
    })
    await panel.press(START)
    assert.deepEqual(whilePosting, { disabled: true, reason: true })
    assert.equal(sent(panel, 'launch.start').length, 1)
    clean(panel)
  })

  test("a 400 shows on the form in Archon's words, with every value kept", async () => {
    const view = await mountLaunch({
      launch: () => webForm,
      start: (input) => ({ ...webForm, workflow: input.workflow, message: input.message, error: 'message must be a non-empty string' })
    })
    await view.select(WORKFLOW, 'review')
    await view.type(MESSAGE, 'Look at it.')
    await view.press(START)
    assert.ok(view.find({ type: 'Text', text: 'message must be a non-empty string' }))
    assert.equal(view.valueOf(MESSAGE), 'Look at it.')
    assert.equal(view.valueOf(PROJECT), 'cb-web')
    clean(view)
  })

  test('the Starting view says a queued launch waits for a slot, and a timed out one that the worker is looking for the run', async () => {
    for (const [state, words] of [
      ['queued', QUEUED_TEXT],
      ['looking', LOOKING_TEXT]
    ] as const) {
      const view = await mountLaunch({ launch: () => starting(webForm, { state }) })
      assert.equal(view.find({ type: 'Spinner' })?.label, words)
      clean(view)
      await view.unmount()
    }
  })

  test('with no run after 60 seconds it offers "Keep waiting" and "Launch another"', async () => {
    let launch = starting(webForm, { late: true })
    const view = await mountLaunch({ launch: () => launch })
    assert.ok(view.find({ type: 'Text', text: 'Archon has not shown the run after a minute.' }))
    await view.press(button('Keep waiting'))
    assert.deepEqual(sent(view, 'launch.wait'), [{ launchId: 'launch-1' }])
    launch = webForm
    await view.press(button('Launch another'))
    assert.deepEqual(sent(view, 'launch.another'), [null])
    assert.ok(view.find(MESSAGE))
    clean(view)
  })

  test('a run found while the Starting view shows opens its detail, with no callout', async () => {
    let launch = starting(webForm)
    let notices: LaunchNotice[] = []
    panel = await mount(panelModule, {
      host: mockHost(withRun({ launch: () => launch, notices: () => notices })),
      persisted: { workspace: { section: 'launch' } }
    })
    launch = starting(webForm, { state: 'found', runId: 'run-found' })
    notices = [{ launchId: 'launch-1', workflow: 'deliver', runId: 'run-found' }]
    await panel.post('launch.changed', null)
    assert.equal(panel.valueOf(SECTION_BAR), 'runs')
    assert.deepEqual(sent(panel, 'run.read').at(-1), { runId: 'run-found', open: true })
    assert.deepEqual(sent(panel, 'launch.dismiss'), [{ launchId: 'launch-1' }])
    assert.equal(panel.find({ type: 'Callout', text: /Your run of/ }), null)
    clean(panel)
  })

  test('a run found after the Starting view stopped showing is an info callout at the top, with Open run and dismiss', async () => {
    let notices: LaunchNotice[] = []
    panel = await mount(panelModule, {
      host: mockHost(withRun({ launch: () => starting(webForm), notices: () => notices })),
      persisted: { workspace: { section: 'runs' } }
    })
    notices = [{ launchId: 'launch-1', workflow: 'deliver', runId: 'run-found' }]
    await panel.post('launch.changed', null)
    assert.ok(panel.find({ type: 'Callout', text: /Your run of deliver has started/ }))
    assert.ok(panel.find({ type: 'IconButton', label: 'Dismiss: your run of deliver has started' }))
    await panel.press(button('Open run'))
    assert.deepEqual(sent(panel, 'run.read').at(-1), { runId: 'run-found', open: true })
    assert.deepEqual(sent(panel, 'launch.dismiss'), [{ launchId: 'launch-1' }])
    clean(panel)
  })

  test('a panel that mounts again after a launch asks for the callouts', async () => {
    const notices = [{ launchId: 'launch-1', workflow: 'deliver', runId: 'run-found' }]
    panel = await mount(panelModule, {
      host: mockHost(withRun({ launch: () => webForm, notices: () => notices })),
      persisted: { workspace: { section: 'runs', 'launch-pending': true } }
    })
    assert.ok(panel.find({ type: 'Callout', text: /Your run of deliver has started/ }))
    await panel.press({ type: 'IconButton', label: 'Dismiss: your run of deliver has started' })
    assert.deepEqual(sent(panel, 'launch.dismiss'), [{ launchId: 'launch-1' }])
    clean(panel)
  })
})

describe('the project scope in the Launch section', () => {
  test('an unmatched workspace shows the notice with Link and Register, and the form with an empty project select', async () => {
    const view = await mountLaunch({ launch: () => emptyForm, scope: () => unmatchedGit })
    assert.ok(view.find(button('Link to an existing Archon project')))
    assert.ok(view.find(button('Register with Archon')))
    assert.equal(view.valueOf(PROJECT), '')
    assert.deepEqual(sent(view, 'launch.read')[0], { reload: true })
    clean(view)
  })

  test('a remote workspace has no launcher', async () => {
    const view = await mountLaunch({ launch: () => ({ kind: 'remote' }), scope: () => remote })
    assert.ok(view.find({ type: 'Callout', text: 'This workspace is on another host. Orchon works with the Archon on this computer.' }))
    assert.equal(view.find(PROJECT), null)
    assert.equal(view.find(START), null)
    clean(view)
  })
})

describe('the workflow select', () => {
  const many = Array.from({ length: 21 }, (_, index) => ({ ...review, name: `wf-${String(index).padStart(2, '0')}` }))

  test('lists recommended workflows as such, and shows a filter above 20 workflows that filters in the worker', async () => {
    const view = await mountLaunch({
      launch: () => ({ ...webForm, workflows: { kind: 'ready', rows: [deliver, ...many], total: 22, matching: 22, unreadable: 0 } })
    })
    assert.equal((view.find(WORKFLOW)?.props.options as { label: string }[])[0]?.label, 'deliver (recommended)')
    await view.type({ type: 'Input', label: 'Filter workflows' }, 'wf-1')
    // The filter is sent after a pause in typing.
    await new Promise((resolve) => setTimeout(resolve, DRAFT_PAUSE_MS + 100))
    await view.settled()
    assert.equal((sent(view, 'launch.read').at(-1) as { filter?: string }).filter, 'wf-1')
    clean(view)
  })

  test('with 20 workflows or fewer there is no filter', async () => {
    const view = await mountLaunch({ launch: () => webForm })
    assert.equal(view.find({ type: 'Input', label: 'Filter workflows' }), null)
    clean(view)
  })

  test('a workflow list too large to read says so and offers nothing to choose', async () => {
    const view = await mountLaunch({ launch: () => ({ ...webForm, workflows: { kind: 'too-large' }, workflow: null, description: '' }) })
    assert.ok(view.find({ type: 'Text', text: "Archon's workflow list for this project is too large to show." }))
    assert.equal(view.find(WORKFLOW), null)
    assert.equal(view.find(START)?.disabled, true)
    clean(view)
  })
})

describe('declared inputs on the form', () => {
  const withInputs: LaunchView = {
    ...webForm,
    fields: {
      kind: 'ready',
      rows: [
        { name: 'target', required: true, description: 'What to deliver.', placeholder: '' },
        { name: 'branch', required: false, description: 'The branch to open from.', placeholder: 'main' },
        { name: 'errors', required: false, description: '', placeholder: 'auto' },
        { name: 'ticket', required: true, description: '', placeholder: '' }
      ]
    }
  }
  const field = (name: string): { type: string; label: string } => ({ type: 'Input', label: name })
  /** Opens the group of optional inputs, as a person would. */
  const openOptional = async (view: TestPanel): Promise<void> => {
    const group = view.findAll({ type: 'Collapsible' }).find((element) => element.props.title === 'Optional inputs (2)')
    if (group === undefined) throw new Error('No group of optional inputs.')
    await view.toggle(group)
  }

  test('draws one field per input in declared order, required ones visible and optional ones in a collapsed group that says how many it holds', async () => {
    const view = await mountLaunch({ launch: () => withInputs })
    const required = view.findAll({ type: 'Field' }).map((element) => [element.props.label, element.props.required, element.props.description])
    assert.deepEqual(required.slice(0, 2), [
      ['target', true, 'What to deliver.'],
      ['ticket', true, undefined]
    ])
    const optional = view.find({ type: 'Collapsible' })
    assert.equal(optional?.props.title, 'Optional inputs (2)')
    assert.equal(view.find(field('branch')), null)
    await openOptional(view)
    assert.equal(view.find(field('branch'))?.props.placeholder, 'main')
    clean(view)
  })

  test('Start names the empty required inputs, and sends the filled values once they are typed', async () => {
    const view = await mountLaunch({ launch: () => ({ ...withInputs, message: 'Go.' }) })
    assert.equal(view.find(START)?.disabled, true)
    assert.ok(view.find({ type: 'Text', text: 'Fill in the required inputs: target, ticket.' }))
    await view.type(field('target'), 'the fix')
    assert.ok(view.find({ type: 'Text', text: 'Fill in the required input: ticket.' }))
    await view.type(field('ticket'), '  #12 ')
    await openOptional(view)
    await view.type(field('branch'), '   ')
    assert.equal(view.find(START)?.disabled, false)
    await view.press(START)
    assert.deepEqual(sent(view, 'launch.start'), [
      { codebaseId: 'cb-web', workflow: 'deliver', message: 'Go.', inputs: { target: 'the fix', ticket: '  #12 ', branch: '   ' } }
    ])
    clean(view)
  })

  test('typed values go to the draft after a pause, and a workflow that declares more than 50 inputs gets a notice and no Start', async () => {
    const view = await mountLaunch({ launch: () => withInputs })
    await view.type(field('target'), 'x')
    await new Promise((resolve) => setTimeout(resolve, DRAFT_PAUSE_MS + 100))
    await view.settled()
    assert.deepEqual(sent(view, 'launch.edit'), [{ inputs: { target: 'x' } }])
    await view.unmount()
    const many = await mountLaunch({ launch: () => ({ ...webForm, message: 'Go.', fields: { kind: 'too-many', declared: 51 } }) })
    assert.ok(many.find({ type: 'Text', text: 'This workflow declares 51 inputs, more than the 50 Orchon can fill in. Launch it from Archon.' }))
    assert.equal(many.find(START)?.disabled, true)
    clean(many)
  })
})

describe('model bindings on the form', () => {
  const NAME = (row: number): { type: string; label: string } => ({ type: 'Input', label: `Binding ${String(row)} name` })
  const MODEL = (row: number): { type: string; label: string } => ({ type: 'Input', label: `Binding ${String(row)} model` })

  test('a collapsed group reads "As authored" with no rows, takes up to 10 rows, and sends them with Start', async () => {
    const view = await mountLaunch({ launch: () => ({ ...webForm, message: 'Go.' }) })
    const group = view.find({ type: 'Collapsible' })
    assert.equal(group?.props.title, 'Model bindings')
    assert.equal(group?.props.description, 'As authored')
    if (group === null) throw new Error('No group of model bindings.')
    await view.toggle(group)
    await view.press(button('Add binding'))
    await view.type(NAME(1), 'tiny')
    await view.type(MODEL(1), 'haiku')
    assert.equal(view.find(START)?.disabled, true)
    assert.ok(view.find({ type: 'Text', text: 'A binding names a tier (small, medium or large) or an alias starting with @: tiny is neither.' }))
    await view.type(NAME(1), 'small', { replace: true })
    assert.equal(view.find({ type: 'Collapsible' })?.props.description, '1 binding')
    for (let row = 2; row <= 10; row += 1) await view.press(button('Add binding'))
    assert.equal(view.find(button('Add binding'))?.disabled, true)
    for (let row = 10; row >= 2; row -= 1) await view.press({ type: 'IconButton', label: `Remove binding ${String(row)}` })
    await view.press(START)
    assert.deepEqual(sent(view, 'launch.start'), [{ codebaseId: 'cb-web', workflow: 'deliver', message: 'Go.', bindings: [{ name: 'small', model: 'haiku' }] }])
    clean(view)
  })
})

describe('a launch Archon did not start', () => {
  test("shows Archon's reason as text, and Edit and try again asks for the form back", async () => {
    let launch: LaunchView = starting(webForm, { state: 'refused', reason: "Cannot run workflow 'deliver': <b>no</b>." })
    const view = await mountLaunch({ launch: () => launch })
    assert.ok(view.find({ type: 'Callout', text: /The run did not start/ }))
    assert.ok(view.find({ type: 'Text', text: "Cannot run workflow 'deliver': <b>no</b>." }))
    launch = { ...webForm, message: 'Again.' }
    await view.press(button('Edit and try again'))
    assert.deepEqual(sent(view, 'launch.retry'), [{ launchId: 'launch-1' }])
    assert.equal(view.valueOf(MESSAGE), 'Again.')
    clean(view)
  })

  test('an error frame reads "Archon could not start this run" with its text', async () => {
    const view = await mountLaunch({ launch: () => starting(webForm, { state: 'failed', reason: 'Failed to process message: boom.' }) })
    assert.ok(view.find({ type: 'Callout', text: /Archon could not start this run/ }))
    assert.ok(view.find({ type: 'Text', text: 'Failed to process message: boom.' }))
    assert.ok(view.find(button('Edit and try again')))
    clean(view)
  })

  test('leaving the Launch section tells the worker it no longer shows', async () => {
    const view = await mountLaunch({ launch: () => webForm })
    assert.deepEqual(sent(view, 'launch.hide'), [])
    await view.select(SECTION_BAR, 'runs')
    assert.deepEqual(sent(view, 'launch.hide'), [null])
    clean(view)
  })
})
