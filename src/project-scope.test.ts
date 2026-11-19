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

const STORE = 'store-5f1c'

/** A scene whose Archon reports a store id, and lists the recorded project away from the workspace. */
function storeScene(storeId: string | null = STORE): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health(storeId === null ? {} : { storeId }))
  stage.archon.answer(CODEBASES, codebasesAt('0.12.1', 'E:/archon/clones/throwaway'))
  return stage
}

describe('Link to an existing Archon project', () => {
  test('saves the link under the store id and the Orca project, and the project is then matched by link', async () => {
    const stage = storeScene()
    const { worker, host } = await stage.mount(orcaWith('ws-feature'))
    const answer = (await worker.request('scope.link', { projectId: RECORDED_ID['0.12.1'] })) as ScopeAnswer
    assert.equal(answer.scope.kind === 'matched' ? answer.scope.by : answer.scope.kind, 'link')
    assert.deepEqual(host.data().storage['project-links'], { [STORE]: { 'project:p-web': RECORDED_ID['0.12.1'] } })
    // Every worktree of the project shares the link.
    host.respond('workspace.readContext', { workspaceId: 'ws-main', branch: 'main', displayName: 'web', terminals: [] })
    const again = (await worker.request('scope.read')) as ScopeAnswer
    assert.equal(again.scope.kind === 'matched' ? again.scope.by : again.scope.kind, 'link')
    await worker.deactivate()
  })

  test('saves under the base URL when the server reports no store id', async () => {
    const stage = storeScene(null)
    const { worker, host } = await stage.mount(orcaWith('ws-feature'))
    await worker.request('scope.link', { projectId: RECORDED_ID['0.12.1'] })
    assert.deepEqual(host.data().storage['project-links'], { [DEFAULT]: { 'project:p-web': RECORDED_ID['0.12.1'] } })
    await worker.deactivate()
  })

  test('a saved link whose project Archon no longer lists is skipped and kept', async () => {
    const stage = storeScene()
    const saved = { [STORE]: { 'project:p-web': 'cb-gone' }, 'other-store': { 'project:p-web': 'cb-x' } }
    const { worker, host } = await stage.mount({ ...orcaWith('ws-feature'), storage: { 'project-links': saved } })
    const answer = (await worker.request('scope.read')) as ScopeAnswer
    assert.equal(answer.scope.kind, 'unmatched')
    assert.deepEqual(host.data().storage['project-links'], saved)
    await worker.deactivate()
  })

  test('a link saved under another store does not count', async () => {
    const stage = storeScene()
    const saved = { 'other-store': { 'project:p-web': RECORDED_ID['0.12.1'] } }
    const answer = await scopeOf(stage, { ...orcaWith('ws-feature'), storage: { 'project-links': saved } })
    assert.equal(answer.scope.kind, 'unmatched')
  })

  test("change replaces the link and clear removes only this project's link", async () => {
    const stage = storeScene()
    stage.archon.answer(CODEBASES, codebasesAt('0.12.1', 'E:/archon/clones/throwaway', [{ id: 'cb-2', name: 'acme/two', default_cwd: 'E:/two' }]))
    const saved = { [STORE]: { 'project:p-web': RECORDED_ID['0.12.1'], 'project:p-other': 'cb-2' } }
    const { worker, host } = await stage.mount({ ...orcaWith('ws-feature'), storage: { 'project-links': saved } })
    const changed = (await worker.request('scope.link', { projectId: 'cb-2' })) as ScopeAnswer
    assert.deepEqual(changed.scope.kind === 'matched' ? changed.scope.project : null, { id: 'cb-2', name: 'acme/two' })
    const cleared = (await worker.request('scope.unlink')) as ScopeAnswer
    assert.equal(cleared.scope.kind, 'unmatched')
    assert.deepEqual(host.data().storage['project-links'], { [STORE]: { 'project:p-other': 'cb-2' } })
    await worker.deactivate()
  })

  test('a project Archon does not list is refused and nothing is saved', async () => {
    const stage = storeScene()
    const { worker, host } = await stage.mount(orcaWith('ws-feature'))
    const answer = (await worker.request('scope.link', { projectId: 'cb-unknown' })) as ScopeAnswer
    assert.equal(answer.scope.kind, 'unmatched')
    assert.equal(answer.refused, 'Archon no longer lists that project. Choose another.')
    assert.equal(host.data().storage['project-links'], undefined)
    await worker.deactivate()
  })

  test('in a remote workspace Link is off: refused, nothing saved and Archon not asked', async () => {
    const stage = storeScene()
    const ssh: Row = { ...mainCheckout, id: 'ws-ssh', hostId: 'ssh:box', path: '/srv/web' }
    const { worker, host } = await stage.mount(orcaWith('ws-ssh', [ssh], []))
    const answer = (await worker.request('scope.link', { projectId: RECORDED_ID['0.12.1'] })) as ScopeAnswer
    assert.deepEqual(answer.scope, { kind: 'remote' })
    assert.equal(answer.refused, 'This workspace is on another host. Orchon works with the Archon on this computer.')
    assert.equal(host.data().storage['project-links'], undefined)
    assert.deepEqual(codebaseCalls(stage), [])
    await worker.deactivate()
  })

  test('a malformed link request is refused before anything is read', async () => {
    const { worker } = await storeScene().mount(orcaWith('ws-feature'))
    for (const input of [null, {}, { projectId: '' }, { projectId: 7 }, { projectId: 'cb', extra: 1 }]) {
      await assert.rejects(worker.request('scope.link', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await assert.rejects(worker.request('scope.unlink', { projectId: 'x' } as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    await worker.deactivate()
  })
})

/** Archon's projects around a registration: none until a POST that succeeds, then the recorded project at `folder`. */
function registering(stage: Scene, release: Release, folder: string, post: ReturnType<typeof recorded> = recorded(release, 'codebases')): void {
  let registered = false
  stage.archon.answer(CODEBASES, (call) => {
    if (call.method === 'POST') {
      registered = post.kind === 'json' && (post.status ?? 200) < 300
      return post
    }
    return registered ? codebasesAt(release, folder) : json([])
  })
}

const posts = (stage: Scene): { url: string; body?: string }[] =>
  stage.archon.calls.filter((call) => call.method === 'POST').map((call) => (call.body === undefined ? { url: call.url } : { url: call.url, body: call.body }))

describe('Register with Archon', () => {
  for (const release of RELEASES) {
    test(`sends POST /api/codebases with the confirmed main checkout folder only, then matches it (${release})`, async () => {
      const stage = connectedScene(release)
      registering(stage, release, 'C:/Projects/web')
      const { worker } = await stage.mount(orcaWith('ws-feature'))
      const before = (await worker.request('scope.read')) as ScopeAnswer
      assert.equal(before.scope.kind === 'unmatched' ? before.scope.registerFolder : null, 'C:/Projects/web')
      // Reading the scope never registers anything.
      assert.deepEqual(posts(stage), [])
      const answer = (await worker.request('scope.register', { folder: 'C:/Projects/web' })) as ScopeAnswer
      assert.deepEqual(posts(stage), [{ url: CODEBASES, body: '{"path":"C:/Projects/web"}' }])
      assert.equal(answer.refused, undefined)
      assert.deepEqual(answer.scope.kind === 'matched' ? [answer.scope.project.id, answer.scope.by] : answer.scope.kind, [RECORDED_ID[release], 'path'])
      await worker.deactivate()
    })
  }

  test('a folder other than the main checkout shown is refused, and nothing is sent', async () => {
    const stage = connectedScene()
    registering(stage, '0.12.1', 'C:/Projects/web')
    const { worker } = await stage.mount(orcaWith('ws-feature'))
    for (const folder of ['C:/Users/ada/orca/workspaces/web/feature', 'c:/projects/web', 'C:/Projects/web/']) {
      const answer = (await worker.request('scope.register', { folder })) as ScopeAnswer
      assert.equal(answer.refused, 'The folder to register has changed. Check it and confirm again.', folder)
    }
    assert.deepEqual(posts(stage), [])
    await worker.deactivate()
  })

  test('a folder that is not a Git repository is refused, and nothing is sent', async () => {
    const stage = connectedScene()
    registering(stage, '0.12.1', 'D:/Notes')
    const notes: Row = { id: 'ws-notes', kind: 'folder', name: 'notes', projectId: 'p-notes', path: 'D:/Notes', branch: null, hostId: 'local' }
    const { worker } = await stage.mount(orcaWith('ws-notes', [notes], [{ id: 'p-notes', name: 'notes', kind: 'folder', hostId: 'local', path: 'D:/Notes' }]))
    const answer = (await worker.request('scope.register', { folder: 'D:/Notes' })) as ScopeAnswer
    assert.equal(answer.refused, 'Only a Git repository can be registered. Link this folder to an Archon project instead.')
    assert.deepEqual(posts(stage), [])
    await worker.deactivate()
  })

  test('in a remote workspace Register is off, and nothing is sent', async () => {
    const stage = connectedScene()
    registering(stage, '0.12.1', '/srv/web')
    const ssh: Row = { ...mainCheckout, id: 'ws-ssh', hostId: 'ssh:box', path: '/srv/web' }
    const { worker } = await stage.mount(orcaWith('ws-ssh', [ssh], [{ ...webProject, hostId: 'ssh:box', path: '/srv/web' }]))
    const answer = (await worker.request('scope.register', { folder: '/srv/web' })) as ScopeAnswer
    assert.equal(answer.refused, 'This workspace is on another host. Orchon works with the Archon on this computer.')
    assert.deepEqual(posts(stage), [])
    await worker.deactivate()
  })

  test('a refused registration says why, and is not sent again', async () => {
    const stage = connectedScene()
    registering(stage, '0.12.1', 'C:/Projects/web', json({ error: 'Path is not a git repository' }, 400))
    const { worker } = await stage.mount(orcaWith('ws-feature'))
    const answer = (await worker.request('scope.register', { folder: 'C:/Projects/web' })) as ScopeAnswer
    assert.equal(answer.refused, 'Archon answered with an error (400).')
    assert.equal(answer.scope.kind, 'unmatched')
    assert.equal(posts(stage).length, 1)
    await worker.deactivate()
  })

  test('a malformed register request is refused before anything is sent', async () => {
    const stage = connectedScene()
    registering(stage, '0.12.1', 'C:/Projects/web')
    const { worker } = await stage.mount(orcaWith('ws-feature'))
    for (const input of [null, {}, { folder: '' }, { folder: 3 }, { folder: 'C:/Projects/web', path: 'x' }]) {
      await assert.rejects(worker.request('scope.register', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    assert.deepEqual(posts(stage), [])
    await worker.deactivate()
  })
})
