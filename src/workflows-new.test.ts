// The worker's request protocol seam for New workflow and the drafts of the Workflows section
// (#61): the worker mounted on a scripted Archon that replays the recorded workflows, a scripted
// disk and a stand-in Orca host whose plugin storage the test reads. These tests cover the checks
// New workflow makes before any tab opens, the draft and pointer file it writes, that it writes
// nothing to Archon, and how the section marks drafts and lists the new workflows never saved.
import { assert, describe, test, type MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, HANG, health, json, recorded, scene, type MountedScene, type Scene } from '../scripts/scripted-archon.ts'
import type { BuilderAnswer } from '../editors/builder/builder-view'
import type { BuilderOpenAnswer } from './wide-tabs-view'
import type { WorkflowsAnswer, WorkflowsSectionView } from './workflows-section-view'

const CODEBASES = `${DEFAULT}/api/codebases`
const WORKFLOWS = `${DEFAULT}/api/workflows`
const PROJECT = 'cd8c6f17a56a08ff6e8c24143751f5c4'
const CWD = '<project-path>'
const ECHO = 'orchon-recorder-echo'
const ROOT = 'C:/Projects/web'
const FOLDER = `${ROOT}/.orchon`
const workflowsUrl = (cwd: string): string => `${WORKFLOWS}?${new URLSearchParams({ cwd }).toString()}`

type Row = { id: string; kind: 'worktree' | 'folder'; name: string; projectId: string | null; path: string; branch: string | null; hostId: string | null }
const local: Row = { id: 'ws-web', kind: 'folder', name: 'web', projectId: null, path: ROOT, branch: null, hostId: 'local' }
const ssh: Row = { id: 'ws-ssh', kind: 'folder', name: 'far', projectId: null, path: '/srv/far', branch: null, hostId: 'ssh:far' }

function orcaWith(focused: string | null, storage: Record<string, unknown> = {}): MockHostOptions {
  return {
    storage: storage as MockHostOptions['storage'],
    results: {
      'workspace.readContext': focused === null ? null : { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] },
      'workspace.list': { workspaces: [local, ssh], truncated: false },
      'editor.open': { opened: true }
    }
  }
}

function stageFor(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
  stage.archon.answer(CODEBASES, recorded('0.12.1', 'codebases', 1))
  stage.archon.answer(workflowsUrl(CWD), recorded('0.12.1', 'workflows'))
  stage.archon.answer(WORKFLOWS, recorded('0.12.1', 'workflows'))
  return stage
}

const create = (mounted: MountedScene, input: Record<string, unknown>): Promise<BuilderOpenAnswer> => mounted.worker.request('workflows.new', input as never) as Promise<BuilderOpenAnswer>
const draftKeys = (mounted: MountedScene): string[] => Object.keys(mounted.host.data().storage).filter((key) => key.startsWith('builder-draft:'))
const ready = (view: WorkflowsSectionView): Extract<WorkflowsSectionView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The section is ${view.kind}.`)
  return view
}
const section = async (mounted: MountedScene, project?: string) =>
  ready(((await mounted.worker.request('workflows.read', (project === undefined ? { reload: true } : { project, reload: true }) as never)) as WorkflowsAnswer).workflows)

describe('New workflow', () => {
  test('keeps a draft of one empty prompt node, writes its pointer file into .orchon/ and opens the tab, writing nothing to Archon', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orcaWith('ws-web'))
    assert.deepEqual(await create(mounted, { name: 'my-flow', codebaseId: PROJECT, place: 'project' }), { opened: true })
    const pointer = `${FOLDER}/project-my-flow.orchonflow`
    assert.deepEqual(JSON.parse(stage.disk.files.get(pointer) ?? ''), { orchon: 'builder', name: 'my-flow', codebaseId: PROJECT, scope: 'project' })
    assert.deepEqual(mounted.host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: '.orchon/project-my-flow.orchonflow' }])
    for (const write of stage.disk.writes) assert.ok(write.split(' ')[1]?.startsWith(FOLDER), write)
    assert.ok(stage.archon.calls.every((call) => call.method === 'GET'))
    stage.archon.answer(`${WORKFLOWS}/my-flow?${new URLSearchParams({ cwd: CWD }).toString()}`, json({ error: 'Workflow not found: my-flow' }, 404))
    const answer = (await mounted.worker.request('builder.read', { name: 'my-flow', codebaseId: PROJECT, scope: 'project', locale: 'en-GB' } as never)) as BuilderAnswer
    assert.deepEqual(answer.draft, {
      definition: { name: 'my-flow', description: '', nodes: [{ id: 'prompt-1', prompt: '' }] },
      base: null,
      file: "Not saved yet. The first Save writes it to the project's .archon/workflows folder.",
      isNew: true,
      otherArchon: false
    })
    await stage.clock.advance(1_000)
    assert.equal(draftKeys(mounted).length, 1)
    await mounted.worker.deactivate()
  })

  test('a global one names no project', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orcaWith('ws-web'))
    assert.deepEqual(await create(mounted, { name: 'everywhere', codebaseId: PROJECT, place: 'global' }), { opened: true })
    assert.deepEqual(JSON.parse(stage.disk.files.get(`${FOLDER}/global-everywhere.orchonflow`) ?? ''), { orchon: 'builder', name: 'everywhere', codebaseId: null, scope: 'global' })
    await mounted.worker.deactivate()
  })

  test("refuses, before any tab opens, a name Archon's rule refuses or one in use, and says why", async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orcaWith('ws-web'))
    const rule = 'A workflow name cannot be empty, start with ".", or hold "/", "\\" or "..", as Archon requires.'
    for (const [name, reason] of [
      ['', rule],
      ['.hidden', rule],
      ['a/b', rule],
      ['a\\b', rule],
      ['a..b', rule],
      [ECHO, `A workflow named ${ECHO} is already in use here. Choose another name.`],
      ['archon-plan', 'A workflow named archon-plan is already in use here. Choose another name.']
    ] as const) {
      assert.deepEqual(await create(mounted, { name, codebaseId: PROJECT, place: 'project' }), { opened: false, reason }, name)
    }
    assert.deepEqual(await create(mounted, { name: 'twice', codebaseId: PROJECT, place: 'project' }), { opened: true })
    assert.deepEqual(await create(mounted, { name: 'twice', codebaseId: PROJECT, place: 'project' }), {
      opened: false,
      reason: 'A workflow named twice is already in use here. Choose another name.'
    })
    assert.equal(mounted.host.callsOf('editor.open').length, 1)
    await mounted.worker.deactivate()
  })

  test('is refused at the cap of 20 drafts, and in a remote workspace, with the sentence and nothing written', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orcaWith('ws-ssh'))
    assert.deepEqual(await create(mounted, { name: 'far-flow', codebaseId: PROJECT, place: 'project' }), {
      opened: false,
      reason: 'This workspace is on another host. Orchon works with the Archon on this computer.'
    })
    assert.deepEqual(stage.disk.writes, [])
    await mounted.worker.deactivate()
    const full = stageFor()
    const storage: Record<string, unknown> = {}
    for (let slot = 1; slot <= 20; slot += 1) {
      storage[`builder-draft:${String(slot)}`] = { storeId: 'store-a', name: `d-${String(slot)}`, codebaseId: PROJECT, scope: 'project', isNew: true, definition: { name: 'd', nodes: [] }, base: null, file: 'f' }
    }
    const filled = await full.mount(orcaWith('ws-web', storage))
    assert.deepEqual(await create(filled, { name: 'one-more', codebaseId: PROJECT, place: 'project' }), {
      opened: false,
      reason: 'Orchon keeps at most 20 builder drafts, so this one is not kept. Save or discard another draft first.'
    })
    assert.deepEqual(full.disk.writes, [])
    await filled.worker.deactivate()
  })

  test('refuses an input that is not a name, a project id or null, and a place of project or global', async () => {
    const mounted = await stageFor().mount(orcaWith('ws-web'))
    for (const input of [{}, { name: 'x', codebaseId: PROJECT }, { name: 'x', codebaseId: PROJECT, place: 'home' }, { name: 'x', codebaseId: null, place: 'project' }, { name: 'x'.repeat(201), codebaseId: null, place: 'global' }, { name: 'x', codebaseId: null, place: 'global', more: 1 }]) {
      await assert.rejects(create(mounted, input), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await mounted.worker.deactivate()
  })
})

describe('the drafts in the Workflows section', () => {
  test('marks a workflow that has a draft, lists the new workflows never saved here, and says how many others there are', async () => {
    const stage = stageFor()
    const storage = {
      'builder-draft:1': { storeId: 'store-a', name: ECHO, codebaseId: PROJECT, scope: 'project', isNew: false, definition: { name: ECHO, nodes: [] }, base: null, file: 'f' },
      'builder-draft:2': { storeId: 'store-a', name: 'fresh', codebaseId: PROJECT, scope: 'project', isNew: true, definition: { name: 'fresh', nodes: [] }, base: null, file: 'f' },
      'builder-draft:3': { storeId: 'store-a', name: 'wide', codebaseId: null, scope: 'global', isNew: true, definition: { name: 'wide', nodes: [] }, base: null, file: 'f' },
      'builder-draft:4': { storeId: 'store-a', name: 'yonder', codebaseId: 'ffff', scope: 'project', isNew: true, definition: { name: 'yonder', nodes: [] }, base: null, file: 'f' },
      'builder-draft:5': 'unreadable'
    }
    const mounted = await stage.mount(orcaWith('ws-web', storage))
    const view = await section(mounted, PROJECT)
    const list = view.list.kind === 'ready' ? view.list.rows : []
    assert.deepEqual(list.filter((row) => row.draft === true).map((row) => row.name), [ECHO])
    assert.deepEqual(view.drafts, {
      fresh: [
        { name: 'fresh', codebaseId: PROJECT, scope: 'project' },
        { name: 'wide', codebaseId: null, scope: 'global' }
      ],
      elsewhere: 1,
      dropped: 1
    })
    await mounted.worker.deactivate()
  })

  test('Open on a never-saved new workflow opens its tab, and so does Open on a workflow with a draft while Archon is away', async () => {
    const stage = stageFor()
    const storage = {
      'builder-draft:2': { storeId: 'store-a', name: 'fresh', codebaseId: PROJECT, scope: 'project', isNew: true, definition: { name: 'fresh', nodes: [] }, base: null, file: 'f' }
    }
    const mounted = await stage.mount(orcaWith('ws-web', storage))
    const open = (input: Record<string, unknown>) => mounted.worker.request('builder.open', input as never) as Promise<BuilderOpenAnswer>
    assert.deepEqual(await open({ name: 'fresh', codebaseId: PROJECT, source: 'project' }), { opened: true })
    assert.equal(mounted.host.callsOf('editor.open').length, 1)
    await mounted.worker.deactivate()
    const away = scene()
    away.archon.answer(DEFAULT_HEALTH, HANG)
    const searching = await away.mount(orcaWith('ws-web', storage))
    assert.equal((await searching.read()).kind, 'searching')
    const openAway = (input: Record<string, unknown>) => searching.worker.request('builder.open', input as never) as Promise<BuilderOpenAnswer>
    assert.deepEqual(await openAway({ name: 'fresh', codebaseId: PROJECT, source: 'project' }), { opened: true })
    assert.deepEqual(await openAway({ name: ECHO, codebaseId: PROJECT, source: 'project' }), { opened: false, reason: 'Orchon is not connected to Archon.' })
    assert.deepEqual(searching.host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: '.orchon/project-fresh.orchonflow' }])
    await searching.worker.deactivate()
  })
})
