// The worker's request protocol seam for Open in builder: the worker mounted on a scripted Archon
// that replays the recorded workflows, a scripted disk and a stand-in Orca host. These tests cover
// when a builder tab may open, the pointer file the worker writes into `.orchon/`, and its refusals.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Scene } from '../scripts/scripted-archon.ts'
import type { BuilderOpenAnswer } from './wide-tabs-view'

const PROJECT = 'cd8c6f17a56a08ff6e8c24143751f5c4'
/** The project each release's recording registered, read off the fixtures by hand. */
const PROJECT_OF: Record<(typeof RELEASES)[number], string> = {
  '0.12.1': PROJECT,
  '0.13.2': '6feec5b110ac5147f1d58ffa49d2790c',
  '0.14.0': '4fb57f7e8043f7efd57270977e68c598'
}
const CODEBASES = `${DEFAULT}/api/codebases`
const CWD = encodeURIComponent('<project-path>')
const workflowUrl = (name: string, cwd: string | null = CWD): string =>
  `${DEFAULT}/api/workflows/${encodeURIComponent(name)}${cwd === null ? '' : `?cwd=${cwd}`}`
const ROOT = 'C:/Projects/web'
const FOLDER = `${ROOT}/.orchon`

type Row = { id: string; kind: 'worktree' | 'folder'; name: string; projectId: string | null; path: string; branch: string | null; hostId: string | null }
const local: Row = { id: 'ws-web', kind: 'folder', name: 'web', projectId: null, path: ROOT, branch: null, hostId: 'local' }
const ssh: Row = { id: 'ws-ssh', kind: 'folder', name: 'far', projectId: null, path: '/srv/far', branch: null, hostId: 'ssh:far' }

function orcaWith(focused: string | null): MockHostOptions {
  return {
    results: {
      'workspace.readContext': focused === null ? null : { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] },
      'workspace.list': { workspaces: [local, ssh], truncated: false },
      'editor.open': { opened: true }
    }
  }
}

function stageFor(release: (typeof RELEASES)[number] = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  return stage
}

async function openIn(stage: Scene, input: unknown, focused: string | null = 'ws-web') {
  const mounted = await stage.mount(orcaWith(focused))
  const answer = (await mounted.worker.request('builder.open', input as never)) as BuilderOpenAnswer
  return { ...mounted, answer }
}

const NO_WORKSPACE = 'No workspace is focused in Orca. Wide tabs open in a workspace on this computer.'

describe('Open in builder', () => {
  for (const release of RELEASES) {
    test(`writes the workflow's pointer file, named by its scope, and opens it in the focused workspace (${release})`, async () => {
      const stage = stageFor(release)
      stage.archon.answer(workflowUrl('archon-plan'), recorded(release, 'workflows/archon-plan'))
      const { worker, host, answer } = await openIn(stage, { name: 'archon-plan', codebaseId: PROJECT_OF[release] })
      assert.deepEqual(answer, { opened: true })
      const pointer = `${FOLDER}/bundled-archon-plan.orchonflow`
      assert.deepEqual(JSON.parse(stage.disk.files.get(pointer) ?? ''), { orchon: 'builder', name: 'archon-plan', codebaseId: PROJECT_OF[release], scope: 'bundled' })
      assert.equal(stage.disk.files.get(`${FOLDER}/.gitignore`), '*\n')
      assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: '.orchon/bundled-archon-plan.orchonflow' }])
      for (const write of stage.disk.writes) assert.ok(write.split(' ')[1]?.startsWith(FOLDER), write)
      await worker.deactivate()
    })
  }

  test('with no project, asks Archon with no folder and names no project', async () => {
    const stage = stageFor()
    const global = { workflow: { name: 'mine', description: '', nodes: [] }, authored: { name: 'mine', nodes: [] }, filename: 'mine.yaml', source: 'global' }
    stage.archon.answer(workflowUrl('mine', null), json(global))
    const { worker, answer } = await openIn(stage, { name: 'mine', codebaseId: null })
    assert.deepEqual(answer, { opened: true })
    assert.deepEqual(JSON.parse(stage.disk.files.get(`${FOLDER}/global-mine.orchonflow`) ?? ''), { orchon: 'builder', name: 'mine', codebaseId: null, scope: 'global' })
    await worker.deactivate()
  })

  test('is refused, with the reason and nothing written, when no workspace is focused or it is remote', async () => {
    for (const [focused, reason] of [
      [null, NO_WORKSPACE],
      ['ws-ssh', 'This workspace is on another host. Orchon works with the Archon on this computer.']
    ] as const) {
      const stage = stageFor()
      stage.archon.answer(workflowUrl('archon-plan'), recorded('0.12.1', 'workflows/archon-plan'))
      const { worker, host, answer } = await openIn(stage, { name: 'archon-plan', codebaseId: PROJECT }, focused)
      assert.deepEqual(answer, { opened: false, reason })
      assert.deepEqual(stage.disk.writes, [])
      assert.deepEqual(host.callsOf('editor.open'), [])
      await worker.deactivate()
    }
  })

  test('is refused when Archon has no such workflow, or no longer lists the project', async () => {
    const stage = stageFor()
    stage.archon.answer(workflowUrl('gone'), json({ error: 'Workflow not found: gone' }, 404))
    const { worker, answer } = await openIn(stage, { name: 'gone', codebaseId: PROJECT })
    assert.deepEqual(answer, { opened: false, reason: 'Archon has no workflow named gone here.' })
    const other = (await worker.request('builder.open', { name: 'archon-plan', codebaseId: 'abc' })) as BuilderOpenAnswer
    assert.deepEqual(other, { opened: false, reason: 'Archon no longer lists that project.' })
    assert.deepEqual(stage.disk.writes, [])
    await worker.deactivate()
  })

  test('refuses a request that is not a workflow name and a project id or null', async () => {
    const { worker } = await stageFor().mount(orcaWith('ws-web'))
    for (const input of [{}, { name: '', codebaseId: null }, { name: 'x'.repeat(201), codebaseId: null }, { name: 'x' }, { name: 'x', codebaseId: 7 }, { name: 'x', codebaseId: null, more: 1 }]) {
      await assert.rejects(worker.request('builder.open', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await worker.deactivate()
  })
})
