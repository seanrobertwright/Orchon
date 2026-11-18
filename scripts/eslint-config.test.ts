// The lint gate's rules, driven through ESLint's own API with the repository's config file:
// the module bans, unused code as errors and the accessibility rules for the editors' HTML.
import { createRequire } from 'node:module'
import { describe, test, type TestContext } from 'node:test'
import { assert } from 'orca/testing'
import { repoRoot } from './repo-files.ts'
import { INSTALL_HINT, isModuleNotFound, MissingTooling, withTooling } from './tooling.ts'

type Linter = InstanceType<typeof import('eslint').ESLint>

/** ESLint, loaded through Node's require: Orca's test loader refuses packages imported by name. */
function loadLinter(): Linter {
  try {
    const { ESLint } = createRequire(import.meta.url)('eslint') as typeof import('eslint')
    return new ESLint({ cwd: repoRoot })
  } catch (error) {
    if (isModuleNotFound(error)) throw new MissingTooling('ESLint is not installed. Run: npm ci')
    throw error
  }
}

let linter: Linter | null | undefined

/** The linter, or undefined after skipping the test because the tooling is not installed. */
async function linterOrSkip(t: TestContext): Promise<Linter | undefined> {
  if (linter === undefined) linter = await withTooling(loadLinter)
  if (linter === null) {
    t.skip(INSTALL_HINT)
    return undefined
  }
  return linter
}

/** The rules that fail `code` as an error when it is the content of `path`. */
async function errorsIn(eslint: Linter, path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path })
  assert.ok(result, `${path} is not linted`)
  const fatal = result.messages.filter((message) => message.fatal === true)
  assert.deepEqual(fatal, [])
  return [...new Set(result.messages.filter((m) => m.severity === 2).map((m) => String(m.ruleId)))]
}

const BANNED_EVERYWHERE = ['child_process', 'net', 'http', 'https', 'tls', 'dgram', 'worker_threads']
const SHIPPED = ['src/worker.ts', 'src/panel.tsx', 'src/client.ts', 'src/disk.ts', 'editors/shared/graph.ts']
const TOOLING = ['scripts/record-fixtures.ts', 'src/worker.test.ts', 'src/panel.test.tsx']
const use = (name: string): string => `\nexport const used = ${name}\n`

describe('the lint config', () => {
  test('bans the process and network modules in every file', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of [...SHIPPED, ...TOOLING]) {
      for (const name of BANNED_EVERYWHERE) {
        for (const specifier of [`node:${name}`, name]) {
          assert.deepEqual(
            await errorsIn(eslint, path, `import * as banned from '${specifier}'${use('banned')}`),
            ['no-restricted-imports'],
            `${specifier} in ${path}`
          )
          assert.deepEqual(
            await errorsIn(eslint, path, `export const banned = import('${specifier}')\n`),
            ['no-restricted-syntax'],
            `import('${specifier}') in ${path}`
          )
        }
      }
    }
  })

  test('lets only the disk module import node:fs among the files Orca loads', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const specifier of ['node:fs', 'fs', 'node:fs/promises', 'fs/promises']) {
      const code = `import * as disk from '${specifier}'${use('disk')}`
      for (const path of SHIPPED.filter((file) => file !== 'src/disk.ts')) {
        assert.deepEqual(await errorsIn(eslint, path, code), ['no-restricted-imports'], `${specifier} in ${path}`)
        assert.deepEqual(
          await errorsIn(eslint, path, `export const disk = import('${specifier}')\n`),
          ['no-restricted-syntax'],
          `import('${specifier}') in ${path}`
        )
      }
      for (const path of ['src/disk.ts', ...TOOLING]) {
        assert.deepEqual(await errorsIn(eslint, path, code), [], `${specifier} in ${path}`)
      }
    }
  })

  test('lets only the client module call fetch', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    const calls = {
      "export const answer = fetch('http://127.0.0.1:3090/api/health')\n": 'no-restricted-globals',
      "export const answer = globalThis.fetch('http://127.0.0.1:3090/api/health')\n": 'no-restricted-properties',
      "export const answer = window.fetch('http://127.0.0.1:3090/api/health')\n": 'no-restricted-properties',
      'export const send = fetch\n': 'no-restricted-globals'
    }
    for (const [code, rule] of Object.entries(calls)) {
      for (const path of [...SHIPPED.filter((file) => file !== 'src/client.ts'), ...TOOLING]) {
        assert.deepEqual(await errorsIn(eslint, path, code), [rule], `${code.trim()} in ${path}`)
      }
      assert.deepEqual(await errorsIn(eslint, 'src/client.ts', code), [], `${code.trim()} in the client`)
    }
  })

  test('bans eval, new Function and an import() whose target is not a literal', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    const cases = {
      "export const value = eval('1 + 1')\n": 'no-eval',
      "export const value = globalThis.eval('1 + 1')\n": 'no-eval',
      "export const make = new Function('return 1')\n": 'no-new-func',
      "export const make = Function('return 1')\n": 'no-new-func',
      "export const timer = setTimeout('tick()', 10)\n": 'no-implied-eval',
      'export const load = (name: string) => import(name)\n': 'no-restricted-syntax',
      'export const load = (name: string) => import(`./${name}.ts`)\n': 'no-restricted-syntax'
    }
    for (const [code, rule] of Object.entries(cases)) {
      for (const path of [...SHIPPED, ...TOOLING]) {
        assert.deepEqual(await errorsIn(eslint, path, code), [rule], `${code.trim()} in ${path}`)
      }
    }
    assert.deepEqual(
      await errorsIn(eslint, 'src/worker.ts', "export const load = () => import('./sections.ts')\n"),
      []
    )
  })

  test('closes the other ways to reach a banned module', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of SHIPPED) {
      assert.deepEqual(
        await errorsIn(eslint, path, "export const net = process.getBuiltinModule('node:net')\n"),
        ['no-restricted-properties'],
        path
      )
      assert.deepEqual(
        await errorsIn(eslint, path, "import { createRequire } from 'node:module'\nexport const load = createRequire\n"),
        ['no-restricted-imports'],
        path
      )
    }
  })

  test('treats unused code as an error', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    const cases = {
      'const unused = 1\nexport {}\n': '@typescript-eslint/no-unused-vars',
      "import { join } from 'node:path'\nexport {}\n": '@typescript-eslint/no-unused-vars',
      'export function f(value: number): number {\n  return 1\n}\n': '@typescript-eslint/no-unused-vars',
      'export function f(): number {\n  return 1\n  console.log(2)\n}\n': 'no-unreachable',
      'export function f(value: number): void {\n  value + 1\n}\n': '@typescript-eslint/no-unused-expressions',
      'export class Box {\n  #spare = 1\n}\n': 'no-unused-private-class-members',
      '// eslint-disable-next-line no-eval\nexport const value = 1\n': 'null'
    }
    for (const [code, rule] of Object.entries(cases)) {
      for (const path of ['src/worker.ts', 'src/panel.tsx', 'editors/shared/graph.ts', 'scripts/tool.ts']) {
        assert.deepEqual(await errorsIn(eslint, path, code), [rule], `${code.trim()} in ${path}`)
      }
    }
  })

  test('applies accessibility rules to the editors HTML', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    const page = (body: string, lang = ' lang="en"'): string =>
      `<!doctype html>\n<html${lang}>\n  <head>\n    <meta charset="utf-8" />\n    <title>Orchon</title>\n  </head>\n  <body>\n    ${body}\n  </body>\n</html>\n`
    const cases: [string, string[]][] = [
      [page('<h1>Graph</h1>', ''), ['@html-eslint/require-lang']],
      [page('<img src="./a.png" />'), ['@html-eslint/require-img-alt']],
      [page('<button>Fit</button>'), ['@html-eslint/require-button-type']],
      [page('<input id="filter" type="text" />'), ['@html-eslint/require-input-label']],
      [page('<button type="button" tabindex="3">Fit</button>'), ['@html-eslint/no-positive-tabindex']],
      [page('<div role="widget">Fit</div>'), ['@html-eslint/no-abstract-roles', '@html-eslint/no-invalid-role']],
      [page('<div role="banana">Fit</div>'), ['@html-eslint/no-invalid-role']],
      [page('<button type="button" aria-hidden="true">Fit</button>'), ['@html-eslint/no-aria-hidden-on-focusable']],
      [page('<a href="./a.html"><button type="button">Fit</button></a>'), ['@html-eslint/no-nested-interactive']],
      [page('<h1></h1>'), ['@html-eslint/no-empty-headings']],
      [page('<h1>Graph</h1><h3>Steps</h3>'), ['@html-eslint/no-skip-heading-levels']],
      [page('<p id="a">One</p><p id="a">Two</p>'), ['@html-eslint/no-duplicate-id']],
      [page('<iframe src="./a.html"></iframe>'), ['@html-eslint/require-frame-title']]
    ]
    for (const [code, rules] of cases) {
      assert.deepEqual(await errorsIn(eslint, 'editors/run-graph/index.html', code), rules, rules.join(', '))
    }
    assert.deepEqual(
      await errorsIn(
        eslint,
        'editors/run-graph/index.html',
        page('<main><h1>Graph</h1><label for="filter">Filter</label><input id="filter" type="text" /></main>')
      ),
      []
    )
  })

  test('downgrades no rule to a warning', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of [...SHIPPED, ...TOOLING, 'editors/run-graph/index.html', 'eslint.config.cjs']) {
      const config = (await eslint.calculateConfigForFile(path)) as { rules?: Record<string, unknown[]> }
      const rules = Object.entries(config.rules ?? {})
      assert.ok(rules.length > 0, `${path} has no rules`)
      const warnings = rules.filter(([, setting]) => setting[0] === 1 || setting[0] === 'warn')
      assert.deepEqual(warnings.map(([name]) => name), [], path)
    }
  })

  test('skips the folders no gate reads', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of ['.lril/state/tool.ts', 'node_modules/pkg/index.js', '.orca/types/orca/index.d.ts']) {
      assert.equal(await eslint.isPathIgnored(path), true, path)
    }
    assert.equal(await eslint.isPathIgnored('src/worker.ts'), false)
  })
})
