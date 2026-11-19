// The worker's request protocol seam for the builder tab: the worker mounted on a scripted Archon
// that replays the recorded workflows. These tests cover `builder.read`, which loads a workflow's
// authored form for the tab, and `builder.openYaml`, which opens its file in Orca.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Release, type Scene, type Scripted } from '../scripts/scripted-archon.ts'
import type { BuilderAnswer, BuilderView, YamlOpenAnswer } from '../editors/builder/builder-view'

const CODEBASES = `${DEFAULT}/api/codebases`
const workflowUrl = (name: string, cwd: string | null): string =>
  `${DEFAULT}/api/workflows/${encodeURIComponent(name)}${cwd === null ? '' : `?cwd=${encodeURIComponent(cwd)}`}`

/** The project each release's recording registered, read off the fixtures by hand. */
const PROJECT_OF: Record<Release, string> = {
  '0.12.1': 'cd8c6f17a56a08ff6e8c24143751f5c4',
  '0.13.2': '6feec5b110ac5147f1d58ffa49d2790c',
  '0.14.0': '4fb57f7e8043f7efd57270977e68c598'
}

/** A project of our own, in a folder Orca lists as a workspace. */
const WEB = 'aaaa0000bbbb1111cccc2222dddd3333'
const WEB_FOLDER = 'C:/Projects/web'
const webProject = { id: WEB, name: 'web', default_cwd: WEB_FOLDER, repository_url: null }

type Row = { id: string; kind: 'worktree' | 'folder'; name: string; projectId: string | null; path: string; branch: string | null; hostId: string | null }
const rows: Row[] = [
  { id: 'ws-web', kind: 'folder', name: 'web', projectId: null, path: WEB_FOLDER, branch: null, hostId: 'local' },
  { id: 'ws-far', kind: 'folder', name: 'far', projectId: null, path: '/srv/far', branch: null, hostId: 'ssh:far' }
]
const orca: MockHostOptions = {
  results: {
    'workspace.readContext': { workspaceId: 'ws-web', branch: 'main', displayName: 'web', terminals: [] },
    'workspace.list': { workspaces: rows, truncated: false },
    'editor.open': { opened: true }
  }
}

function jsonOf(answer: Scripted): Record<string, unknown> {
  if (answer.kind !== 'json') throw new Error('The recorded answer is not JSON.')
  return answer.value as Record<string, unknown>
}

function stageFor(release: Release = '0.12.1', projects: unknown = null): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, projects === null ? recorded(release, 'codebases', 1) : json(projects))
  return stage
}

async function readIn(stage: Scene, input: Record<string, unknown>): Promise<BuilderAnswer> {
  const { worker } = await stage.mount(orca)
  const answer = (await worker.request('builder.read', { locale: 'en-GB', ...input } as never)) as BuilderAnswer
  await worker.deactivate()
  return answer
}

function ready(view: BuilderView): Extract<BuilderView, { kind: 'ready' }> {
  if (view.kind !== 'ready') throw new Error(`The builder is ${view.kind}, not ready.`)
  return view
}

/** A project workflow kept in a subfolder, as Archon would answer it. */
const subfolderWorkflow = (extra: Record<string, unknown> = {}) =>
  json({
    workflow: { name: 'plan', description: '', nodes: [{ id: 'a', prompt: 'p' }] },
    authored: { name: 'plan', description: 'Plans', nodes: [{ id: 'a', prompt: 'p' }] },
    filename: 'sub/plan.yaml',
    source: 'project',
    ...extra
  })

describe('the builder read', () => {
  for (const release of RELEASES) {
    test(`loads the authored form of a recorded bundled workflow (${release})`, async () => {
      const stage = stageFor(release)
      const recordedAnswer = recorded(release, 'workflows/archon-plan')
      stage.archon.answer(workflowUrl('archon-plan', '<project-path>'), recordedAnswer)
      const answer = await readIn(stage, { name: 'archon-plan', codebaseId: PROJECT_OF[release], scope: 'bundled' })
      assert.deepEqual(answer.connection, { kind: 'connected', live: true })
      const view = ready(answer.builder)
      assert.deepEqual(view.header, { name: 'archon-plan', source: 'bundled', file: 'archon-plan.yaml, bundled with Archon', viewOnly: false, openYaml: false })
      assert.deepEqual(view.definition, jsonOf(recordedAnswer).authored)
    })
  }

  test("a project workflow kept in a subfolder shows its file's path, and Open YAML opens it in the workspace that holds it", async () => {
    const stage = stageFor('0.12.1', [webProject])
    stage.archon.answer(workflowUrl('plan', WEB_FOLDER), subfolderWorkflow())
    const { worker, host } = await stage.mount(orca)
    const identity = { name: 'plan', codebaseId: WEB, scope: 'project' }
    const answer = (await worker.request('builder.read', { ...identity, locale: 'en-GB' })) as BuilderAnswer
    const view = ready(answer.builder)
    assert.deepEqual(view.header, { name: 'plan', source: 'project', file: 'C:/Projects/web/.archon/workflows/sub/plan.yaml', viewOnly: false, openYaml: true })
    assert.deepEqual(view.definition, { name: 'plan', description: 'Plans', nodes: [{ id: 'a', prompt: 'p' }] })
    const opened = (await worker.request('builder.openYaml', identity as never)) as YamlOpenAnswer
    assert.deepEqual(opened, { opened: true })
    assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: '.archon/workflows/sub/plan.yaml' }])
    await worker.deactivate()
  })

  test('Open YAML is off when no local workspace holds the file, and Orca is not asked', async () => {
    const stage = stageFor('0.12.1', [{ ...webProject, default_cwd: 'D:/Elsewhere/web' }])
    stage.archon.answer(workflowUrl('plan', 'D:/Elsewhere/web'), subfolderWorkflow())
    const { worker, host } = await stage.mount(orca)
    const identity = { name: 'plan', codebaseId: WEB, scope: 'project' }
    const answer = (await worker.request('builder.read', { ...identity, locale: 'en-GB' })) as BuilderAnswer
    assert.equal(ready(answer.builder).header.openYaml, false)
    const opened = (await worker.request('builder.openYaml', identity as never)) as YamlOpenAnswer
    assert.deepEqual(opened, { opened: false, reason: 'This workflow file is not inside a workspace on this computer that Orca lists.' })
    assert.deepEqual(host.callsOf('editor.open'), [])
    await worker.deactivate()
  })

  test('Open YAML is off for a file name it cannot resolve', async () => {
    const stage = stageFor('0.12.1', [webProject])
    stage.archon.answer(workflowUrl('plan', WEB_FOLDER), subfolderWorkflow({ filename: '../../outside.yaml' }))
    const view = ready((await readIn(stage, { name: 'plan', codebaseId: WEB, scope: 'project' })).builder)
    assert.equal(view.header.openYaml, false)
  })

  test("a global workflow names its file in Archon's home folder", async () => {
    const stage = stageFor()
    stage.archon.answer(workflowUrl('mine', null), json({ workflow: { name: 'mine', nodes: [] }, authored: { name: 'mine', nodes: [] }, filename: 'mine.yaml', source: 'global' }))
    const view = ready((await readIn(stage, { name: 'mine', codebaseId: null, scope: 'global' })).builder)
    assert.deepEqual(view.header, { name: 'mine', source: 'global', file: "workflows/mine.yaml in Archon's home folder", viewOnly: false, openYaml: false })
  })

  test('an installed workflow, which Archon sends only normalised, is view-only', async () => {
    const stage = stageFor()
    const normalised = { name: 'owner/plugin:flow', description: 'From a plugin', nodes: [{ id: 'a', bash: 'echo' }] }
    stage.archon.answer(workflowUrl('owner/plugin:flow', null), json({ workflow: normalised, filename: 'owner/plugin:flow', source: 'installed' }))
    const view = ready((await readIn(stage, { name: 'owner/plugin:flow', codebaseId: null, scope: 'installed' })).builder)
    assert.deepEqual(view.header, { name: 'owner/plugin:flow', source: 'installed', file: 'owner/plugin:flow, installed', viewOnly: true, openYaml: false })
    assert.deepEqual(view.definition, normalised)
  })

  test('a definition over 1 MiB is not sent, and the view says how large it is', async () => {
    const stage = stageFor('0.12.1', [webProject])
    const big = 'x'.repeat(1024 * 1024)
    stage.archon.answer(workflowUrl('plan', WEB_FOLDER), subfolderWorkflow({ authored: { name: 'plan', nodes: [{ id: 'a', prompt: big }] } }))
    const view = (await readIn(stage, { name: 'plan', codebaseId: WEB, scope: 'project' })).builder
    assert.equal(view.kind, 'too-large')
    assert.ok(view.kind === 'too-large')
    assert.equal(view.cap, 1024 * 1024)
    assert.ok(view.bytes !== null && view.bytes > 1024 * 1024)
    assert.equal(view.header.file, 'C:/Projects/web/.archon/workflows/sub/plan.yaml')
  })

  test('a definition with no list of node records, or no authored form, is an error', async () => {
    for (const authored of [{ name: 'plan', nodes: 'none' }, { name: 'plan', nodes: [{ id: 'a' }, 'b'] }, undefined]) {
      const stage = stageFor('0.12.1', [webProject])
      stage.archon.answer(workflowUrl('plan', WEB_FOLDER), subfolderWorkflow({ authored }))
      const view = (await readIn(stage, { name: 'plan', codebaseId: WEB, scope: 'project' })).builder
      assert.equal(view.kind, 'failed', JSON.stringify(authored))
    }
  })

  test('a workflow Archon does not have, or a project it no longer lists, is gone', async () => {
    const stage = stageFor('0.12.1', [webProject])
    stage.archon.answer(workflowUrl('plan', WEB_FOLDER), json({ error: 'Workflow not found: plan' }, 404))
    assert.deepEqual((await readIn(stage, { name: 'plan', codebaseId: WEB, scope: 'project' })).builder, { kind: 'gone', message: 'Archon has no workflow named plan here.' })
    assert.deepEqual((await readIn(stageFor('0.12.1', []), { name: 'plan', codebaseId: WEB, scope: 'project' })).builder, {
      kind: 'gone',
      message: 'Archon no longer lists that project.'
    })
  })

  test('while not connected the tab gets the state screen and Archon is not asked', async () => {
    const stage = scene()
    const answer = await readIn(stage, { name: 'plan', codebaseId: null, scope: 'global' })
    assert.deepEqual(answer.builder, { kind: 'not-connected' })
    assert.ok(answer.connection.kind === 'screen' && answer.connection.screen.title === 'Orchon could not find Archon.')
  })

  test('refuses a request that is not a workflow identity and a language', async () => {
    const { worker } = await stageFor().mount(orca)
    const good = { name: 'plan', codebaseId: null, scope: 'global', locale: 'en-GB' }
    for (const input of [{ ...good, scope: '' }, { ...good, scope: 'x'.repeat(41) }, { ...good, locale: 'not a tag' }, { ...good, name: '' }, { ...good, more: 1 }]) {
      await assert.rejects(worker.request('builder.read', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await worker.deactivate()
  })
})
