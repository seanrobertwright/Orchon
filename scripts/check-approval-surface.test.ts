// The frozen approval surface, driven through the function the command line uses: the manifest
// of the last released tag against the manifest and changelog of this tree.
import { assert, describe, test } from 'orca/testing'
import { checkApprovalSurface, parseTagArgument } from './check-approval-surface.ts'
import { readRepoText } from './repo-files.ts'

const manifestText = readRepoText('orca-plugin.json')

/** This repository's manifest with its version set and, when given, one change made to it. */
function manifest(version: string, change?: (parsed: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(manifestText) as Record<string, unknown>
  parsed['version'] = version
  change?.(parsed)
  return JSON.stringify(parsed)
}

/** The release v0.1.0, tagged on this repository's manifest. */
const RELEASED = { tag: 'v0.1.0', manifest: manifest('0.1.0') }

/** This repository's manifest at `version`, asking for one capability more than it does. */
function withNewCapability(version: string): string {
  return manifest(version, (parsed) => {
    ;(parsed['capabilities'] as unknown[]).push({ kind: 'secrets:own' })
  })
}

describe('the approval-surface check', () => {
  test('passes when no release has been tagged yet', () => {
    assert.deepEqual(checkApprovalSurface({ released: null, manifest: manifestText, changelog: '' }), [])
  })

  test('fails a new capability when only the patch number rises', () => {
    const current = withNewCapability('0.1.1')
    assert.deepEqual(
      checkApprovalSurface({ released: RELEASED, manifest: current, changelog: '' }),
      [
        'The approval surface differs from v0.1.0 in: capabilities.',
        'A change to the approval surface needs a higher minor version than 0.1.0; this tree is 0.1.1.',
        'CHANGELOG.md has no "Asks you to approve again" entry under 0.1.1.'
      ]
    )
  })

  test('passes a new capability in a higher minor version whose changelog asks you to approve again', () => {
    const current = withNewCapability('0.2.0')
    assert.deepEqual(
      checkApprovalSurface({ released: RELEASED, manifest: current, changelog: ASKS_AGAIN }),
      []
    )
    assert.deepEqual(
      checkApprovalSurface({ released: RELEASED, manifest: current, changelog: ASKS_AGAIN.replaceAll('\n', '\r\n') }),
      [],
      'a changelog with CRLF line endings'
    )
  })

  test('fails a higher minor version whose changelog does not ask you to approve again', () => {
    const current = withNewCapability('0.2.0')
    const changelogs = [
      '# Changelog\n\n## 0.2.0\n\n- Something new.\n',
      '# Changelog\n\n## 0.2.0\n\n### Asks you to approve again\n\n## 0.1.0\n\n- First release.\n',
      '# Changelog\n\n## 0.3.0\n\n### Asks you to approve again\n\n- Stores secrets.\n'
    ]
    for (const changelog of changelogs) {
      assert.deepEqual(
        checkApprovalSurface({ released: RELEASED, manifest: current, changelog }),
        [
          'The approval surface differs from v0.1.0 in: capabilities.',
          'CHANGELOG.md has no "Asks you to approve again" entry under 0.2.0.'
        ],
        changelog
      )
    }
  })

  test('fails a changelog entry that asks you to approve again when the minor version has not risen', () => {
    const current = withNewCapability('0.1.1')
    const changelog = ASKS_AGAIN.replace('## 0.2.0', '## 0.1.1')
    assert.deepEqual(checkApprovalSurface({ released: RELEASED, manifest: current, changelog }), [
      'The approval surface differs from v0.1.0 in: capabilities.',
      'A change to the approval surface needs a higher minor version than 0.1.0; this tree is 0.1.1.'
    ])
  })

  test('passes a patch release that leaves the surface as it was, whatever order the manifest writes it in', () => {
    const current = manifest('0.1.1', (parsed) => {
      ;(parsed['capabilities'] as unknown[]).reverse()
      parsed['description'] = 'Reworded.'
      const contributes = parsed['contributes'] as Record<string, unknown[]>
      const command = contributes['commands']?.[0] as Record<string, unknown>
      command['title'] = 'Orchon: Show the runs'
      const setting = contributes['settings']?.[0] as Record<string, unknown>
      contributes['settings']?.splice(0, 1, Object.fromEntries(Object.entries(setting).reverse()))
    })
    assert.deepEqual(checkApprovalSurface({ released: RELEASED, manifest: current, changelog: '' }), [])
  })

  test('counts each part of the surface #32 freezes, and the execution level', () => {
    const first = (parsed: Record<string, unknown>, kind: string): Record<string, unknown> =>
      ((parsed['contributes'] as Record<string, Record<string, unknown>[]>)[kind] ?? [])[0] ?? {}
    const changes: [string, (parsed: Record<string, unknown>) => void][] = [
      ['execution', (parsed) => void (parsed['execution'] = 'sandboxed')],
      ['panels', (parsed) => void (first(parsed, 'panels')['id'] = 'board')],
      ['commands', (parsed) => void (first(parsed, 'commands')['id'] = 'show')],
      ['events', (parsed) => void (first(parsed, 'events')['on'] = 'terminal.output')],
      ['customEditors', (parsed) => void (first(parsed, 'customEditors')['extensions'] = ['.orchongraph'])],
      ['statusBarItems', (parsed) => void (first(parsed, 'statusBarItems')['text'] = 'Archon')],
      ['settings', (parsed) => void (first(parsed, 'settings')['description'] = 'Reworded.')],
      ['shortcuts', (parsed) => void ((parsed['contributes'] as Record<string, unknown>)['shortcuts'] = [{ key: 'ctrl+o' }])]
    ]
    for (const [part, change] of changes) {
      const problems = checkApprovalSurface({ released: RELEASED, manifest: manifest('0.1.1', change), changelog: '' })
      assert.equal(problems[0], `The approval surface differs from v0.1.0 in: ${part}.`, part)
    }
  })

  test('refuses a manifest it cannot read, naming which', () => {
    const released = { tag: 'v0.1.0', manifest: '{"version": "0.1"}' }
    assert.deepEqual(checkApprovalSurface({ released, manifest: manifestText, changelog: '' }), [
      'The manifest of v0.1.0: "version" is not a version such as 0.1.0.'
    ])
    assert.deepEqual(checkApprovalSurface({ released: { tag: 'v0.1.0', manifest: manifestText }, manifest: 'not json', changelog: '' }), [
      'orca-plugin.json is not JSON.'
    ])
  })

  test('takes a release tag from the command line, or none', () => {
    assert.equal(parseTagArgument([]), null)
    assert.equal(parseTagArgument(['--tag', 'v0.1.0']), 'v0.1.0')
    assert.throws(() => parseTagArgument(['--tag', '']), /is not a release tag/)
    assert.throws(() => parseTagArgument(['--tag', 'v0.1']), /is not a release tag/)
    assert.throws(() => parseTagArgument(['--tag']), /Usage/)
    assert.throws(() => parseTagArgument(['v0.1.0']), /Usage/)
  })

  test("this tree's manifest and changelog pass against this tree's manifest as the released one", () => {
    const changelog = readRepoText('CHANGELOG.md')
    assert.deepEqual(checkApprovalSurface({ released: { tag: 'v0.1.0', manifest: manifestText }, manifest: manifestText, changelog }), [])
  })
})

const ASKS_AGAIN = `# Changelog

## 0.2.0

### Asks you to approve again

- Orchon now keeps a secret, so it asks for secrets:own.

## 0.1.0

- First release.
`
