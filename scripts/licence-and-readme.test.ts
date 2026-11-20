// The licence files and what the README must say about the projects Orchon works with.
import { assert, describe, test } from 'orca/testing'
import { markdownSection, readRepoText } from './repo-files.ts'

/** The worker's limits on itself, word for word as decided in #32 and copied into #33. */
const LIMITS_TABLE = `| Kind | The worker may |
| --- | --- |
| Network | Make HTTP requests to this machine's loopback address, redirects off. Nothing else. |
| Disk, read | \`server.json\` in the Archon home folder; whether that folder exists; a local workspace's Git config, to read its remote. |
| Disk, write | Create and delete only inside \`.orchon/\` at the root of a local workspace: pointer files with its two suffixes, and that folder's \`.gitignore\`. |
| Processes | Start none. |`

/** The README's section of this name, from its heading to the next heading of the same level. */
function readmeSection(heading: string): string {
  const section = markdownSection(readRepoText('README.md'), `## ${heading}`)
  assert.ok(section !== null, `the README has no section "${heading}"`)
  return section.join('\n')
}

describe('the licence files and the README', () => {
  test('LICENSE is the MIT licence with LRIL as the copyright holder', () => {
    const licence = readRepoText('LICENSE')
    assert.match(licence, /^MIT License\n/)
    assert.match(licence, /^Copyright \(c\) \d{4} LRIL$/m)
    assert.match(licence, /Permission is hereby granted, free of charge/)
  })

  test('THIRD_PARTY_NOTICES exists and is not empty', () => {
    assert.ok(readRepoText('THIRD_PARTY_NOTICES').trim().length > 0)
  })

  test('the README says the plugin is unofficial and links both upstream projects', () => {
    const readme = readRepoText('README.md')
    assert.match(readme, /^# Orchon$/m)
    assert.match(readme, /Unofficial; not made or endorsed by the Archon or Orca projects\./)
    assert.match(readme, /\[Archon\]\(https:\/\/github\.com\/coleam00\/Archon\)/)
    assert.match(readme, /\[Orca\]\(https:\/\/github\.com\/stablyai\/orca\)/)
  })

  test('the README names the licence files', () => {
    const readme = readRepoText('README.md')
    assert.match(readme, /\[LICENSE\]\(LICENSE\)/)
    assert.match(readme, /\[THIRD_PARTY_NOTICES\]\(THIRD_PARTY_NOTICES\)/)
  })

  test("the README section \"What Orchon does on your machine\" holds the worker's limits table word for word", () => {
    assert.ok(readmeSection('What Orchon does on your machine').includes(LIMITS_TABLE))
  })

  test('the README section names every capability the manifest declares, with what it is used for', () => {
    const manifest = JSON.parse(readRepoText('orca-plugin.json')) as { capabilities: { kind: string }[] }
    const section = readmeSection('What Orchon does on your machine')
    for (const { kind } of manifest.capabilities) {
      assert.ok(section.split('\n').some((line) => line.startsWith(`| \`${kind}\` | `) && line.length > kind.length + 10), kind)
    }
  })

  test('the README says the newest version is the supported one and points to the changelog', () => {
    const readme = readRepoText('README.md')
    assert.match(readme, /The newest version is the supported one\./)
    assert.match(readme, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/)
  })
})
