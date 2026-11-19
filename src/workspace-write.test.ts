// Orca's approval line for `workspace:write` also covers renaming workspaces, hiding projects,
// focusing terminals and running built-in commands. Orchon uses the capability for `editor.open`
// and `workspace.open` only, so this test fails when the source names any other of its methods.
import { assert, describe, test } from 'orca/testing'
import { CODE_EXTENSIONS, hasExtension, listRepoFiles, readRepoText } from '../scripts/repo-files.ts'

/** Every `workspace:write` method of host API 1.10. */
const WORKSPACE_WRITE_METHODS = [
  'editor.open',
  'workspace.open',
  'workspace.rename',
  'commands.run',
  'project.setHidden',
  'terminal.focus'
]
const ALLOWED = ['editor.open', 'workspace.open']

/** The source Orca loads or the editors ship: not tests, and not the gates' own scripts. */
function isShippedSource(path: string): boolean {
  if (!/^(?:src|editors)\//.test(path)) return false
  if (/\.(?:test|check)\.[a-z]+$/.test(path)) return false
  return hasExtension(path, [...CODE_EXTENSIONS, 'html'])
}

/** The methods outside the allowed two that `text` names, as a word of their own. */
function otherWorkspaceWriteMethods(text: string): string[] {
  return WORKSPACE_WRITE_METHODS.filter((method) => {
    if (ALLOWED.includes(method)) return false
    const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![\\w.])${escaped}(?!\\w)`).test(text)
  })
}

describe('the workspace:write methods the source names', () => {
  test('a call to any method but editor.open and workspace.open is found', () => {
    assert.deepEqual(otherWorkspaceWriteMethods("orca.host.call('workspace.rename', { name })"), [
      'workspace.rename'
    ])
    assert.deepEqual(otherWorkspaceWriteMethods('host.call("commands.run", { action })'), ['commands.run'])
    assert.deepEqual(otherWorkspaceWriteMethods('const method = `project.setHidden`'), ['project.setHidden'])
    assert.deepEqual(otherWorkspaceWriteMethods('// later: terminal.focus\n'), ['terminal.focus'])
    assert.deepEqual(
      otherWorkspaceWriteMethods("call('terminal.focus'); call('commands.run'); call('workspace.rename')"),
      ['workspace.rename', 'commands.run', 'terminal.focus']
    )
  })

  test('the two allowed methods and look-alike names pass', () => {
    assert.deepEqual(otherWorkspaceWriteMethods("orca.host.call('editor.open', { workspaceId, path })"), [])
    assert.deepEqual(otherWorkspaceWriteMethods("orca.host.call('workspace.open', { workspaceId })"), [])
    assert.deepEqual(otherWorkspaceWriteMethods("orca.commands.register('show-runs', run)"), [])
    assert.deepEqual(otherWorkspaceWriteMethods('orca.commands.runner()'), [])
    assert.deepEqual(otherWorkspaceWriteMethods('this.terminal.focused'), [])
  })

  test('no shipped source file names another workspace:write method', () => {
    const sources = listRepoFiles()
      .map((file) => file.path)
      .filter(isShippedSource)
    for (const expected of ['src/worker.ts', 'src/panel.tsx', 'editors/run-graph/main.js']) {
      assert.ok(sources.includes(expected), `${expected} was not read`)
    }
    const named = sources.flatMap((path) =>
      otherWorkspaceWriteMethods(readRepoText(path)).map((method) => `${path} names ${method}`)
    )
    assert.deepEqual(named, [])
  })
})
