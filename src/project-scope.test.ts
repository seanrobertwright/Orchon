// The worker's request protocol seam: the worker mounted on a scripted Archon and a stand-in Orca
// host that answers the workspace methods. These tests cover the project scope: which Orca
// project is focused, the Archon project it matches, and Link and Register.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Release, type Scene, urls } from '../scripts/scripted-archon.ts'
import type { ScopeAnswer } from './scope-view'

const CODEBASES = `${DEFAULT}/api/codebases`

type Row = { id: string; kind: 'worktree' | 'folder'; name: string; projectId: string | null; path: string; branch: string | null; hostId: string | null }
type Project = { id: string; name: string; kind: 'git' | 'folder'; hostId: string | null; path: string }

const mainCheckout: Row = { id: 'ws-main', kind: 'worktree', name: 'web', projectId: 'p-web', path: 'C:/Projects/web', branch: 'main', hostId: 'local' }
const orcaWorktree: Row = {
  id: 'ws-feature',
  kind: 'worktree',
  name: 'feature',
  projectId: 'p-web',
  path: 'C:/Users/ada/orca/workspaces/web/feature',
  branch: 'feature',
  hostId: 'local'
}
const webProject: Project = { id: 'p-web', name: 'web', kind: 'git', hostId: 'local', path: 'C:/Projects/web' }

/** The host answers for a focused workspace and the lists it is joined to. */
function orcaWith(focused: string | null, rows: Row[] = [mainCheckout, orcaWorktree], projects: Project[] = [webProject]): MockHostOptions {
  return {
    results: {
      'workspace.readContext': focused === null ? null : { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] },
      'workspace.list': { workspaces: rows, truncated: false },
      'project.list': { projects, truncated: false },
      'workspace.open': { opened: true }
    }
  }
}

/** The recorded list of Archon projects of a release, with the project's folder set to `defaultCwd`. */
function codebasesAt(release: Release, defaultCwd: string, extra: unknown[] = []): ReturnType<typeof recorded> {
  const answer = recorded(release, 'codebases', 1)
  if (answer.kind !== 'json' || !Array.isArray(answer.value)) throw new Error('The recorded codebases are not a list.')
  const rows = (answer.value as Record<string, unknown>[]).map((row) => ({ ...row, default_cwd: defaultCwd }))
  return { ...answer, value: [...rows, ...extra] }
}

/** The id of the one project each release's recording holds. Read off the fixtures by hand. */
const RECORDED_ID: Record<Release, string> = {
  '0.12.1': 'cd8c6f17a56a08ff6e8c24143751f5c4',
  '0.13.2': '6feec5b110ac5147f1d58ffa49d2790c',
  '0.14.0': '4fb57f7e8043f7efd57270977e68c598'
}
const RECORDED_NAME = 'orchon-recorder/throwaway-project'

function connectedScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  return stage
}

interface RowFixture {
  name: string
  platform: string
  localAndWritable: boolean
  row: Row
}
const fixtureRows = (JSON.parse(readRepoText('fixtures/workspace-rows.json')) as { rows: RowFixture[] }).rows

async function scopeOf(stage: Scene, host: MockHostOptions): Promise<ScopeAnswer> {
  const { worker } = await stage.mount(host)
  const answer = (await worker.request('scope.read')) as ScopeAnswer
  await worker.deactivate()
  return answer
}

const gitConfigReads = (stage: Scene): string[] => stage.disk.asked.filter((path) => path.endsWith('/.git/config'))

const codebaseCalls = (stage: Scene): string[] => urls(stage).filter((url) => url.startsWith(CODEBASES))

describe('the local-and-writable test, joined from workspace.readContext to workspace.list', () => {
  for (const platform of ['win32', 'linux']) {
    test(`every fixture row on ${platform}: a remote one is not matched, Archon is not asked and no Git config is read`, async () => {
      for (const fixture of fixtureRows) {
        const stage = connectedScene()
        stage.platform = platform
        stage.archon.answer(CODEBASES, codebasesAt('0.12.1', fixture.row.path))
        // Each row is its own folder workspace, so only the host and the path decide.
        const row = { ...fixture.row, projectId: null }
        const answer = await scopeOf(stage, orcaWith(row.id, [mainCheckout, row]))
        const local = platform === 'win32' || fixture.platform === 'any' ? fixture.localAndWritable : fixture.row.hostId === 'local'
        if (local) {
          assert.equal(answer.scope.kind, 'matched', fixture.name)
        } else {
          assert.deepEqual(answer.scope, { kind: 'remote' }, fixture.name)
          assert.deepEqual(codebaseCalls(stage), [], fixture.name)
          assert.deepEqual(gitConfigReads(stage), [], fixture.name)
        }
      }
    })
  }

  test('a focused workspace with no workspace.list row, or with no id, is remote', async () => {
    assert.deepEqual((await scopeOf(connectedScene(), orcaWith('ws-unknown'))).scope, { kind: 'remote' })
    const noId = orcaWith(null)
    noId.results = { ...noId.results, 'workspace.readContext': { branch: 'main', displayName: 'x', terminals: [] } }
    assert.deepEqual((await scopeOf(connectedScene(), noId)).scope, { kind: 'remote' })
  })

  test('a local workspace of a project whose root is on another host is remote', async () => {
    const stage = connectedScene()
    stage.archon.answer(CODEBASES, codebasesAt('0.12.1', 'C:/Projects/web'))
    const answer = await scopeOf(stage, orcaWith('ws-main', [mainCheckout], [{ ...webProject, hostId: 'ssh:box' }]))
    assert.deepEqual(answer.scope, { kind: 'remote' })
  })

  test('no focused workspace is said as such, and asks Archon nothing', async () => {
    const stage = connectedScene()
    assert.deepEqual((await scopeOf(stage, orcaWith(null))).scope, { kind: 'no-workspace' })
    assert.deepEqual(codebaseCalls(stage), [])
  })
})

describe('the project scope', () => {
  for (const release of RELEASES) {
    test(`matches the focused workspace to the recorded project of ${release} by path`, async () => {
      const stage = connectedScene(release)
      stage.archon.answer(CODEBASES, codebasesAt(release, 'C:\\Projects\\web'))
      const { worker } = await stage.mount(orcaWith('ws-feature'))
      const answer = (await worker.request('scope.read')) as ScopeAnswer
      assert.equal(answer.connection.kind, 'connected')
      assert.deepEqual(answer.scope, {
        kind: 'matched',
        project: { id: RECORDED_ID[release], name: RECORDED_NAME },
        by: 'path',
        choices: { projects: [{ id: RECORDED_ID[release], name: RECORDED_NAME }], more: 0, unreadable: 0 }
      })
      await worker.deactivate()
    })
  }
})

describe('matching by Git remote, and the unmatched answer', () => {
  test("reads origin from the main checkout's Git config through the disk, and matches the recorded repository_url", async () => {
    const stage = connectedScene()
    // Archon's folder is elsewhere, so only the remote can match.
    stage.archon.answer(CODEBASES, codebasesAt('0.12.1', 'E:/archon/clones/throwaway'))
    stage.disk.files.set('C:/Projects/web/.git/config', '[remote "origin"]\n\turl = git@github.com:Orchon-Recorder/throwaway-project.git\n')
    const answer = await scopeOf(stage, orcaWith('ws-feature'))
    assert.equal(answer.scope.kind === 'matched' ? answer.scope.by : answer.scope.kind, 'remote')
    assert.deepEqual(stage.disk.opened.at(-1), ['C:/Projects/web'])
  })

  test('an unmatched Git project offers Register with its main checkout folder, never the worktree', async () => {
    const stage = connectedScene()
    stage.archon.answer(CODEBASES, codebasesAt('0.12.1', 'E:/archon/clones/throwaway'))
    const answer = await scopeOf(stage, orcaWith('ws-feature'))
    assert.deepEqual(answer.scope, {
      kind: 'unmatched',
      registerFolder: 'C:/Projects/web',
      choices: { projects: [{ id: RECORDED_ID['0.12.1'], name: RECORDED_NAME }], more: 0, unreadable: 0 }
    })
  })

  test('an unmatched folder that is not a Git repository gets Link only, and no Git config is read', async () => {
    const stage = connectedScene()
    stage.archon.answer(CODEBASES, codebasesAt('0.12.1', 'E:/archon/clones/throwaway'))
    const notes: Row = { id: 'ws-notes', kind: 'folder', name: 'notes', projectId: 'p-notes', path: 'D:/Notes', branch: null, hostId: 'local' }
    const answer = await scopeOf(stage, orcaWith('ws-notes', [notes], [{ id: 'p-notes', name: 'notes', kind: 'folder', hostId: 'local', path: 'D:/Notes' }]))
    assert.equal(answer.scope.kind, 'unmatched')
    assert.ok(answer.scope.kind === 'unmatched' && !Object.hasOwn(answer.scope, 'registerFolder'))
    assert.deepEqual(gitConfigReads(stage), [])
  })

  test('the link choices are the first 100 by name, saying how many more and how many rows could not be read', async () => {
    const stage = connectedScene()
    const extra = Array.from({ length: 120 }, (_, index) => ({ id: `cb-${String(index).padStart(3, '0')}`, name: `zz/p-${String(index).padStart(3, '0')}`, default_cwd: `E:/p/${String(index)}` }))
    stage.archon.answer(CODEBASES, codebasesAt('0.12.1', 'E:/archon/clones/throwaway', [...extra, { id: 'broken' }, 'not a row']))
    const answer = await scopeOf(stage, orcaWith('ws-feature'))
    assert.equal(answer.scope.kind, 'unmatched')
    if (answer.scope.kind !== 'unmatched') return
    assert.equal(answer.scope.choices.projects.length, 100)
    assert.deepEqual(answer.scope.choices.projects[0], { id: RECORDED_ID['0.12.1'], name: RECORDED_NAME })
    assert.deepEqual(answer.scope.choices.projects[99], { id: 'cb-098', name: 'zz/p-098' })
    assert.equal(answer.scope.choices.more, 21)
    assert.equal(answer.scope.choices.unreadable, 2)
  })

  test("a failed read of Archon's projects says so in the scope", async () => {
    const stage = connectedScene()
    stage.archon.answer(CODEBASES, json({ error: 'boom' }, 500))
    const answer = await scopeOf(stage, orcaWith('ws-feature'))
    assert.deepEqual(answer.scope, { kind: 'failed', message: 'Archon answered with an error (500).' })
  })
})
