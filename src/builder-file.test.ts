// Pure logic of Open YAML: the path of a project workflow's file, built from the project's folder
// and the `filename` Archon answers, and the local Orca workspace that holds it. Archon's
// `GET /api/workflows/{name}` (0.12.1) names a project file relative to `<folder>/.archon/workflows`:
// `<name>.yaml` for a name with no folder, `sub/<name>.yaml` for a name such as `sub/<name>`, and
// `<pack>/<folder>/<file>.yaml` for a packaged workflow.
import { assert, describe, test } from 'orca/testing'
import { workflowFileIn, yamlTarget } from './builder-file'

describe('the path of a project workflow file', () => {
  test('is the workflows folder of the project, then the file name Archon gives', () => {
    assert.equal(workflowFileIn('C:/Projects/web', 'plan.yaml'), 'C:/Projects/web/.archon/workflows/plan.yaml')
    assert.equal(workflowFileIn('/srv/web/', 'plan.yml'), '/srv/web/.archon/workflows/plan.yml')
  })

  test('keeps the folders of a workflow kept in a subfolder or a package', () => {
    assert.equal(workflowFileIn('C:/Projects/web', 'sub/plan.yaml'), 'C:/Projects/web/.archon/workflows/sub/plan.yaml')
    assert.equal(workflowFileIn('C:/Projects/web', 'sdlc/plan/plan.yaml'), 'C:/Projects/web/.archon/workflows/sdlc/plan/plan.yaml')
    assert.equal(workflowFileIn('C:\\Projects\\web', 'sub\\plan.yaml'), 'C:/Projects/web/.archon/workflows/sub/plan.yaml')
  })

  test('cannot be resolved from a name that leaves the folder, is absolute, empty or not YAML', () => {
    for (const filename of ['', '../plan.yaml', 'sub/../../plan.yaml', '/etc/plan.yaml', 'C:/plan.yaml', '\\\\server\\plan.yaml', 'sub//plan.yaml', './plan.yaml', 'plan', 'plan.json']) {
      assert.equal(workflowFileIn('C:/Projects/web', filename), null, filename)
    }
    assert.equal(workflowFileIn('', 'plan.yaml'), null)
  })
})

describe('the workspace Open YAML opens the file in', () => {
  const row = (id: string, path: string, hostId: string | null = 'local') => ({ id, path, hostId })

  test('is the local workspace that holds the file, with the path inside it', () => {
    const rows = [row('ws-web', 'C:\\Projects\\web'), row('ws-other', 'C:/Projects/other')]
    assert.deepEqual(yamlTarget('C:/Projects/web/.archon/workflows/sub/plan.yaml', rows, 'win32'), {
      workspaceId: 'ws-web',
      path: '.archon/workflows/sub/plan.yaml'
    })
  })

  test('compares Windows paths without case, and prefers the innermost workspace', () => {
    const rows = [row('ws-root', 'c:/projects'), row('ws-web', 'C:/PROJECTS/WEB/')]
    assert.deepEqual(yamlTarget('C:/Projects/web/.archon/workflows/plan.yaml', rows, 'win32'), { workspaceId: 'ws-web', path: '.archon/workflows/plan.yaml' })
  })

  test('is none when no local workspace holds it: another folder, a look-alike name, a remote host, a WSL share', () => {
    const file = 'C:/Projects/web/.archon/workflows/plan.yaml'
    assert.equal(yamlTarget(file, [row('a', 'C:/Projects/web2'), row('b', 'C:/Projects/web', 'ssh:far')], 'win32'), null)
    assert.equal(yamlTarget('//wsl.localhost/Ubuntu/web/.archon/workflows/plan.yaml', [row('w', '//wsl.localhost/Ubuntu/web')], 'win32'), null)
    assert.equal(yamlTarget(file, [row('same', 'C:/Projects/web/.archon/workflows/plan.yaml')], 'win32'), null)
  })
})
