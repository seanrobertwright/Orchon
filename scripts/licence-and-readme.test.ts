// The licence files and what the README must say about the projects Orchon works with.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from './repo-files.ts'

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
})
