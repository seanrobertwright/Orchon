// The frame seam for the project scope: src/panel.tsx mounted on a scripted worker that answers
// the scope and the runs table. These tests cover the scope switch, the notices, Link, Register
// and Open in Orca: what the Runs section draws and which requests it sends.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
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
