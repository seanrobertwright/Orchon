// The worker's request protocol seam for the Workflows section: the worker mounted on a scripted
// Archon that replays the recorded fixtures, and a stand-in Orca host that answers the workspace
// methods. These tests cover the section's list, its project select, and Delete.
import { assert, describe, test, type MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, HANG, health, json, recorded, RELEASES, scene, type MountedScene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import { DELETE_TIMED_OUT, NOT_DELETABLE, type DeleteAnswer, type WorkflowDelete, type WorkflowsAnswer, type WorkflowsSectionView } from './workflows-section-view'

const CODEBASES = `${DEFAULT}/api/codebases`
const WORKFLOWS = `${DEFAULT}/api/workflows`

/** The id of the one project each release's recording holds. Read off the fixtures by hand. */
const RECORDED_ID: Record<Release, string> = {
  '0.12.1': 'cd8c6f17a56a08ff6e8c24143751f5c4',
  '0.13.2': '6feec5b110ac5147f1d58ffa49d2790c',
  '0.14.0': '4fb57f7e8043f7efd57270977e68c598'
}
/** The recorded project's folder as the recordings scrubbed it. */
const RECORDED_CWD = '<project-path>'
const ECHO = 'orchon-recorder-echo'

const workflowsUrl = (cwd: string): string => `${WORKFLOWS}?${new URLSearchParams({ cwd }).toString()}`

type Row = { id: string; kind: 'worktree' | 'folder'; name: string; projectId: string | null; path: string; branch: string | null; hostId: string | null }
const local: Row = { id: 'ws-local', kind: 'folder', name: 'web', projectId: null, path: 'C:/Projects/web', branch: null, hostId: 'local' }
const sshRow: Row = { id: 'ws-ssh', kind: 'folder', name: 'box', projectId: null, path: '/srv/web', branch: null, hostId: 'ssh:box' }

/** The host with one focused workspace. */
function orcaWith(focused: string | null): MockHostOptions {
  return {
    storage: {},
    results: {
      'workspace.readContext': focused === null ? null : { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] },
      'workspace.list': { workspaces: [local, sshRow], truncated: false }
    }
  }
}

/** A connected scene listing the recorded project and its recorded workflows. */
function workflowsScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  stage.archon.answer(workflowsUrl(RECORDED_CWD), recorded(release, 'workflows'))
  // With no `cwd` Archon falls back to its first project's folder, so the recorded answer, with
  // its project rows, stands for what it lists then.
  stage.archon.answer(WORKFLOWS, recorded(release, 'workflows'))
  return stage
}

const ready = (view: WorkflowsSectionView): Extract<WorkflowsSectionView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The section is ${view.kind}.`)
  return view
}

const listOf = (view: WorkflowsSectionView) => {
  const list = ready(view).list
  if (list.kind !== 'ready') throw new Error(`The list is ${list.kind}.`)
  return list
}

/** The recorded answer of a release with its body changed, as an Archon in another state answers. */
function changed(release: Release, scenario: string, index: number, change: (body: unknown) => unknown) {
  const answer = recorded(release, scenario, index)
  if (answer.kind !== 'json') throw new Error(`fixtures/${release}/${scenario}.json is not JSON.`)
  return json(change(answer.value), answer.status)
}

/** The recorded list with its first row repeated under `count` names, as an install with that many. */
const manyWorkflows = (count: number) =>
  changed('0.12.1', 'workflows', 0, (body) => {
    const { workflows } = body as { workflows: { workflow: Record<string, unknown>; source: string }[] }
    const first = workflows[0]
    if (first === undefined) throw new Error('The recorded list is empty.')
    return {
      workflows: Array.from({ length: count }, (_, index) => ({ ...first, workflow: { ...first.workflow, name: `wf-${String(index).padStart(3, '0')}` } })),
      recommended: []
    }
  })

async function read(mounted: MountedScene, input: Record<string, unknown> = {}): Promise<WorkflowsAnswer> {
  return (await mounted.worker.request('workflows.read', input)) as WorkflowsAnswer
}

describe('the workflows list', () => {
  for (const release of RELEASES) {
    test(`with a project, lists the recorded workflows of ${release} by name with their source, read from its default_cwd, with no node definitions`, async () => {
      const stage = workflowsScene(release)
      const mounted = await stage.mount(orcaWith('ws-local'))
      const answer = await read(mounted, { project: RECORDED_ID[release], reload: true })
      const view = ready(answer.workflows)
      assert.equal(view.codebaseId, RECORDED_ID[release])
      assert.equal(view.folder, RECORDED_CWD)
      assert.ok(stage.archon.calls.some((call) => call.url === workflowsUrl(RECORDED_CWD)))
      const list = listOf(answer.workflows)
      const echo = list.rows.find((row) => row.name === ECHO)
      assert.deepEqual(echo && { source: echo.source, deletable: echo.deletable }, { source: 'project', deletable: true })
      assert.ok(list.rows.some((row) => row.source === 'bundled' && !row.deletable))
      assert.deepEqual(Object.keys(list.rows[0] ?? {}).sort(), ['deletable', 'description', 'name', 'source'])
      const names = list.rows.map((row) => row.name)
      assert.deepEqual(names, [...names].sort((first, second) => first.localeCompare(second)))
      assert.equal(list.total, list.rows.length)
      assert.ok(!JSON.stringify(answer).includes('"nodes"'))
      assert.equal(stage.archon.calls.filter((call) => call.method !== 'GET').length, 0)
      await mounted.worker.deactivate()
    })
  }

  test('with no project, reads the list with no cwd and lists only what is not a project workflow', async () => {
    const stage = workflowsScene()
    const mounted = await stage.mount(orcaWith(null))
    const view = ready((await read(mounted, { reload: true })).workflows)
    assert.equal(view.codebaseId, null)
    assert.equal(view.folder, null)
    assert.ok(stage.archon.calls.some((call) => call.url === WORKFLOWS))
    const list = listOf(view)
    assert.ok(list.rows.length > 0)
    assert.ok(list.rows.every((row) => row.source !== 'project'))
    assert.ok(!list.rows.some((row) => row.name === ECHO))
    await mounted.worker.deactivate()
  })
})

describe('a long list', () => {
  test('lists the first 200 by name, says how many there are, and searches in the worker by name or description', async () => {
    const stage = workflowsScene()
    stage.archon.answer(workflowsUrl(RECORDED_CWD), manyWorkflows(250))
    const mounted = await stage.mount(orcaWith('ws-local'))
    const list = listOf((await read(mounted, { project: RECORDED_ID['0.12.1'], reload: true })).workflows)
    assert.equal(list.rows.length, 200)
    assert.equal(list.total, 250)
    assert.equal(list.matching, 250)
    assert.equal(list.rows[0]?.name, 'wf-000')
    assert.equal(list.rows.at(-1)?.name, 'wf-199')
    const searched = listOf((await read(mounted, { project: RECORDED_ID['0.12.1'], filter: 'WF-24' })).workflows)
    assert.deepEqual(
      searched.rows.map((row) => row.name),
      ['wf-240', 'wf-241', 'wf-242', 'wf-243', 'wf-244', 'wf-245', 'wf-246', 'wf-247', 'wf-248', 'wf-249']
    )
    assert.equal(searched.total, 250)
    assert.equal(searched.matching, 10)
    // The search is answered from the kept list: Archon is read once.
    assert.equal(stage.archon.calls.filter((call) => call.url === workflowsUrl(RECORDED_CWD)).length, 1)
    await mounted.worker.deactivate()
  })
})

describe('where the workflows are read from', () => {
  test("names the project's default_cwd when the focused workspace is another folder", async () => {
    const mounted = await workflowsScene().mount(orcaWith('ws-local'))
    assert.equal(ready((await read(mounted, { project: RECORDED_ID['0.12.1'], reload: true })).workflows).readFrom, RECORDED_CWD)
    await mounted.worker.deactivate()
  })

  test('says nothing when the focused workspace is the same folder, however it is spelt, or with no project', async () => {
    const stage = workflowsScene()
    const sameFolder = 'c:\\projects\\web\\'
    stage.archon.answer(
      CODEBASES,
      changed('0.12.1', 'codebases', 1, (body) => (body as Record<string, unknown>[]).map((row) => ({ ...row, default_cwd: sameFolder })))
    )
    stage.archon.answer(workflowsUrl(sameFolder), recorded('0.12.1', 'workflows'))
    const mounted = await stage.mount(orcaWith('ws-local'))
    const view = ready((await read(mounted, { project: RECORDED_ID['0.12.1'], reload: true })).workflows)
    assert.equal(view.folder, sameFolder)
    assert.equal(view.readFrom, null)
    assert.equal(ready((await read(mounted, {})).workflows).readFrom, null)
    await mounted.worker.deactivate()
  })

  test('the list works in a remote workspace, with no line about the folder', async () => {
    const mounted = await workflowsScene().mount(orcaWith('ws-ssh'))
    const view = ready((await read(mounted, { project: RECORDED_ID['0.12.1'], reload: true })).workflows)
    assert.ok(listOf(view).rows.some((row) => row.name === ECHO))
    assert.equal(view.readFrom, null)
    await mounted.worker.deactivate()
  })
})

/** Every write the worker sent, as method and URL. */
const writes = (stage: Scene): { method: string; url: string }[] =>
  stage.archon.calls.filter((call) => call.method !== 'GET').map((call) => ({ method: call.method, url: call.url }))

async function remove(mounted: MountedScene, input: Record<string, unknown>): Promise<DeleteAnswer> {
  // Cast: some tests send what a frame must not, to see it refused.
  return (await mounted.worker.request('workflows.delete', input as unknown as WorkflowDelete)) as DeleteAnswer
}

/** A global workflow, named in the closed set, added to a recorded list. */
const withGlobal = (release: Release) =>
  changed(release, 'workflows', 0, (body) => {
    const { workflows, recommended } = body as { workflows: { workflow: Record<string, unknown>; source: string }[]; recommended: unknown }
    const first = workflows[0]
    if (first === undefined) throw new Error('The recorded list is empty.')
    const global = { ...first, workflow: { ...first.workflow, name: 'my-global' }, source: 'global' }
    return { workflows: [...workflows, global], recommended }
  })

const deleteUrl = (name: string, query: Record<string, string>): string => `${WORKFLOWS}/${name}?${new URLSearchParams(query).toString()}`

describe('Delete', () => {
  test('deletes a project workflow once, sending the project default_cwd, and reads the list again, in a remote workspace too', async () => {
    const stage = workflowsScene()
    const url = deleteUrl(ECHO, { cwd: RECORDED_CWD, source: 'project' })
    stage.archon.answer(url, json({ deleted: true, name: ECHO }))
    const mounted = await stage.mount(orcaWith('ws-ssh'))
    await read(mounted, { project: RECORDED_ID['0.12.1'], reload: true })
    const before = stage.archon.calls.filter((call) => call.url === workflowsUrl(RECORDED_CWD)).length
    const answer = await remove(mounted, { name: ECHO, codebaseId: RECORDED_ID['0.12.1'] })
    assert.deepEqual(answer.outcome, { kind: 'deleted', name: ECHO })
    assert.deepEqual(writes(stage), [{ method: 'DELETE', url }])
    assert.equal(stage.archon.calls.filter((call) => call.url === workflowsUrl(RECORDED_CWD)).length, before + 1)
    assert.equal(ready(answer.workflows).codebaseId, RECORDED_ID['0.12.1'])
    await mounted.worker.deactivate()
  })

  test('deletes a global workflow with source=global and no cwd, with or without a project', async () => {
    const stage = workflowsScene()
    stage.archon.answer(WORKFLOWS, withGlobal('0.12.1'))
    stage.archon.answer(workflowsUrl(RECORDED_CWD), withGlobal('0.12.1'))
    const url = deleteUrl('my-global', { source: 'global' })
    stage.archon.answer(url, json({ deleted: true, name: 'my-global' }))
    const mounted = await stage.mount(orcaWith('ws-local'))
    const listed = listOf((await read(mounted, { reload: true })).workflows).rows.find((row) => row.name === 'my-global')
    assert.deepEqual(listed && { source: listed.source, deletable: listed.deletable }, { source: 'global', deletable: true })
    assert.deepEqual((await remove(mounted, { name: 'my-global', codebaseId: null })).outcome, { kind: 'deleted', name: 'my-global' })
    await read(mounted, { project: RECORDED_ID['0.12.1'] })
    assert.deepEqual((await remove(mounted, { name: 'my-global', codebaseId: RECORDED_ID['0.12.1'] })).outcome, { kind: 'deleted', name: 'my-global' })
    assert.deepEqual(writes(stage), [
      { method: 'DELETE', url },
      { method: 'DELETE', url }
    ])
    await mounted.worker.deactivate()
  })

  test('sends nothing for a bundled workflow, one Archon does not list, a project Archon does not list, or when not connected', async () => {
    const stage = workflowsScene()
    const mounted = await stage.mount(orcaWith('ws-local'))
    const bundled = listOf((await read(mounted, { project: RECORDED_ID['0.12.1'], reload: true })).workflows).rows.find((row) => row.source === 'bundled')
    if (bundled === undefined) throw new Error('The recording lists no bundled workflow.')
    for (const input of [
      { name: bundled.name, codebaseId: RECORDED_ID['0.12.1'] },
      { name: 'not-listed', codebaseId: RECORDED_ID['0.12.1'] },
      { name: ECHO, codebaseId: 'no-such-project' },
      // With no project the project workflows are not listed, so none is deleted.
      { name: ECHO, codebaseId: null }
    ]) {
      assert.deepEqual((await remove(mounted, input)).outcome, { kind: 'failed', name: input.name, message: NOT_DELETABLE })
    }
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })

  test('refuses a name outside the closed set before any path is built', async () => {
    const stage = workflowsScene()
    const mounted = await stage.mount(orcaWith('ws-local'))
    for (const name of ['', '../x', 'a/b', '.hidden', 'a..b', 'with space', 'a%2Fb', 'x'.repeat(201)]) {
      await assert.rejects(remove(mounted, { name, codebaseId: RECORDED_ID['0.12.1'] }))
    }
    await assert.rejects(remove(mounted, { name: ECHO }))
    await assert.rejects(remove(mounted, { name: ECHO, codebaseId: null, source: 'project' }))
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })

  test("says Archon's words when it refuses, and never sends a timed-out Delete again", async () => {
    const stage = workflowsScene()
    const url = deleteUrl(ECHO, { cwd: RECORDED_CWD, source: 'project' })
    stage.archon.answer(url, json({ error: 'Workflow not found: orchon-recorder-echo' }, 404))
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: RECORDED_ID['0.12.1'], reload: true })
    assert.deepEqual((await remove(mounted, { name: ECHO, codebaseId: RECORDED_ID['0.12.1'] })).outcome, {
      kind: 'failed',
      name: ECHO,
      message: 'Workflow not found: orchon-recorder-echo'
    })
    stage.archon.answer(url, HANG)
    const pending = remove(mounted, { name: ECHO, codebaseId: RECORDED_ID['0.12.1'] })
    await stage.clock.advance(30_000)
    assert.deepEqual((await pending).outcome, { kind: 'failed', name: ECHO, message: DELETE_TIMED_OUT })
    await stage.clock.advance(120_000)
    assert.equal(writes(stage).length, 2)
    await mounted.worker.deactivate()
  })
})
