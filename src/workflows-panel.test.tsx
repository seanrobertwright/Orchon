// The frame seam for the Workflows section: src/panel.tsx mounted on a scripted worker that answers
// the Workflows requests, the scope and the runs table. These tests cover what the section draws
// and which requests it sends.
import { afterEach, assert, describe, mockHost, mount, test, type MountOptions, type TestPanel } from 'orca/testing'
import { connected, notRunning, searching } from '../scripts/connection-samples.ts'
import { unmatchedGit } from '../scripts/scope-samples.ts'
import { answeringWorkflows, draftedWorkflows, manyWorkflows, unscopedWorkflows, webWorkflows, type WorkflowsScript } from '../scripts/workflows-samples.ts'
import type { WorkflowsRequest } from './workflows-section-view'
import * as panelModule from './panel'
import { NO_PROJECT, SEARCH_PAUSE_MS } from './workflows-panel'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const PROJECT = { type: 'Select', label: 'Project' }

async function mountWorkflows(script: WorkflowsScript, options: MountOptions = {}): Promise<TestPanel> {
  panel = await mount(panelModule, { host: mockHost(answeringWorkflows(script)), persisted: { workspace: { section: 'workflows' } }, ...options })
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

const text = (value: string): { type: string; text: string } => ({ type: 'Text', text: value })

describe('the workflows list', () => {
  test("opens on the panel's project, reads Archon again, and draws each workflow's name, description and source", async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    assert.deepEqual(sent(view, 'workflows.read')[0], { project: 'cb-web', reload: true })
    assert.equal(view.valueOf(PROJECT), 'cb-web')
    for (const [name, description, source] of [
      ['ship-it', 'Ships the web app.', 'project'],
      ['tidy', 'Tidies every repository.', 'global'],
      ['deliver', 'Delivers one change, end to end.', 'bundled'],
      ['acme/pack:review', 'Reviews from a pack.', 'installed']
    ] as const) {
      assert.ok(view.find(text(name)), name)
      assert.ok(view.find(text(description)), description)
      assert.ok(view.find(text(`Source: ${source}`)), source)
    }
    clean(view)
  })

  test('chooses no project in an unmatched workspace, and still lists global and bundled workflows', async () => {
    const view = await mountWorkflows({ workflows: (request: WorkflowsRequest) => (request.project === undefined ? unscopedWorkflows : webWorkflows), scope: () => unmatchedGit })
    assert.deepEqual(sent(view, 'workflows.read')[0], { reload: true })
    assert.equal(view.valueOf(PROJECT), NO_PROJECT)
    assert.ok(view.find(text('tidy')))
    assert.ok(view.find(text('deliver')))
    assert.equal(view.find(text('ship-it')), null)
    clean(view)
  })

  test('its own project select reads the chosen project, and "No project" reads none', async () => {
    const view = await mountWorkflows({ workflows: (request: WorkflowsRequest) => (request.project === undefined ? unscopedWorkflows : webWorkflows) })
    await view.select(PROJECT, 'cb-api')
    assert.deepEqual(sent(view, 'workflows.read').at(-1), { project: 'cb-api' })
    await view.select(PROJECT, NO_PROJECT)
    assert.deepEqual(sent(view, 'workflows.read').at(-1), {})
    clean(view)
  })

  test('"Open in Archon console" opens the console\'s workflow builder page from the confirmed base URL', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    await view.press({ type: 'Link', text: 'Open in Archon console' })
    assert.deepEqual(view.host.callsOf('shell.openExternal'), [{ url: `${connected.baseUrl}/console/builder` }])
    clean(view)
  })
})

const deleteButton = (name: string): { type: string; text: string } => ({ type: 'Button', text: `Delete ${name}` })

describe('Delete', () => {
  test('is offered for project and global workflows only', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    assert.ok(view.find(deleteButton('ship-it')))
    assert.ok(view.find(deleteButton('tidy')))
    assert.equal(view.find(deleteButton('deliver')), null)
    assert.equal(view.find(deleteButton('acme/pack:review')), null)
    clean(view)
  })

  test('asks inline, naming the files and saying there is no undo, and sends the project once on confirmation', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    await view.press(deleteButton('ship-it'))
    assert.deepEqual(sent(view, 'workflows.delete'), [])
    const ask = view.find({ type: 'Callout', text: /^Delete ship-it\?/ })
    assert.equal(ask?.text.includes('In C:/Projects/web/.archon/workflows this deletes the folder ship-it and everything in it, or, when there is no such folder, the files ship-it.yaml and ship-it.yml. There is no undo.'), true)
    await view.press({ type: 'Button', text: 'Cancel' })
    assert.equal(view.find({ type: 'Callout', text: /^Delete ship-it\?/ }), null)
    await view.press(deleteButton('ship-it'))
    // The confirmation's own Delete, which replaced the row's.
    await view.press(deleteButton('ship-it'))
    assert.deepEqual(sent(view, 'workflows.delete'), [{ name: 'ship-it', codebaseId: 'cb-web' }])
    assert.ok(view.find(text('Deleted ship-it.')))
    clean(view)
  })

  test("a global workflow's files are named in Archon's home folder, and a refusal is said in the worker's words", async () => {
    const view = await mountWorkflows({
      workflows: () => webWorkflows,
      remove: (input) => ({ kind: 'failed', name: input.name, message: 'Workflow not found: tidy' })
    })
    await view.press(deleteButton('tidy'))
    const ask = view.find({ type: 'Callout', text: /^Delete tidy\?/ })
    assert.equal(ask?.text.includes("In the workflows folder of Archon's home folder this deletes the folder tidy and everything in it, or, when there is no such folder, the files tidy.yaml and tidy.yml. There is no undo."), true)
    await view.press(deleteButton('tidy'))
    assert.ok(view.find({ type: 'Callout', text: /^tidy was not deleted/ }))
    assert.ok(view.find(text('Workflow not found: tidy')))
    clean(view)
  })

  test('in Searching the list stays under the banner with every Delete disabled', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    await view.press(deleteButton('ship-it'))
    await view.post('connection.changed', { ...searching, since: connected.since + 1 })
    assert.match(view.findAll({ type: 'Callout' }).find((found) => found.props.tone === 'warning')?.text ?? '', /Reconnecting/)
    assert.ok(view.find(text('ship-it')))
    for (const button of view.findAll({ type: 'Button' }).filter((found) => found.text.startsWith('Delete '))) assert.equal(button.disabled, true)
    assert.ok(view.findAll({ type: 'Button' }).some((found) => found.text === 'Delete tidy'))
  })
})

describe('the section around the list', () => {
  test('past 200 workflows says how many are shown and offers a search the worker answers', async () => {
    const view = await mountWorkflows({ workflows: () => manyWorkflows(250) })
    assert.ok(view.find(text('Showing 200 of 250 workflows. Search to narrow the list.')))
    await view.type({ type: 'Input', label: 'Search workflows' }, 'wf-24')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_PAUSE_MS + 100))
    assert.deepEqual(sent(view, 'workflows.read').at(-1), { project: 'cb-web', filter: 'wf-24' })
    clean(view)
  })

  test('says where the workflows are read from when the focused workspace is another folder', async () => {
    const view = await mountWorkflows({ workflows: () => ({ ...webWorkflows, readFrom: 'C:/Projects/web' }) })
    assert.ok(view.find(text('Workflows are read from C:/Projects/web')))
    clean(view)
  })

  test('shows the state screen in place of the list', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    await view.post('connection.changed', { ...notRunning, since: connected.since + 1 })
    assert.equal(view.find(text('ship-it')), null)
    assert.match(view.find({ type: 'EmptyState' })?.label ?? '', /^Archon is not running\./)
  })
})

const openButton = (name: string): { type: string; text: string } => ({ type: 'Button', text: `Open ${name} in builder` })
const NO_WORKSPACE = 'No workspace is focused in Orca. Wide tabs open in a workspace on this computer.'

describe('Open in builder', () => {
  test('is offered for every workflow, and opens it with the chosen project', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    for (const name of ['ship-it', 'tidy', 'deliver', 'acme/pack:review']) assert.equal(view.find(openButton(name))?.disabled, false, name)
    await view.press(openButton('deliver'))
    assert.deepEqual(sent(view, 'builder.open'), [{ name: 'deliver', codebaseId: 'cb-web', source: 'bundled' }])
    clean(view)
  })

  test('with no project, opens it with none', async () => {
    const view = await mountWorkflows({ workflows: () => unscopedWorkflows, scope: () => unmatchedGit })
    await view.press(openButton('tidy'))
    assert.deepEqual(sent(view, 'builder.open'), [{ name: 'tidy', codebaseId: null, source: 'global' }])
  })

  test('is disabled, with the reason the worker gives, when no local workspace is focused', async () => {
    const view = await mountWorkflows({ workflows: () => ({ ...webWorkflows, builderOff: NO_WORKSPACE }) })
    assert.equal(view.find(openButton('ship-it'))?.disabled, true)
    assert.ok(view.find(text(NO_WORKSPACE)))
    assert.equal(view.findAll(text(NO_WORKSPACE)).length, 1)
  })

  test('says why when the worker could not open the tab', async () => {
    const reason = 'Archon has no workflow named deliver here.'
    const view = await mountWorkflows({ workflows: () => webWorkflows, open: () => ({ opened: false, reason }) })
    await view.press(openButton('deliver'))
    assert.ok(view.find(text(reason)))
  })

  test('is disabled under the Searching banner', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    await view.post('connection.changed', { ...searching, since: connected.since + 1 })
    assert.equal(view.find(openButton('ship-it'))?.disabled, true)
  })

  test('under the Searching banner works only for a workflow that has a draft', async () => {
    const view = await mountWorkflows({ workflows: () => draftedWorkflows })
    await view.post('connection.changed', { ...searching, since: connected.since + 1 })
    assert.equal(view.find(openButton('ship-it'))?.disabled, false)
    assert.equal(view.find(openButton('my-flow'))?.disabled, false)
    assert.equal(view.find(openButton('tidy'))?.disabled, true)
    await view.press(openButton('ship-it'))
    assert.deepEqual(sent(view, 'builder.open'), [{ name: 'ship-it', codebaseId: 'cb-web', source: 'project' }])
  })
})

const NEW_WORKFLOW = { type: 'Button', text: 'New workflow' }
const NAME = { type: 'Input', label: 'Workflow name' }
const PLACE = { type: 'RadioGroup', label: 'Save the new workflow' }
const CREATE = { type: 'Button', text: 'Create and open' }
const REMOTE = 'This workspace is on another host. Orchon works with the Archon on this computer.'

describe('New workflow', () => {
  test('asks for a name and a place before any tab opens, then sends them once', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    assert.equal(view.find(NAME), null)
    await view.press(NEW_WORKFLOW)
    assert.deepEqual(sent(view, 'workflows.new'), [])
    assert.equal(view.valueOf(PLACE), 'project')
    await view.type(NAME, 'my-flow')
    await view.press(CREATE)
    assert.deepEqual(sent(view, 'workflows.new'), [{ name: 'my-flow', codebaseId: 'cb-web', place: 'project' }])
    assert.equal(view.find(NAME), null)
    clean(view)
  })

  test('can save the new workflow as global, and with no project offers only global', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    await view.press(NEW_WORKFLOW)
    await view.type(NAME, 'everywhere')
    await view.select(PLACE, 'global')
    await view.press(CREATE)
    assert.deepEqual(sent(view, 'workflows.new'), [{ name: 'everywhere', codebaseId: 'cb-web', place: 'global' }])
    await view.unmount()
    const unscoped = await mountWorkflows({ workflows: () => unscopedWorkflows, scope: () => unmatchedGit })
    await unscoped.press(NEW_WORKFLOW)
    assert.equal(unscoped.valueOf(PLACE), 'global')
    await unscoped.type(NAME, 'lone')
    await unscoped.press(CREATE)
    assert.deepEqual(sent(unscoped, 'workflows.new'), [{ name: 'lone', codebaseId: null, place: 'global' }])
  })

  test("keeps the form open under the worker's sentence when it refuses the name", async () => {
    const reason = 'A workflow named ship-it is already in use here. Choose another name.'
    const view = await mountWorkflows({ workflows: () => webWorkflows, create: () => ({ opened: false, reason }) })
    await view.press(NEW_WORKFLOW)
    await view.type(NAME, 'ship-it')
    await view.press(CREATE)
    assert.ok(view.find(text(reason)))
    assert.ok(view.find(NAME))
  })

  test('is disabled with the reason in a remote workspace, as Open in builder is', async () => {
    const view = await mountWorkflows({ workflows: () => ({ ...webWorkflows, builderOff: REMOTE }) })
    assert.equal(view.find(NEW_WORKFLOW)?.disabled, true)
    assert.equal(view.find(openButton('ship-it'))?.disabled, true)
    assert.equal(view.findAll(text(REMOTE)).length, 1)
  })
})

describe('the builder drafts in the section', () => {
  test('marks a workflow with a draft in words, lists the new workflows never saved, and says what is not shown', async () => {
    const view = await mountWorkflows({ workflows: () => draftedWorkflows })
    assert.equal(view.findAll(text('Draft with unsaved changes')).length, 1)
    assert.ok(view.find(text('New workflows not saved yet')))
    for (const [name, place] of [
      ['my-flow', 'This project'],
      ['wide', 'Global']
    ] as const) {
      assert.ok(view.find(text(name)), name)
      assert.ok(view.find(text(place)), place)
      assert.equal(view.find(openButton(name))?.disabled, false, name)
      assert.ok(view.find({ type: 'Button', text: `Discard ${name}` }), name)
    }
    assert.ok(view.find(text('1 new workflow of another project is not shown.')))
    assert.ok(view.find(text('1 builder draft could not be read, so Orchon deleted it.')))
    clean(view)
  })

  test('Open on a new workflow opens its tab from its draft', async () => {
    const view = await mountWorkflows({ workflows: () => draftedWorkflows })
    await view.press(openButton('wide'))
    assert.deepEqual(sent(view, 'builder.open'), [{ name: 'wide', codebaseId: null, source: 'global' }])
  })

  test('Discard asks first, and only then deletes the draft', async () => {
    const view = await mountWorkflows({ workflows: () => draftedWorkflows })
    await view.press({ type: 'Button', text: 'Discard my-flow' })
    assert.deepEqual(sent(view, 'builder.draft.discard'), [])
    assert.ok(view.find(text('Its draft is deleted, and Archon holds nothing of it, so nothing of it is left. There is no undo.')))
    await view.press({ type: 'Button', text: 'Discard my-flow for good' })
    assert.deepEqual(sent(view, 'builder.draft.discard'), [{ name: 'my-flow', codebaseId: 'cb-web', scope: 'project', storeId: 'store-a' }])
  })
})
