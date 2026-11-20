// The release documents: the live Orca checklist the owner signs off, and the changelog.
import { assert, describe, test } from 'orca/testing'
import { markdownSection, readRepoText } from './repo-files.ts'

describe('the release documents', () => {
  test('the live Orca checklist covers each live check of #33 and leaves a sign-off for the owner', () => {
    const checklist = readRepoText('docs/live-checklist.md')
    const items = [
      'an open editor tab',
      'a hidden panel',
      "a hidden panel's timers",
      'focus after an inline confirmation',
      '`RadioGroup` option descriptions',
      '`expectedGate`',
      '409',
      'non-empty attention answer',
      '`PATCH /api/config/*`',
      '`/api/auth/*`',
      'metrics query',
      "the command's returned sentence",
      "the status bar's text length",
      'notification',
      '`Code` block',
      "Archon's restart time",
      'home folder first exists',
      '`unavailable`',
      'SSH',
      'WSL',
      'light theme',
      'keyboard',
      '220 px',
      'status bar item',
      '`orca plugin validate`',
      'update rules'
    ]
    for (const item of items) assert.ok(checklist.toLowerCase().includes(item.toLowerCase()), `the checklist does not name ${item}`)
    assert.ok(!/- \[x\]/i.test(checklist), 'a check is ticked: the owner ticks them')
    assert.match(checklist, /^Signed off by: *$/m)
  })

  test("the changelog has a section for the manifest's version", () => {
    const { version } = JSON.parse(readRepoText('orca-plugin.json')) as { version: string }
    const changelog = readRepoText('CHANGELOG.md')
    assert.match(changelog, /^# Changelog$/m)
    assert.ok(markdownSection(changelog, `## ${version}`) !== null, `CHANGELOG.md has no "## ${version}"`)
  })
})
