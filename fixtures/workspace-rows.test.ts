// The path and host-id fixtures: one or more workspace.list rows for each row shape in the table
// of decision #25, with Windows paths in both slash directions. They are written from that
// table, because no SSH or WSL workspace was available to record.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'

interface WorkspaceRow {
  id: string
  kind: string
  name: string
  project: string | null
  projectId: string | null
  path: string
  branch: string | null
  hostId: string | null
}

interface RowFixture {
  name: string
  shape: string
  platform: string
  localAndWritable: boolean
  row: WorkspaceRow
}

interface RowsFile {
  about: string
  shapes: { shape: string; table: string }[]
  rows: RowFixture[]
}

const fixture = JSON.parse(readRepoText('fixtures/workspace-rows.json')) as RowsFile

/** The first column of the table in #25, in its order. */
const TABLE_ROWS = [
  'On this machine',
  'On an SSH host',
  'WSL, project opened through the WSL share',
  'WSL, project on a Windows drive with its runtime set to WSL',
  'WSL host (experimental setting, off by default)',
  'Any paired Orca server',
  'A folder of a project group with no host stamp'
]

const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path)

/** The long-path prefix of a UNC path. Windows reads it only with backslashes. */
const LONG_UNC_PREFIX = '\\\\?\\UNC\\'

/**
 * The test of #25, as that ticket words it: the host id is exactly `local`, and on Windows the
 * path is not a WSL share path once a leading `\\?\UNC\` is taken off, every `\` is turned into
 * `/`, and case is ignored. Taking the prefix off leaves the UNC path it stands for, so it is
 * replaced with the `\\` it stands in for. It checks the answers written into the fixture; the
 * worker's own test is built and tested with the workspace code.
 */
function localAndWritable(row: WorkspaceRow, platform: string): boolean {
  if (row.hostId !== 'local') return false
  if (platform !== 'win32') return true
  const path = row.path.startsWith(LONG_UNC_PREFIX) ? `\\\\${row.path.slice(LONG_UNC_PREFIX.length)}` : row.path
  return !/^\/\/(wsl\.localhost|wsl\$)\//i.test(path.replaceAll('\\', '/'))
}

describe('the path and host-id fixtures', () => {
  test('say they are written from the table and not recorded', () => {
    assert.match(fixture.about, /#25/)
    assert.match(fixture.about, /not recordings/)
  })

  test('have a shape for every row of the table, in its order', () => {
    assert.deepEqual(
      fixture.shapes.map((shape) => shape.table),
      TABLE_ROWS
    )
    assert.equal(new Set(fixture.shapes.map((shape) => shape.shape)).size, TABLE_ROWS.length)
  })

  test('have at least one row for every shape, and no row of another shape', () => {
    const shapes = fixture.shapes.map((shape) => shape.shape)
    for (const shape of shapes) {
      assert.ok(
        fixture.rows.some((row) => row.shape === shape),
        `no row for ${shape}`
      )
    }
    for (const row of fixture.rows) assert.ok(shapes.includes(row.shape), `${row.name} has the unknown shape ${row.shape}`)
  })

  test('give every Windows path in both slash directions', () => {
    // A long-path prefixed path has no forward-slash spelling: Windows reads `\\?\` only as written.
    const windows = fixture.rows.filter((row) => isWindowsPath(row.row.path) && !row.row.path.startsWith(LONG_UNC_PREFIX))
    assert.ok(windows.length > 0)
    for (const row of windows) {
      const forward = row.row.path.replaceAll('\\', '/')
      const twins = fixture.rows.filter(
        (other) => other.shape === row.shape && other.row.hostId === row.row.hostId && other.row.path.replaceAll('\\', '/') === forward
      )
      assert.ok(
        twins.some((twin) => twin.row.path.includes('\\')) && twins.some((twin) => !twin.row.path.includes('\\')),
        `${row.name} has no twin with the other slash`
      )
      assert.ok(!(row.row.path.includes('\\') && row.row.path.includes('/')), `${row.name} mixes both slashes`)
    }
  })

  test('give both spellings of the WSL share', () => {
    const shares = fixture.rows.filter((row) => row.shape === 'wsl-share').map((row) => row.row.path.replaceAll('\\', '/'))
    assert.ok(shares.some((path) => path.startsWith('//wsl.localhost/')))
    assert.ok(shares.some((path) => path.startsWith('//wsl$/')))
  })

  test('give a WSL share with the long-path prefix, and the share names in upper case', () => {
    const shares = fixture.rows.filter((row) => row.shape === 'wsl-share').map((row) => row.row.path)
    assert.ok(shares.some((path) => path.startsWith('\\\\?\\UNC\\wsl.localhost\\')))
    assert.ok(shares.some((path) => path.startsWith('\\\\?\\UNC\\wsl$\\')))
    for (const name of ['WSL.LOCALHOST', 'WSL$']) {
      const upper = shares.filter((path) => path.replaceAll('\\', '/').startsWith(`//${name}/`))
      assert.ok(upper.some((path) => path.includes('\\')) && upper.some((path) => !path.includes('\\')), `no ${name} share in both slash directions`)
    }
  })

  test('give each host id the table names: local, ssh, runtime and none', () => {
    const hostIds = fixture.rows.map((row) => row.row.hostId)
    assert.ok(hostIds.includes('local'))
    assert.ok(hostIds.includes(null))
    assert.ok(hostIds.some((hostId) => hostId?.startsWith('ssh:')))
    assert.ok(hostIds.some((hostId) => hostId?.startsWith('runtime:')))
    // An SSH host id carries its target URI-encoded.
    assert.ok(hostIds.some((hostId) => hostId !== null && /^ssh:.*%[0-9A-F]{2}/.test(hostId)))
  })

  test('every row is a whole workspace.list row with a name and an id of its own', () => {
    assert.equal(new Set(fixture.rows.map((row) => row.name)).size, fixture.rows.length)
    assert.equal(new Set(fixture.rows.map((row) => row.row.id)).size, fixture.rows.length)
    for (const { name, row } of fixture.rows) {
      assert.deepEqual(Object.keys(row).sort(), ['branch', 'hostId', 'id', 'kind', 'name', 'path', 'project', 'projectId'], name)
      assert.ok(row.kind === 'worktree' || row.kind === 'folder', name)
      assert.ok(row.path !== '' && row.id !== '' && row.name !== '', name)
      assert.ok(row.hostId === null || row.hostId !== '', name)
    }
    // A folder of a project group is a folder, as the table says.
    for (const row of fixture.rows.filter((entry) => entry.shape === 'group-folder-no-host')) {
      assert.equal(row.row.kind, 'folder', row.name)
      assert.equal(row.row.hostId, null, row.name)
    }
  })

  test('the answer written for each row is the one the test of #25 gives', () => {
    for (const row of fixture.rows) {
      assert.ok(row.platform === 'any' || row.platform === 'win32', row.name)
      assert.equal(localAndWritable(row.row, 'win32'), row.localAndWritable, `${row.name} on Windows`)
      // A row marked for every platform has one answer everywhere.
      if (row.platform === 'any') assert.equal(localAndWritable(row.row, 'linux'), row.localAndWritable, `${row.name} elsewhere`)
    }
    // Only a WSL share path has an answer that depends on the platform.
    assert.deepEqual(
      [...new Set(fixture.rows.filter((row) => row.platform === 'win32').map((row) => row.shape))],
      ['wsl-share']
    )
  })

  test('hold both answers, so a test that always says one of them fails', () => {
    assert.ok(fixture.rows.some((row) => row.localAndWritable))
    assert.ok(fixture.rows.some((row) => !row.localAndWritable))
  })
})
