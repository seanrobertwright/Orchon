// Orca's listing limits, driven through the function the command line uses.
import { assert, describe, test } from 'orca/testing'
import { checkInstallLimits, INSTALL_LIMITS } from './check-install-limits.ts'
import { listRepoFiles } from './repo-files.ts'

const MIB = 1024 * 1024
const file = (path: string, bytes: number) => ({ path, bytes })

describe('the install-limits check', () => {
  test('uses the limits of the listing policy', () => {
    assert.deepEqual(INSTALL_LIMITS, { files: 2000, totalBytes: 50 * MIB, transpiledFileBytes: MIB })
  })

  test('passes a plugin at each limit exactly', () => {
    const files = Array.from({ length: 2000 }, (_, index) => file(`data/${index}.json`, 0))
    files[0] = file('src/worker.ts', MIB)
    files[1] = file('fixtures/big.json', 49 * MIB)
    assert.deepEqual(checkInstallLimits(files), [])
  })

  test('fails past 2,000 files', () => {
    const files = Array.from({ length: 2001 }, (_, index) => file(`data/${index}.json`, 1))
    assert.deepEqual(checkInstallLimits(files), ['2,001 files: the limit is 2,000.'])
  })

  test('fails past 50 MiB in total', () => {
    const files = [file('a.bin', 30 * MIB), file('b.bin', 20 * MIB + 1)]
    assert.deepEqual(checkInstallLimits(files), ['52,428,801 bytes in total: the limit is 52,428,800 (50 MiB).'])
  })

  test('fails on each file Orca transpiles that is past 1 MiB, and on no other large file', () => {
    const files = [
      file('src/worker.ts', MIB + 1),
      file('src/panel.tsx', MIB + 2),
      file('src/late.mts', MIB + 3),
      file('src/view.jsx', MIB + 4),
      file('editors/shared/dagre.esm.js', 2 * MIB),
      file('fixtures/0.14.0/workflows.json', 3 * MIB)
    ]
    assert.deepEqual(checkInstallLimits(files), [
      'src/worker.ts is 1,048,577 bytes: a file Orca transpiles may be at most 1,048,576 (1 MiB).',
      'src/panel.tsx is 1,048,578 bytes: a file Orca transpiles may be at most 1,048,576 (1 MiB).',
      'src/late.mts is 1,048,579 bytes: a file Orca transpiles may be at most 1,048,576 (1 MiB).',
      'src/view.jsx is 1,048,580 bytes: a file Orca transpiles may be at most 1,048,576 (1 MiB).'
    ])
  })

  test('counts this repository without the folders no gate reads, and it fits', () => {
    const files = listRepoFiles()
    assert.ok(files.some((entry) => entry.path === 'orca-plugin.json'))
    for (const skipped of ['.git', '.lril', '.orca', 'node_modules']) {
      assert.ok(!files.some((entry) => entry.path.split('/').includes(skipped)), `${skipped} was read`)
    }
    assert.deepEqual(checkInstallLimits(files), [])
  })
})
