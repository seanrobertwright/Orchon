// The lint gate's rules, driven through ESLint's own API with the repository's config file:
// the module bans, unused code as errors and the accessibility rules for the editors' HTML.
import { describe, test, type TestContext } from 'node:test'
import { assert } from 'orca/testing'
import { CODE_EXTENSIONS, hasExtension, repoRoot } from './repo-files.ts'
import { INSTALL_HINT, loadPackage, withTooling } from './tooling.ts'

type Linter = InstanceType<typeof import('eslint').ESLint>

function loadLinter(): Linter {
  const { ESLint } = loadPackage('eslint') as typeof import('eslint')
  return new ESLint({ cwd: repoRoot })
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

/** The rules that fail `code` as an error when it is the content of `path`, sorted by name. */
async function errorsIn(eslint: Linter, path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path })
  assert.ok(result, `${path} is not linted`)
  const fatal = result.messages.filter((message) => message.fatal === true)
  assert.deepEqual(fatal, [], `${path} does not parse: ${code}`)
  const rules = result.messages.filter((m) => m.severity === 2).map((m) => String(m.ruleId))
  return [...new Set(rules)].sort()
}

/** Asserts that `rule` fails `code` in `path`. A JavaScript file may fail other rules beside it. */
async function refused(eslint: Linter, path: string, code: string, rule: string): Promise<void> {
  const rules = await errorsIn(eslint, path, code)
  assert.ok(rules.includes(rule), `${rule} did not fail ${code.trim()} in ${path}: got [${rules.join(', ')}]`)
}

async function allowed(eslint: Linter, path: string, code: string): Promise<void> {
  assert.deepEqual(await errorsIn(eslint, path, code), [], `${code.trim()} in ${path}`)
}

const BANNED_EVERYWHERE = ['child_process', 'net', 'http', 'https', 'tls', 'dgram', 'worker_threads']

const CONFIG = 'eslint.config.cjs'
const DISK = 'src/disk.ts'
const CLIENT = 'src/client.ts'
const DATES = 'src/dates.ts'
const LOADER = 'scripts/tooling.ts'

/** Files Orca loads or the editors ship, with one of every code extension. */
const SHIPPED = [
  'src/worker.ts',
  'src/panel.tsx',
  CLIENT,
  DISK,
  DATES,
  'src/late.mts',
  'src/helper.cts',
  'src/helper.js',
  'src/view.jsx',
  'src/helper.mjs',
  'src/helper.cjs',
  'editors/shared/graph.ts',
  'editors/shared/vendor.mjs'
]
const TOOLING = [
  'scripts/record-fixtures.ts',
  LOADER,
  'src/worker.test.ts',
  'src/panel.test.tsx',
  'src/panel.check.ts',
  CONFIG
]
const EVERY_FILE = [...SHIPPED, ...TOOLING]

const isCommonJs = (path: string): boolean => path.endsWith('.cjs')

/** A statement that uses `expression`, so that nothing in it is unused. */
const keep = (path: string, expression: string): string =>
  isCommonJs(path) ? `module.exports = ${expression}\n` : `export const kept = ${expression}\n`

/** Each way a file at `path` can load `specifier`, with the rule that must refuse it. */
function waysToLoad(path: string, specifier: string): [code: string, rule: string][] {
  const ways: [string, string][] = [
    [keep(path, `import('${specifier}')`), 'no-restricted-syntax'],
    [`const loaded = require('${specifier}')\n${keep(path, 'loaded')}`, 'no-restricted-syntax']
  ]
  if (!isCommonJs(path)) {
    ways.push(
      [`import * as loaded from '${specifier}'\n${keep(path, 'loaded')}`, 'no-restricted-imports'],
      [`import loaded from '${specifier}'\n${keep(path, 'loaded')}`, 'no-restricted-imports'],
      [`export * from '${specifier}'\n`, 'no-restricted-imports']
    )
  }
  if (hasExtension(path, ['ts', 'tsx', 'mts', 'cts'])) {
    ways.push([`import loaded = require('${specifier}')\n${keep(path, 'loaded')}`, 'no-restricted-syntax'])
  }
  return ways
}

describe('the lint config', () => {
  test('the files tried here cover every code extension', () => {
    for (const extension of CODE_EXTENSIONS) {
      assert.ok(SHIPPED.some((path) => hasExtension(path, [extension])), `no .${extension} file is tried`)
    }
  })

  test('lints a file of every code extension, and no test file is left out', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of EVERY_FILE) {
      assert.equal(await eslint.isPathIgnored(path), false, path)
      const config = (await eslint.calculateConfigForFile(path)) as { rules?: Record<string, unknown> } | undefined
      assert.ok(config?.rules?.['no-restricted-imports'] !== undefined, `${path} has no module bans`)
      const unused = isCommonJs(path) ? 'const unused = 1\n' : 'const unused = 1\nexport {}\n'
      await refused(eslint, path, unused, '@typescript-eslint/no-unused-vars')
    }
  })

  test('bans the process and network modules in every file, however they are loaded', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of EVERY_FILE) {
      for (const name of BANNED_EVERYWHERE) {
        for (const specifier of [`node:${name}`, name]) {
          for (const [code, rule] of waysToLoad(path, specifier)) await refused(eslint, path, code, rule)
        }
      }
    }
  })

  test('lets only the disk module, the gates and the tests load node:fs', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const specifier of ['node:fs', 'fs', 'node:fs/promises', 'fs/promises']) {
      for (const path of SHIPPED.filter((file) => file !== DISK)) {
        for (const [code, rule] of waysToLoad(path, specifier)) await refused(eslint, path, code, rule)
      }
      for (const path of [DISK, ...TOOLING.filter((file) => file !== CONFIG)]) {
        await allowed(eslint, path, `import * as disk from '${specifier}'\n${keep(path, 'disk')}`)
        await allowed(eslint, path, keep(path, `import('${specifier}')`))
      }
      await allowed(eslint, CONFIG, `const disk = require('${specifier}')\n${keep(CONFIG, 'disk')}`)
    }
  })

  test('lets require() into the lint config alone', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of EVERY_FILE.filter((file) => file !== CONFIG)) {
      const code = `const other = require('./other.cjs')\n${keep(path, 'other')}`
      await refused(eslint, path, code, '@typescript-eslint/no-require-imports')
    }
    await allowed(eslint, CONFIG, `const other = require('./other.cjs')\n${keep(CONFIG, 'other')}`)
    for (const path of EVERY_FILE) {
      const code = `const load = (name) => require(name)\n${keep(path, 'load')}`
      await refused(eslint, path, code, 'no-restricted-syntax')
    }
  })

  test('lets only the tooling loader reach node:module, and nothing reach process.getBuiltinModule', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of EVERY_FILE) {
      await refused(
        eslint,
        path,
        keep(path, "process.getBuiltinModule('node:child_process')"),
        'no-restricted-properties'
      )
      if (path === LOADER) continue
      for (const specifier of ['node:module', 'module']) {
        for (const [code, rule] of waysToLoad(path, specifier)) await refused(eslint, path, code, rule)
        if (isCommonJs(path)) continue
        const named = `import { createRequire } from '${specifier}'\n${keep(path, 'createRequire')}`
        await refused(eslint, path, named, 'no-restricted-imports')
        const viaDefault = `import loader from '${specifier}'\n${keep(path, 'loader.createRequire')}`
        await refused(eslint, path, viaDefault, 'no-restricted-imports')
      }
    }
    await allowed(
      eslint,
      LOADER,
      "import { createRequire } from 'node:module'\nexport const load = createRequire(import.meta.url)\n"
    )
  })

  test('lets only the client module use fetch', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    const uses: [expression: string, rule: string][] = [
      ["fetch('http://127.0.0.1:3090/api/health')", 'no-restricted-globals'],
      ["globalThis.fetch('http://127.0.0.1:3090/api/health')", 'no-restricted-properties'],
      ["window.fetch('http://127.0.0.1:3090/api/health')", 'no-restricted-properties'],
      ['fetch', 'no-restricted-globals']
    ]
    for (const [expression, rule] of uses) {
      for (const path of EVERY_FILE.filter((file) => file !== CLIENT)) {
        await refused(eslint, path, keep(path, expression), rule)
      }
      await allowed(eslint, CLIENT, keep(CLIENT, expression))
    }
  })

  test('lets only the date helper, among the files Orca loads, read the clock or parse or format a date', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    const uses: [expression: string, rule: string][] = [
      ['Date.now()', 'no-restricted-globals'],
      ["new Date('2026-11-18T10:00:00Z')", 'no-restricted-globals'],
      ["Date.parse('2026-11-18T10:00:00Z')", 'no-restricted-globals'],
      ['Date.UTC(2026, 10, 18)', 'no-restricted-globals'],
      ['Date', 'no-restricted-globals'],
      ['globalThis.Date.now()', 'no-restricted-properties'],
      ['new window.Date()', 'no-restricted-properties'],
      ["new Intl.DateTimeFormat('en-GB')", 'no-restricted-properties'],
      ["new globalThis.Intl.DateTimeFormat('en-GB')", 'no-restricted-properties']
    ]
    assert.ok(SHIPPED.includes(DATES), `${DATES} is not among the shipped files tried`)
    for (const [expression, rule] of uses) {
      for (const path of SHIPPED.filter((file) => file !== DATES)) {
        await refused(eslint, path, keep(path, expression), rule)
      }
      for (const path of [DATES, ...TOOLING]) await allowed(eslint, path, keep(path, expression))
    }
    // The helper is let past the date ban alone, and the client past the fetch ban alone.
    await refused(eslint, DATES, keep(DATES, "fetch('http://127.0.0.1:3090/api/health')"), 'no-restricted-globals')
    await refused(eslint, CLIENT, keep(CLIENT, 'Date.now()'), 'no-restricted-globals')
    for (const path of [DATES, CLIENT, ...TOOLING]) {
      await refused(eslint, path, keep(path, "process.getBuiltinModule('node:fs')"), 'no-restricted-properties')
    }
  })

  test('bans eval, new Function and an import() whose target is not a literal', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    const cases: [expression: string, rule: string][] = [
      ["eval('1 + 1')", 'no-eval'],
      ["globalThis.eval('1 + 1')", 'no-eval'],
      ["new Function('return 1')", 'no-new-func'],
      ["Function('return 1')", 'no-new-func'],
      ["setTimeout('tick()', 10)", 'no-implied-eval'],
      ['(name) => import(name)', 'no-restricted-syntax'],
      ['(name) => import(`./${name}.ts`)', 'no-restricted-syntax']
    ]
    for (const [expression, rule] of cases) {
      for (const path of EVERY_FILE) await refused(eslint, path, keep(path, expression), rule)
    }
    await allowed(eslint, 'src/worker.ts', "export const load = () => import('./sections.ts')\n")
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
    await allowed(
      eslint,
      'editors/run-graph/index.html',
      page('<main><h1>Graph</h1><label for="filter">Filter</label><input id="filter" type="text" /></main>')
    )
  })

  test('downgrades no rule to a warning', async (t) => {
    const eslint = await linterOrSkip(t)
    if (eslint === undefined) return
    for (const path of [...EVERY_FILE, 'editors/run-graph/index.html']) {
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
