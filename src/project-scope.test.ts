// The worker's request protocol seam: the worker mounted on a scripted Archon and a stand-in Orca
// host that answers the workspace methods. These tests cover the project scope: which Orca
// project is focused, the Archon project it matches, and Link and Register.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, recorded, RELEASES, scene, type Release, type Scene } from '../scripts/scripted-archon.ts'
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
function codebasesAt(release: Release, defaultCwd: string, extra: Record<string, unknown>[] = []): ReturnType<typeof recorded> {
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
