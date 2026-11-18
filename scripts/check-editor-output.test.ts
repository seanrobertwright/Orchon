// The committed editor JavaScript against the compiler's output for tsconfig.editors.json.
import { describe, test } from 'node:test'
import { assert } from 'orca/testing'
import { compareEditorOutput, compileEditors, readCommitted } from './check-editor-output.ts'
import { listRepoFiles } from './repo-files.ts'
import { INSTALL_HINT, withTooling } from './tooling.ts'

const expected = new Map([
  ['editors/run-graph/main.js', 'export const a = 1;\n'],
  ['editors/shared/graph.js', 'export const b = 2;\n']
])

describe('the editor output check', () => {
  test('passes when every compiled file is committed as the compiler writes it', () => {
    assert.deepEqual(
      compareEditorOutput(expected, (path) => expected.get(path)),
      []
    )
  })

  test('fails on a committed file that differs from the compiler output', () => {
    const committed = new Map(expected).set('editors/shared/graph.js', 'export const b = 3;\n')
    assert.deepEqual(
      compareEditorOutput(expected, (path) => committed.get(path)),
      ['editors/shared/graph.js differs from the compiler output. Run: npm run build:editors']
    )
  })

  test('fails on a committed file with other line endings', () => {
    const committed = new Map(expected).set('editors/run-graph/main.js', 'export const a = 1;\r\n')
    assert.deepEqual(
      compareEditorOutput(expected, (path) => committed.get(path)),
      ['editors/run-graph/main.js differs from the compiler output. Run: npm run build:editors']
    )
  })

  test('fails on a compiled file that is not committed', () => {
    assert.deepEqual(
      compareEditorOutput(expected, () => undefined),
      [
        'editors/run-graph/main.js is missing. Run: npm run build:editors',
        'editors/shared/graph.js is missing. Run: npm run build:editors'
      ]
    )
  })

  test('the committed editor JavaScript of this repository is the compiler output', async (t) => {
    const compiled = await withTooling(compileEditors)
    if (compiled === null) return t.skip(INSTALL_HINT)
    assert.deepEqual(compiled.errors, [])

    // Every editor source has its output, with ESM imports a browser can follow.
    const sources = listRepoFiles()
      .map((file) => file.path)
      .filter((path) => /^editors\/.*\.ts$/.test(path) && !/\.(?:test|d)\.ts$/.test(path))
    assert.ok(sources.length > 0)
    assert.deepEqual(
      [...compiled.outputs.keys()].sort(),
      sources.map((path) => path.replace(/\.ts$/, '.js')).sort()
    )
    assert.match(compiled.outputs.get('editors/run-graph/main.js') ?? '', /from "\.\.\/shared\/placeholder\.js"/)

    assert.deepEqual(compareEditorOutput(compiled.outputs, readCommitted), [])
  })
})
