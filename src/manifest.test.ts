// The approval surface the manifest declares: capabilities, contributions and the three settings.
// The setting texts are frozen between releases that ask the user to approve again.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { readRepoText, repoRoot } from '../scripts/repo-files.ts'

const manifest: unknown = JSON.parse(readRepoText('orca-plugin.json'))

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined
  return (value as Record<string, unknown>)[key]
}

const contributes = field(manifest, 'contributes')

describe('the manifest', () => {
  test('carries the identity, licence and Orca floor', () => {
    assert.equal(field(manifest, 'manifestVersion'), 2)
    assert.equal(field(manifest, 'id'), 'orchon')
    assert.equal(field(manifest, 'name'), 'Orchon')
    assert.equal(field(manifest, 'version'), '0.1.0')
    assert.equal(field(manifest, 'license'), 'MIT')
    assert.equal(
      field(manifest, 'description'),
      "Archon's runs, workflows and chat inside Orca. Unofficial; not made or endorsed by the Archon or Orca projects."
    )
    assert.equal(field(manifest, 'publisher'), undefined)
    assert.equal(field(manifest, 'execution'), 'trusted-worker')
    assert.equal(field(manifest, 'main'), 'src/worker.ts')
  })

  test("names a plugin icon within Orca's rules: a square PNG of at least 128 by 128 and at most 256 KB", () => {
    assert.equal(field(manifest, 'icon'), 'assets/icon.png')
    const bytes = readFileSync(join(repoRoot, 'assets', 'icon.png'))
    assert.ok(bytes.length <= 256 * 1024, `the icon is ${String(bytes.length)} bytes, over 256 KB`)
    // A PNG starts with its signature, then the IHDR chunk, whose first fields are width and height.
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the icon is not a PNG')
    assert.equal(bytes.subarray(12, 16).toString('latin1'), 'IHDR')
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    assert.equal(width, height, `the icon is ${String(width)} by ${String(height)}, not square`)
    assert.ok(width >= 128, `the icon is ${String(width)} pixels wide, under 128`)
  })

  test('needs Orca 1.4.248 or newer', () => {
    const range = field(field(manifest, 'engines'), 'orca')
    assert.equal(typeof range, 'string')
    const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(String(range))
    assert.ok(match, `engines.orca is not a ">=x.y.z" range: ${String(range)}`)
    const [major, minor, patch] = match.slice(1).map((part) => Number.parseInt(part, 10))
    const floor = [1, 4, 248]
    const found = [major, minor, patch]
    const firstDifference = found.findIndex((part, index) => part !== floor[index])
    assert.ok(
      firstDifference === -1 || (found[firstDifference] ?? 0) > (floor[firstDifference] ?? 0),
      `engines.orca ${String(range)} is below 1.4.248`
    )
  })

  test('asks for the five capabilities and no other', () => {
    assert.deepEqual(field(manifest, 'capabilities'), [
      { kind: 'workspace:read' },
      { kind: 'workspace:write' },
      { kind: 'storage:own' },
      { kind: 'settings:own' },
      { kind: 'notifications:show' }
    ])
  })

  test('contributes the panel, both editors, the status bar item, the command and the event', () => {
    assert.deepEqual(field(contributes, 'panels'), [
      { id: 'console', title: 'Orchon', icon: 'layers', entry: 'src/panel.tsx', ui: 'components' }
    ])
    assert.deepEqual(field(contributes, 'customEditors'), [
      {
        id: 'run-graph',
        title: 'Orchon run graph',
        extensions: ['.orchonrun'],
        entry: 'editors/run-graph/index.html',
        frame: 'isolated'
      },
      {
        id: 'builder',
        title: 'Orchon workflow builder',
        extensions: ['.orchonflow'],
        entry: 'editors/builder/index.html',
        frame: 'isolated'
      }
    ])
    assert.deepEqual(field(contributes, 'statusBarItems'), [
      { id: 'status', text: 'Orchon', command: 'show-runs' }
    ])
    assert.deepEqual(field(contributes, 'commands'), [
      { id: 'show-runs', title: 'Orchon: Show runs' }
    ])
    assert.deepEqual(field(contributes, 'events'), [{ on: 'workspace.changed' }])
  })

  test('declares the three settings with their frozen texts', () => {
    assert.deepEqual(field(contributes, 'settings'), [
      {
        key: 'baseUrl',
        title: 'Base URL',
        description:
          'Where Orchon looks for Archon on this computer, for example http://127.0.0.1:3090. Leave empty to find it automatically.',
        type: 'string',
        default: '',
        placeholder: 'http://127.0.0.1:3090',
        maxLength: 200
      },
      {
        key: 'archonHome',
        title: 'Archon home folder',
        description:
          "The folder where Archon keeps its files. Orchon reads only server.json in it, to find Archon's address. Leave empty for ~/.archon.",
        type: 'string',
        default: '',
        placeholder: '~/.archon',
        maxLength: 1024
      },
      {
        key: 'notifications',
        title: 'Notifications',
        description:
          'Which desktop notifications Orchon shows. A notification holds the workflow name, its state and the project name. Orca also sends them to paired phones.',
        type: 'string',
        default: 'needs-you',
        enum: ['off', 'needs-you', 'needs-you-and-ended'],
        enumLabels: ['Off', 'Runs that need you', 'Runs that need you and runs that end']
      }
    ])
  })

  test('contributes nothing else', () => {
    assert.deepEqual(Object.keys(Object(contributes)).sort(), [
      'commands',
      'customEditors',
      'events',
      'panels',
      'settings',
      'statusBarItems'
    ])
  })

  test('keeps the names of the projects it works with out of every id', () => {
    const ids: string[] = [String(field(manifest, 'id'))]
    for (const kind of ['panels', 'customEditors', 'statusBarItems', 'commands']) {
      const entries = field(contributes, kind)
      assert.ok(Array.isArray(entries), `${kind} is not a list`)
      for (const entry of entries) ids.push(String(field(entry, 'id')))
    }
    for (const id of ids) assert.ok(!/archon|orca/i.test(id), `the id "${id}" names a project`)
  })
})
