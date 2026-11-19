// The frame seam for the project scope: src/panel.tsx mounted on a scripted worker that answers
// the scope and the runs table. These tests cover the scope switch, the notices, Link, Register
// and Open in Orca: what the Runs section draws and which requests it sends.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected } from '../scripts/connection-samples.ts'
import { busyRuns } from '../scripts/runs-samples.ts'
import { answeringScope, linkedApi, matchedWeb, remote, unmatchedFolder, unmatchedGit } from '../scripts/scope-samples.ts'
import * as panelModule from './panel'
import type { RunsRequest, RunsView } from './runs-view'
import type { ScopeAnswer, ScopeView } from './scope-view'

const TABLE = { type: 'Table', label: 'Runs' }
const SCOPE = { type: 'RadioGroup', label: 'Scope' }

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const busy = (request: RunsRequest): RunsView => busyRuns(60, request)

async function mountWith(scope: () => ScopeView, options: { after?: () => ScopeAnswer; runs?: (request: RunsRequest) => RunsView } = {}): Promise<TestPanel> {
  panel = await mount(panelModule, { host: mockHost(answeringScope(scope, options.runs ?? busy, options.after === undefined ? {} : { after: options.after })) })
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

describe('the scope switch', () => {
  test('opens on "This project" with the Archon project\'s name when matched, and filters the runs by its id', async () => {
    const view = await mountWith(() => matchedWeb)
    const radio = view.find(SCOPE)
    assert.ok(radio)
    assert.deepEqual(radio.props.options, [
      { value: 'this', label: 'This project', description: 'acme/web' },
      { value: 'all', label: 'All projects' }
    ])
    assert.equal(view.valueOf(SCOPE), 'this')
    assert.deepEqual(sent(view, 'runs.read').at(-1), { status: 'all', rows: 25, codebaseId: 'cb-web' })
    // The Project column is only under "All projects".
    assert.ok(!view.columnsOf(TABLE, { width: 800 }).includes('project'))
    clean(view)
  })

  test('"All projects" reads every project\'s runs and adds the Project column from 480 px', async () => {
    const view = await mountWith(() => matchedWeb)
    await view.select(SCOPE, 'all')
    assert.equal(view.valueOf(SCOPE), 'all')
    assert.deepEqual(sent(view, 'runs.read').at(-1), { status: 'all', rows: 25 })
    assert.ok(view.columnsOf(TABLE, { width: 480 }).includes('project'))
    assert.ok(!view.columnsOf(TABLE, { width: 479 }).includes('project'))
    clean(view)
  })

  test('follows the focused workspace, and a manual flip sticks across a change of focus', async () => {
    let scope: ScopeView = matchedWeb
    const view = await mountWith(() => scope)
    scope = linkedApi
    await view.post('scope.changed', null)
    assert.equal(view.valueOf(SCOPE), 'this')
    assert.deepEqual(sent(view, 'runs.read').at(-1), { status: 'all', rows: 25, codebaseId: 'cb-api' })
    await view.select(SCOPE, 'all')
    scope = matchedWeb
    await view.post('scope.changed', null)
    assert.equal(view.valueOf(SCOPE), 'all')
    assert.deepEqual(sent(view, 'runs.read').at(-1), { status: 'all', rows: 25 })
    clean(view)
  })

  test('"This project" is disabled when unmatched, and the switch shows "All projects"', async () => {
    const view = await mountWith(() => unmatchedGit)
    const radio = view.find(SCOPE)
    assert.ok(radio)
    assert.deepEqual(radio.props.options, [
      { value: 'this', label: 'This project', disabled: true },
      { value: 'all', label: 'All projects' }
    ])
    assert.equal(view.valueOf(SCOPE), 'all')
    assert.deepEqual(sent(view, 'runs.read').at(-1), { status: 'all', rows: 25 })
    clean(view)
  })
})

const button = (text: string): { type: string; text: string } => ({ type: 'Button', text })

describe('the unmatched notice', () => {
  test('offers Link and Register, and registers nothing until Register is pressed on the exact folder', async () => {
    const view = await mountWith(() => unmatchedGit)
    assert.ok(view.find({ type: 'Text', text: 'This Orca project is not known to Archon.' }))
    await view.press(button('Register with Archon'))
    assert.ok(view.find({ type: 'Text', text: 'Register this folder with Archon?' }))
    assert.ok(view.find({ type: 'Code', text: 'C:/Projects/shop' }))
    assert.deepEqual(sent(view, 'scope.register'), [])
    await view.press(button('Register'))
    assert.deepEqual(sent(view, 'scope.register'), [{ folder: 'C:/Projects/shop' }])
    clean(view)
  })

  test('Cancel closes the confirmation and sends nothing', async () => {
    const view = await mountWith(() => unmatchedGit)
    await view.press(button('Register with Archon'))
    await view.press(button('Cancel'))
    assert.equal(view.find({ type: 'Code', text: 'C:/Projects/shop' }), null)
    assert.ok(view.find(button('Register with Archon')))
    assert.deepEqual(sent(view, 'scope.register'), [])
  })

  test('a folder that is not a Git repository gets Link only', async () => {
    const view = await mountWith(() => unmatchedFolder)
    assert.ok(view.find(button('Link to an existing Archon project')))
    assert.equal(view.find(button('Register with Archon')), null)
  })

  test('Link chooses a project in a labelled select and sends its id, then shows the linked project', async () => {
    let scope: ScopeView = unmatchedGit
    const view = await mountWith(() => scope, { after: () => ({ connection: connected, scope: linkedApi }) })
    await view.press(button('Link to an existing Archon project'))
    const select = view.find({ type: 'Select', label: 'Archon project' })
    assert.ok(select)
    assert.deepEqual(select.props.options, [
      { value: 'cb-api', label: 'acme/api' },
      { value: 'cb-web', label: 'acme/web' }
    ])
    assert.equal(view.find(button('Link'))?.disabled, true)
    await view.select({ type: 'Select', label: 'Archon project' }, 'cb-api')
    scope = linkedApi
    await view.press(button('Link'))
    assert.deepEqual(sent(view, 'scope.link'), [{ projectId: 'cb-api' }])
    assert.equal(view.valueOf(SCOPE), 'this')
    assert.ok(view.find({ type: 'Text', text: 'Linked by hand to acme/api.' }))
    assert.deepEqual(sent(view, 'runs.read').at(-1), { status: 'all', rows: 25, codebaseId: 'cb-api' })
    clean(view)
  })

  test('a link can be changed to another project or cleared', async () => {
    const view = await mountWith(() => linkedApi)
    await view.press(button('Change link'))
    assert.deepEqual(view.find({ type: 'Select', label: 'Archon project' })?.props.options, [{ value: 'cb-web', label: 'acme/web' }])
    await view.select({ type: 'Select', label: 'Archon project' }, 'cb-web')
    await view.press(button('Link'))
    assert.deepEqual(sent(view, 'scope.link'), [{ projectId: 'cb-web' }])
    await view.press(button('Clear link'))
    assert.deepEqual(sent(view, 'scope.unlink'), [null])
  })

  test('says how many projects the chooser does not show', async () => {
    const many: ScopeView = { kind: 'unmatched', choices: { projects: [{ id: 'a', name: 'a/a' }], more: 140, unreadable: 1 } }
    const view = await mountWith(() => many)
    await view.press(button('Link to an existing Archon project'))
    assert.ok(view.find({ type: 'Text', text: "140 more Archon projects are not shown. Open Archon's console to see every project." }))
    assert.ok(view.find({ type: 'Text', text: '1 Archon project could not be read and is not shown.' }))
  })

  test('a refused press says why', async () => {
    const view = await mountWith(() => unmatchedGit, {
      after: () => ({ connection: connected, scope: unmatchedGit, refused: 'Archon answered with an error (400).' })
    })
    await view.press(button('Register with Archon'))
    await view.press(button('Register'))
    assert.ok(view.find({ type: 'Callout', text: 'Archon answered with an error (400).' }))
  })
})

describe('a remote workspace', () => {
  test('opens on All projects with the notice, and offers no Link or Register', async () => {
    const view = await mountWith(() => remote)
    assert.equal(view.valueOf(SCOPE), 'all')
    assert.ok(view.find({ type: 'Callout', text: 'This workspace is on another host. Orchon works with the Archon on this computer.' }))
    assert.equal(view.find(button('Link to an existing Archon project')), null)
    assert.equal(view.find(button('Register with Archon')), null)
    assert.deepEqual(sent(view, 'runs.read').at(-1), { status: 'all', rows: 25 })
    clean(view)
  })
})

describe("the preview's worktree line", () => {
  const withWorkspace = (request: RunsRequest): RunsView => {
    const runs = busy(request)
    if (runs.kind !== 'ready') return runs
    return { ...runs, rows: runs.rows.map((run) => (run.id === 'run-0' ? { ...run, workspaceId: 'ws-run-0' } : run)) }
  }

  test('offers Open in Orca for a run whose worktree Orca lists, and asks the worker to open it', async () => {
    const view = await mountWith(() => matchedWeb, { runs: withWorkspace })
    await view.selectRows(TABLE, ['run-0'])
    await view.press(button('Open in Orca'))
    assert.deepEqual(sent(view, 'workspace.open'), [{ workspaceId: 'ws-run-0' }])
    clean(view)
  })

  test("otherwise shows the path as text with the hint about Orca's Non-Orca worktrees setting", async () => {
    const view = await mountWith(() => matchedWeb, { runs: withWorkspace })
    await view.selectRows(TABLE, ['run-1'])
    assert.equal(view.find(button('Open in Orca')), null)
    assert.ok(view.find({ type: 'Text', text: "Orca does not show this worktree. To open it in Orca, show it in the project's Non-Orca worktrees setting." }))
  })
})
