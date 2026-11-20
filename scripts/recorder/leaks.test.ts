// The leak check: what a fixture or a log may never hold, whatever the scrubber did, and the
// scrub of a string shaped like a login.
import { assert, describe, test } from 'orca/testing'
import { findLeaks } from './leaks.ts'
import { createScrubber, machineRules, PLACEHOLDERS } from './scrub.ts'
import { scrubTokens, TOKEN } from './tokens.ts'

// Shaped like the real thing, made up here: none of them was ever a credential.
const OAUTH = ['sk', 'ant', 'oat01', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg'].join('-')
const API_KEY = ['sk', 'ant', 'api03', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'].join('-')
const GITHUB = `${['gh', 'o'].join('')}_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJyZWNvcmRlciJ9', 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.')

const machine = {
  claudeConfig: 'C:\\Users\\dev\\.claude',
  homeFolder: 'C:\\Users\\dev',
  user: 'dev'
}

describe('the scrub of a login-shaped string', () => {
  test('replaces a key or a token by its placeholder, wherever it stands', () => {
    for (const secret of [OAUTH, API_KEY, GITHUB, JWT]) {
      assert.equal(scrubTokens(`{"accessToken":"${secret}","n":1}`), `{"accessToken":"${TOKEN}","n":1}`, secret)
      assert.equal(scrubTokens(`Authorization: Bearer ${secret}`), `Authorization: Bearer ${TOKEN}`, secret)
    }
    assert.equal(scrubTokens('no secret in sk-1 or a task-ant-word'), 'no secret in sk-1 or a task-ant-word')
  })

  test('the scrubber removes tokens and the login folder from every value it scrubs', () => {
    const scrubber = createScrubber(
      machineRules({
        projectFolder: 'C:\\Temp\\orchon-recorder-abc123\\project',
        archonHome: 'C:\\Temp\\orchon-recorder-abc123\\archon-home',
        recorderFolder: 'C:\\Temp\\orchon-recorder-abc123',
        tempFolder: 'C:\\Temp',
        homeFolder: 'C:\\Users\\dev',
        claudeConfig: 'C:\\Users\\dev\\.claude',
        binary: 'C:\\Downloads\\archon.exe',
        user: 'dev',
        host: 'dev-box'
      })
    )
    const scrubbed = scrubber.scrub({ credentials: 'C:\\Users\\dev\\.claude\\.credentials.json', note: `token ${OAUTH}` })
    assert.deepEqual(scrubbed, { credentials: `${PLACEHOLDERS.claudeConfig.as}\\.credentials.json`, note: `token ${TOKEN}` })
    assert.deepEqual(scrubber.leftovers(JSON.stringify(scrubbed)), [])
    assert.ok(scrubber.leftovers(`left ${API_KEY}`).includes(TOKEN))
  })
})

describe('the leak check', () => {
  test('finds nothing in a scrubbed fixture', () => {
    assert.deepEqual(findLeaks('{"cwd":"<project-path>","by":"<user>","remote":"git@github.com:orchon-recorder/x.git","a":"recorder@example.invalid"}', machine), [])
  })

  test('finds the login folder, the home folder, the account name, a token and an email address', () => {
    assert.deepEqual(findLeaks('read C:/Users/dev/.claude/.credentials.json', machine), ['the Claude login folder', 'the home folder', 'the account name'])
    assert.deepEqual(findLeaks('home is c:\\\\users\\\\dev\\\\x', machine), ['the home folder', 'the account name'])
    assert.deepEqual(findLeaks('signed in as DEV', machine), ['the account name'])
    assert.deepEqual(findLeaks(`{"token":"${OAUTH}"}`, machine), ['a token'])
    assert.deepEqual(findLeaks(`refresh ${JWT}`, machine), ['a token'])
    assert.deepEqual(findLeaks('"email":"someone.real@mail.example-isp.net"', machine), ['an email address'])
  })

  test('does not take a longer word for the account name', () => {
    assert.deepEqual(findLeaks('a developer and devtools', machine), [])
  })
})
