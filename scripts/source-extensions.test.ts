// One list of code extensions, scripts/source-extensions.json, feeds every gate. The lint config
// and the scripts read it; tsconfig.json cannot, so this test fails when the two disagree.
import { assert, describe, test } from 'orca/testing'
import { CODE_EXTENSIONS, hasExtension, readRepoText, SOURCE_EXTENSIONS } from './repo-files.ts'

describe('the code extensions the gates share', () => {
  test('every file Orca transpiles is code, so the lint gate reads it', () => {
    for (const extension of SOURCE_EXTENSIONS.transpiled) {
      assert.ok(CODE_EXTENSIONS.includes(extension), `.${extension} is transpiled but not linted`)
    }
  })

  test('no extension is listed twice', () => {
    assert.equal(new Set(CODE_EXTENSIONS).size, CODE_EXTENSIONS.length)
    assert.equal(new Set(SOURCE_EXTENSIONS.transpiled).size, SOURCE_EXTENSIONS.transpiled.length)
  })

  test('the type-check includes every TypeScript extension and no other file', () => {
    const tsconfig = JSON.parse(readRepoText('tsconfig.json')) as { include: string[] }
    assert.deepEqual(
      tsconfig.include,
      SOURCE_EXTENSIONS.typescript.map((extension) => `**/*.${extension}`)
    )
  })

  test('the lint config reads the same list', () => {
    const config = readRepoText('eslint.config.cjs')
    assert.match(config, /require\('\.\/scripts\/source-extensions\.json'\)/)
    assert.match(config, /\[\.\.\.extensions\.typescript, \.\.\.extensions\.javascript\]/)
  })

  test('an extension is matched after the last dot only', () => {
    assert.equal(hasExtension('src/panel.tsx', ['tsx']), true)
    assert.equal(hasExtension('src/panel.test.tsx', ['tsx']), true)
    assert.equal(hasExtension('src/tsx', ['tsx']), false)
    assert.equal(hasExtension('src/panel.tsx.bak', ['tsx']), false)
    assert.equal(hasExtension('src/panel.ts', ['tsx']), false)
  })
})
