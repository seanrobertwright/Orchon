// The frame seam for the Workflows section: src/panel.tsx mounted on a scripted worker that answers
// the Workflows requests, the scope and the runs table. These tests cover what the section draws
// and which requests it sends.
import { afterEach, assert, describe, mockHost, mount, test, type MountOptions, type TestPanel } from 'orca/testing'
import { connected, notRunning, searching } from '../scripts/connection-samples.ts'
import { unmatchedGit } from '../scripts/scope-samples.ts'
import { answeringWorkflows, manyWorkflows, unscopedWorkflows, webWorkflows, type WorkflowsScript } from '../scripts/workflows-samples.ts'
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

  test('asks inline, naming the file and saying there is no undo, and sends the project once on confirmation', async () => {
    const view = await mountWorkflows({ workflows: () => webWorkflows })
    await view.press(deleteButton('ship-it'))
    assert.deepEqual(sent(view, 'workflows.delete'), [])
    const ask = view.find({ type: 'Callout', text: /^Delete ship-it\?/ })
    assert.equal(ask?.text.includes('This deletes the file C:/Projects/web/.archon/workflows/ship-it.yaml. There is no undo.'), true)
    await view.press({ type: 'Button', text: 'Cancel' })
    assert.equal(view.find({ type: 'Callout', text: /^Delete ship-it\?/ }), null)
    await view.press(deleteButton('ship-it'))
    // The confirmation's own Delete, which replaced the row's.
    await view.press(deleteButton('ship-it'))
    assert.deepEqual(sent(view, 'workflows.delete'), [{ name: 'ship-it', codebaseId: 'cb-web' }])
    assert.ok(view.find(text('Deleted ship-it.')))
    clean(view)
  })

  test("a global workflow's file is named in Archon's home folder, and a refusal is said in the worker's words", async () => {
    const view = await mountWorkflows({
      workflows: () => webWorkflows,
      remove: (input) => ({ kind: 'failed', name: input.name, message: 'Workflow not found: tidy' })
    })
    await view.press(deleteButton('tidy'))
    const ask = view.find({ type: 'Callout', text: /^Delete tidy\?/ })
    assert.equal(ask?.text.includes("This deletes the file tidy.yaml in the workflows folder of Archon's home folder. There is no undo."), true)
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
