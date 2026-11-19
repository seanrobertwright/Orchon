// Pure logic: the local-and-writable test of #25 and the path and remote normalising of #6, with
// no host and no network. The rows come from fixtures/workspace-rows.json, whose answers are
// written from the table of #25.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import { isSameOrInside, localAndWritable, normaliseRemote, originUrl, samePath } from './workspaces'

interface RowFixture {
  name: string
  platform: string
  localAndWritable: boolean
  row: { path: string; hostId: string | null }
}

const rows = (JSON.parse(readRepoText('fixtures/workspace-rows.json')) as { rows: RowFixture[] }).rows

describe('the local-and-writable test', () => {
  test('gives the answer written for every row shape on Windows', () => {
    for (const fixture of rows) {
      assert.equal(localAndWritable(fixture.row, 'win32'), fixture.localAndWritable, fixture.name)
    }
  })

  test('gives a row marked for every platform the same answer elsewhere, and a WSL share passes off Windows', () => {
    for (const fixture of rows) {
      const expected = fixture.platform === 'any' ? fixture.localAndWritable : fixture.row.hostId === 'local'
      assert.equal(localAndWritable(fixture.row, 'linux'), expected, fixture.name)
    }
  })
})

describe('path normalising', () => {
  test('the same folder in both slash directions, any drive-letter case and a trailing separator is the same', () => {
    assert.ok(samePath('C:\\Projects\\App\\', 'c:/projects/app'))
    assert.ok(samePath('C:/Users/ada/.archon/workspaces/x', String.raw`C:\Users\ada\.archon\workspaces\x`))
  })

  test('POSIX paths compare with case, Windows paths without', () => {
    assert.ok(!samePath('/home/ada/App', '/home/ada/app'))
    assert.ok(samePath('/home/ada/app/', '/home/ada/app'))
    assert.ok(samePath(String.raw`\\server\Share\x`, '//server/share/x'))
  })

  test('a folder is inside itself and its own subfolders, never inside a sibling with a longer name', () => {
    assert.ok(isSameOrInside(String.raw`C:\Projects\app`, 'C:/Projects/app'))
    assert.ok(isSameOrInside('C:/Projects/app/packages/web', 'c:\\projects\\APP\\'))
    assert.ok(!isSameOrInside('C:/Projects/app-two', 'C:/Projects/app'))
    assert.ok(!isSameOrInside('C:/Projects', 'C:/Projects/app'))
    assert.ok(isSameOrInside('/home/ada/app/src', '/home/ada/app'))
    assert.ok(isSameOrInside('/anything', '/'))
  })

  test('an empty path is never the same as or inside anything', () => {
    assert.ok(!samePath('', ''))
    assert.ok(!isSameOrInside('', '/home'))
  })
})

describe("reading origin from a repository's Git config", () => {
  test('takes the url of the origin remote, not of another remote or section', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\turl = https://example.com/not-a-remote',
      '[remote "upstream"]',
      '\turl = https://github.com/other/web.git',
      '[remote "origin"]',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '\turl = git@github.com:acme/web.git',
      '[branch "main"]',
      '\tremote = origin'
    ].join('\r\n')
    assert.equal(originUrl(config), 'git@github.com:acme/web.git')
  })

  test('reads a key in any case, with spaces around the sign, a quoted value and a comment after it', () => {
    assert.equal(originUrl('[remote "origin"]\n  URL=  "https://github.com/acme/web"  ; mirror\n'), 'https://github.com/acme/web')
    assert.equal(originUrl('[remote "origin"]\n\turl = https://github.com/acme/web # note\n'), 'https://github.com/acme/web')
  })

  test('is null with no origin, an origin without a url, or an empty url', () => {
    assert.equal(originUrl(''), null)
    assert.equal(originUrl('[remote "upstream"]\n\turl = https://github.com/acme/web\n'), null)
    assert.equal(originUrl('[remote "origin"]\n\tfetch = +refs/heads/*\n[core]\n\turl = x\n'), null)
    assert.equal(originUrl('[remote "origin"]\n\turl =\n'), null)
  })
})

describe('remote normalising', () => {
  test('the SSH and HTTPS forms, with or without .git and in any case, are the same', () => {
    const forms = [
      'https://github.com/Acme/Web.git',
      'https://github.com/acme/web',
      'git@github.com:acme/web.git',
      'ssh://git@github.com/acme/web.git',
      'https://someone@github.com/acme/web/',
      'git+ssh://git@GitHub.com/acme/web'
    ]
    for (const form of forms) assert.equal(normaliseRemote(form), 'github.com/acme/web', form)
  })

  test('a different host, owner or repository is different, and what does not parse is null', () => {
    assert.notEqual(normaliseRemote('git@gitlab.com:acme/web.git'), normaliseRemote('git@github.com:acme/web.git'))
    assert.notEqual(normaliseRemote('https://github.com/acme/api'), normaliseRemote('https://github.com/acme/web'))
    assert.equal(normaliseRemote(''), null)
    assert.equal(normaliseRemote('   '), null)
    assert.equal(normaliseRemote('not a remote'), null)
  })
})
