// What the builder's code may import. The editors ship as ES modules a frame loads as they are,
// so the builder's code, the copy of Archon's logic included, loads only files beside it: no
// React, no React Flow, no package, no path alias and no Bun. Its tests may also load Orca's
// test runner, Node's, and the repository's test helpers.
import { assert, test } from 'orca/testing'
import { listRepoFiles, readRepoText } from '../../scripts/repo-files.ts'

/**
 * Every module specifier a file names in an import, an export-from or a dynamic import. A static
 * import is read only where a line starts with it, so code quoted inside a string is not one.
 */
function specifiersOf(text: string): string[] {
  const statement = /^\s*(?:(?:import|export)\b[^'\n]*?\bfrom\s+|\}\s*from\s+|import\s+)'([^']+)'|\bimport\(\s*'([^']+)'/gm
  const found: string[] = []
  for (const match of text.matchAll(statement)) {
    const specifier = match[1] ?? match[2]
    if (specifier !== undefined) found.push(specifier)
  }
  return found
}

const files = listRepoFiles()
  .map((file) => file.path)
  .filter((path) => path.startsWith('editors/builder/') && /\.tsx?$/.test(path))
const isTest = (path: string): boolean => path.endsWith('.test.ts')

test('the builder code, the copied Archon logic included, imports only files beside it', () => {
  const shipped = files.filter((path) => !isTest(path))
  assert.ok(shipped.some((path) => path.startsWith('editors/builder/archon/')))
  const outside = shipped.flatMap((path) =>
    specifiersOf(readRepoText(path))
      .filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'))
      .map((specifier) => `${path}: ${specifier}`)
  )
  assert.deepEqual(outside, [])
})

test('the builder tests load no Bun, React, React Flow or path alias', () => {
  const tests = files.filter(isTest)
  assert.ok(tests.some((path) => path.startsWith('editors/builder/archon/')))
  const allowed = (specifier: string): boolean =>
    specifier.startsWith('./') || specifier.startsWith('../') || specifier === 'orca/testing' || specifier === 'node:test'
  const outside = tests.flatMap((path) =>
    specifiersOf(readRepoText(path))
      .filter((specifier) => !allowed(specifier))
      .map((specifier) => `${path}: ${specifier}`)
  )
  assert.deepEqual(outside, [])
})

test('the import scan sees every form of import', () => {
  const text = [
    "import { a } from 'react'",
    "import type { B } from '@xyflow/react'",
    "export { c } from '@/lib/node-ref'",
    "import 'bun:test'",
    "const d = await import('../variants/index.ts')",
    '} from \'./multi-line.ts\'',
    '  "import { z } from \'zod\'; is code quoted in a string, not an import"'
  ].join('\n')
  assert.deepEqual(specifiersOf(text), ['react', '@xyflow/react', '@/lib/node-ref', 'bun:test', '../variants/index.ts', './multi-line.ts'])
})
