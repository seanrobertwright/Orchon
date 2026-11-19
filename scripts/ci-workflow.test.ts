// The CI workflow's triggers, permissions and gates, read from the workflow file's text.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from './repo-files.ts'

const workflow = readRepoText('.github/workflows/ci.yml')
const scripts = (JSON.parse(readRepoText('package.json')) as { scripts: Record<string, string> }).scripts

/** The lines of one top-level key of the workflow, without the key's own line. */
function topLevelBlock(key: string): string[] {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `))
  assert.ok(start !== -1, `the workflow has no top-level "${key}"`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^\S/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== '')
}

describe('the CI workflow', () => {
  test('runs on every pull request and on a push to main', () => {
    assert.deepEqual(topLevelBlock('on'), ['  pull_request:', '  push:', '    branches: [main]'])
  })

  test('asks for read access to the repository contents and nothing else', () => {
    assert.deepEqual(topLevelBlock('permissions'), ['  contents: read'])
    assert.equal(workflow.match(/permissions:/g)?.length, 1, 'a job sets permissions of its own')
    assert.ok(!/id-token|secrets\./.test(workflow))
    assert.match(workflow, /persist-credentials: false/)
  })

  test('runs every gate', () => {
    const gates = [
      'npm run check:tracked',
      'orca plugin types .',
      'npm run typecheck',
      'npm run check:editors',
      'npm run lint',
      'npm run lint:md',
      'orca plugin test .',
      'orca plugin check .',
      'orca plugin validate .',
      'npm run check:limits'
    ]
    const steps = workflow
      .split('\n')
      .map((line) => /^\s+(?:- )?run: (.+)$/.exec(line)?.[1])
      .filter((command) => command !== undefined)
    for (const gate of gates) assert.ok(steps.includes(gate), `no step runs "${gate}"`)
  })

  test('installs the latest Orca release, so validate runs on the latest Orca', () => {
    assert.match(workflow, /gh release download --repo stablyai\/orca /)
    assert.ok(!/gh release download [^\n]*\bv?\d+\.\d+\.\d+/.test(workflow), 'the Orca release is pinned')
  })

  test('the gates behind npm scripts are the ones this repository defines', () => {
    assert.equal(scripts.typecheck, 'tsc --noEmit -p tsconfig.json')
    assert.equal(scripts['check:editors'], 'node scripts/check-editor-output.ts')
    assert.equal(scripts.lint, 'eslint .')
    assert.equal(scripts['lint:md'], 'markdownlint-cli2')
    assert.equal(scripts['check:limits'], 'node scripts/check-install-limits.ts')
    assert.equal(scripts['check:tracked'], 'git ls-files -z | node scripts/check-tracked-files.ts')
  })

  test('markdownlint reads every Markdown file outside the folders no gate reads', () => {
    const config = JSON.parse(readRepoText('.markdownlint-cli2.jsonc')) as {
      globs: string[]
      ignores: string[]
      gitignore?: boolean
    }
    assert.deepEqual(config.globs, ['**/*.md'])
    assert.deepEqual(config.ignores, ['**/node_modules/**', '.lril/**', '.orca/**'])
    assert.notEqual(config.gitignore, true)
  })

  test('the pre-commit hook runs the tracked-files check on the staged content', () => {
    const hook = readRepoText('.githooks/pre-commit')
    assert.match(hook, /^staged=\$\(mktemp -d\)$/m)
    assert.match(hook, /^git checkout-index --all --prefix="\$staged\/"$/m)
    assert.match(hook, /^git ls-files -z \| node scripts\/check-tracked-files\.ts --root "\$staged"$/m)
    assert.equal(scripts['hooks:install'], 'git config core.hooksPath .githooks')
  })
})
