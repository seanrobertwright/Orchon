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

interface Step {
  /** The step's lines, its first line included. */
  lines: string[]
  /** The single-line command it runs, when it has one. */
  run?: string
  /** Its `if:` condition, when it has one. */
  if?: string
}

/** The steps of the workflow's one job, in order. */
function steps(): Step[] {
  const found: Step[] = []
  for (const line of workflow.split('\n')) {
    if (line.startsWith('      - ')) found.push({ lines: [] })
    const step = found.at(-1)
    if (step === undefined || !(line.startsWith('      - ') || line.startsWith('        '))) continue
    step.lines.push(line)
    const run = /^ {6}(?:- | {2})run: (.+)$/.exec(line)?.[1]
    if (run !== undefined && run !== '|') step.run = run
    const condition = /^ {6}(?:- | {2})if: (.+)$/.exec(line)?.[1]
    if (condition !== undefined) step.if = condition
  }
  return found
}

/** The one step whose text matches the pattern. */
function stepMatching(pattern: RegExp): Step {
  const matching = steps().filter((step) => pattern.test(step.lines.join('\n')))
  assert.equal(matching.length, 1, `${matching.length} steps match ${pattern}`)
  return matching[0] as Step
}

/** A pattern for the step that runs exactly this one-line command. */
function runs(command: string): RegExp {
  return new RegExp(`^ {6}(?:- | {2})run: ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
}

// Found by running each gate in a checkout with no .orca folder: these fail there, for lack of
// Orca's CLI or of the typings `orca plugin types .` writes. Every other gate passes without Orca.
const needOrca = [
  'orca plugin types .',
  'npm run typecheck',
  'npm run check:editors',
  'orca plugin test .',
  'orca plugin check .',
  'orca plugin validate .'
]
const needNoOrca = [
  'npm ci --ignore-scripts',
  'npm run check:tracked',
  'npm run lint',
  'npm run lint:md',
  'npm run check:limits'
]

// The conditions a step carries to run only with Orca, or only without it.
const whenOrcaInstalled = "steps.orca.outcome == 'success'"
const whenOrcaMissing = "steps.orca.outcome == 'failure'"

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

  test('a failed Orca download does not fail the job, and nothing else may fail without failing it', () => {
    const download = stepMatching(/gh release download/)
    assert.ok(download.lines.includes('        id: orca'), 'the download step has no id the gates can read')
    assert.ok(download.lines.includes('        continue-on-error: true'), 'a failed download fails the job')
    assert.equal(workflow.match(/continue-on-error/g)?.length, 1, 'a step other than the download may fail')
  })

  test('each gate that needs Orca runs only when the download succeeded', () => {
    for (const gate of needOrca) {
      assert.equal(stepMatching(runs(gate)).if, whenOrcaInstalled, `"${gate}" runs without Orca`)
    }
  })

  test('each gate that needs no Orca runs whether or not the download succeeded', () => {
    for (const gate of needNoOrca) {
      assert.equal(stepMatching(runs(gate)).if, undefined, `"${gate}" is skipped on a condition`)
    }
    for (const command of steps().flatMap((step) => step.run ?? [])) {
      assert.ok(needOrca.includes(command) || needNoOrca.includes(command), `"${command}" is in neither list`)
    }
  })

  test('when the download failed, a warning and the job summary name each skipped gate and why', () => {
    const report = stepMatching(/::warning/)
    assert.equal(report.if, whenOrcaMissing)
    const text = report.lines.join('\n')
    assert.match(text, /^ {10}echo "::warning title=[^"]+::[^"]+"$/m)
    assert.match(text, />> "\$GITHUB_STEP_SUMMARY"/)
    assert.match(text, /could not be downloaded/)
    for (const gate of needOrca) assert.ok(text.includes(`\`${gate}\``), `the summary does not name "${gate}"`)
    const texts = steps().map((step) => step.lines.join('\n'))
    const download = texts.findIndex((step) => step.includes('gh release download'))
    assert.equal(texts.indexOf(text), download + 1, 'a failing gate could stop the report')
  })

  test('compares the approval surface with the last released tag, whether or not Orca was downloaded', () => {
    const checkout = stepMatching(/uses: actions\/checkout@/)
    assert.ok(checkout.lines.includes('          fetch-depth: 0'), 'the checkout has no tags to compare with')
    const surface = stepMatching(/check-approval-surface/)
    assert.equal(surface.if, undefined, 'the approval-surface check is skipped on a condition')
    const text = surface.lines.join('\n')
    assert.match(text, /^ {10}set -euo pipefail$/m)
    assert.match(text, /^ {10}tag=\$\(git tag --list 'v\*' --sort=-v:refname \| head -n 1\)$/m)
    assert.match(text, /^ {12}node scripts\/check-approval-surface\.ts$/m)
    assert.match(text, /^ {12}git show "\$tag:orca-plugin\.json" \| node scripts\/check-approval-surface\.ts --tag "\$tag"$/m)
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
