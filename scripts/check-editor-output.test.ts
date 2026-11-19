// The committed editor JavaScript against the compiler's output for tsconfig.editors.json.
import { describe, test } from 'node:test'
import { assert } from 'orca/testing'
import {
  COPIED_EDITOR_JAVASCRIPT,
  compareEditorOutput,
  compileEditors,
  isTestOnlyEditorSource,
  TEST_ONLY_EDITOR_SOURCES,
  readCommittedEditorJavaScript
} from './check-editor-output.ts'
import { listRepoFiles, readRepoText } from './repo-files.ts'
import { INSTALL_HINT, withTooling } from './tooling.ts'

const expected = new Map([
  ['editors/run-graph/main.js', 'export const a = 1;\n'],
  ['editors/shared/graph.js', 'export const b = 2;\n']
])

describe('the editor output check', () => {
  test('passes when every compiled file is committed as the compiler writes it', () => {
    assert.deepEqual(compareEditorOutput(expected, new Map(expected)), [])
  })

  test('fails on a committed file that differs from the compiler output', () => {
    const committed = new Map(expected).set('editors/shared/graph.js', 'export const b = 3;\n')
    assert.deepEqual(compareEditorOutput(expected, committed), [
      'editors/shared/graph.js differs from the compiler output. Run: npm run build:editors'
    ])
  })

  test('fails on a committed file with other line endings', () => {
    const committed = new Map(expected).set('editors/run-graph/main.js', 'export const a = 1;\r\n')
    assert.deepEqual(compareEditorOutput(expected, committed), [
      'editors/run-graph/main.js differs from the compiler output. Run: npm run build:editors'
    ])
  })

  test('fails on a compiled file that is not committed', () => {
    assert.deepEqual(compareEditorOutput(expected, new Map()), [
      'editors/run-graph/main.js is missing. Run: npm run build:editors',
      'editors/shared/graph.js is missing. Run: npm run build:editors'
    ])
  })

  test('fails on committed JavaScript that has no TypeScript source', () => {
    const committed = new Map(expected)
      .set('editors/shared/handwritten.js', 'export const c = 3;\n')
      .set('editors/builder/old.js', 'export const d = 4;\n')
    assert.deepEqual(compareEditorOutput(expected, committed), [
      'editors/builder/old.js has no TypeScript source: editor JavaScript is compiler output only.',
      'editors/shared/handwritten.js has no TypeScript source: editor JavaScript is compiler output only.'
    ])
  })

  test('passes a copied third-party file, which has no TypeScript source by design', () => {
    const committed = new Map(expected).set('editors/shared/dagre.esm.js', 'var e=1;export{e as layout};\n')
    assert.deepEqual(compareEditorOutput(expected, committed), [])
  })

  test("names dagre's single-file ESM build as the only copied editor JavaScript, with its licence beside it and in THIRD_PARTY_NOTICES", () => {
    assert.deepEqual(COPIED_EDITOR_JAVASCRIPT, ['editors/shared/dagre.esm.js'])
    const paths = listRepoFiles().map((file) => file.path)
    const notices = readRepoText('THIRD_PARTY_NOTICES')
    for (const path of COPIED_EDITOR_JAVASCRIPT) {
      assert.ok(paths.includes(path), `${path} is not in the repository`)
      assert.ok(notices.includes(path), `THIRD_PARTY_NOTICES does not name ${path}`)
    }
    assert.ok(paths.includes('editors/shared/dagre.LICENSE'))
    assert.match(readRepoText('editors/shared/dagre.LICENSE'), /Copyright \(c\) 2012-2014 Chris Pettitt/)
  })

  test("names Archon's builder test fixtures and test helpers as the only test-only editor sources", () => {
    assert.equal(isTestOnlyEditorSource('editors/builder/archon/fixtures/index.ts'), true)
    assert.equal(isTestOnlyEditorSource('editors/builder/archon/fixtures/loop.fixture.ts'), true)
    assert.equal(isTestOnlyEditorSource('editors/builder/archon/validation/test-helpers.ts'), true)
    assert.equal(isTestOnlyEditorSource('editors/builder/archon/validation/structural.ts'), false)
    assert.equal(isTestOnlyEditorSource('editors/builder/archon/fixtures.ts'), false)
    assert.equal(isTestOnlyEditorSource('editors/shared/fixtures/index.ts'), false)
  })

  test('tsconfig.editors.json leaves out exactly the test-only editor sources, besides tests and declarations', () => {
    const { exclude } = JSON.parse(readRepoText('tsconfig.editors.json')) as { exclude: string[] }
    assert.deepEqual(exclude, [
      'editors/**/*.test.ts',
      'editors/**/*.d.ts',
      ...TEST_ONLY_EDITOR_SOURCES.folders.map((folder) => `${folder}**`),
      ...TEST_ONLY_EDITOR_SOURCES.files
    ])
  })

  test('reads every JavaScript file under editors/ and none outside it', () => {
    const committed = readCommittedEditorJavaScript()
    const paths = listRepoFiles()
      .map((file) => file.path)
      .filter((path) => path.startsWith('editors/') && path.endsWith('.js'))
    assert.ok(paths.includes('editors/run-graph/main.js'))
    assert.deepEqual([...committed.keys()], paths)
  })

  test('the committed editor JavaScript of this repository is the compiler output', async (t) => {
    const compiled = await withTooling(compileEditors)
    if (compiled === null) return t.skip(INSTALL_HINT)
    assert.deepEqual(compiled.errors, [])

    // Every editor source has its output, with ESM imports a browser can follow.
    const sources = listRepoFiles()
      .map((file) => file.path)
      .filter((path) => /^editors\/.*\.ts$/.test(path) && !/\.(?:test|d)\.ts$/.test(path))
      .filter((path) => !isTestOnlyEditorSource(path))
    assert.ok(sources.length > 0)
    assert.deepEqual(
      [...compiled.outputs.keys()].sort(),
      sources.map((path) => path.replace(/\.ts$/, '.js')).sort()
    )
    assert.match(compiled.outputs.get('editors/run-graph/main.js') ?? '', /from "\.\/tab\.js"/)
    assert.match(compiled.outputs.get('editors/shared/graph-layout.js') ?? '', /from '\.\/dagre\.esm\.js'/)

    assert.deepEqual(compareEditorOutput(compiled.outputs, readCommittedEditorJavaScript()), [])
  })

  test('every compiled editor file is unminified ES module JavaScript under 1 MiB', async (t) => {
    const compiled = await withTooling(compileEditors)
    if (compiled === null) return t.skip(INSTALL_HINT)
    assert.ok(compiled.outputs.size > 0)
    for (const [path, text] of compiled.outputs) {
      assert.ok(new TextEncoder().encode(text).length < 1024 * 1024, `${path} is 1 MiB or more`)
      assert.ok(!/\brequire\(|\bmodule\.exports\b/.test(text), `${path} is not an ES module`)
      assert.match(text, /^(?:import|export) /m, `${path} has no ES module import or export`)
      const longest = Math.max(...text.split('\n').map((line) => line.length))
      assert.ok(longest <= 400, `${path} has a line of ${longest} characters, as minified code would`)
    }
    // Comments survive, so the copied builder logic reads as upstream wrote it.
    assert.match(compiled.outputs.get('editors/builder/archon/model/from-workflow.js') ?? '', /\/\*\* Convert a single wire node/)
  })
})
