// Pure logic: the parser of the two connection settings. It refuses, with the sentence the
// person is shown, and never repairs a value.
import { join, parse } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { parseConnectionSettings, REASONS } from './connection-settings'

const HOME_DIR = join(parse(process.cwd()).root, 'home', 'someone')
const env = { homeDir: HOME_DIR }
const DEFAULT_HOME = join(HOME_DIR, '.archon')

function refusal(raw: unknown): string[] {
  const parsed = parseConnectionSettings(raw, env)
  assert.equal(parsed.ok, false, JSON.stringify(raw))
  return parsed.ok ? [] : parsed.refused.map((refused) => `${refused.key}: ${refused.reason}`)
}

describe('the connection settings parser', () => {
  test('reads both settings unset as automatic discovery and the default home folder', () => {
    for (const raw of [{}, { baseUrl: '', archonHome: '' }, { notifications: 'off' }, null, 'text', []]) {
      assert.deepEqual(parseConnectionSettings(raw, env), {
        ok: true,
        typed: { baseUrl: '', archonHome: '' },
        stored: { baseUrl: '', archonHome: '' },
        baseUrl: null,
        home: DEFAULT_HOME
      })
    }
  })

  test('accepts http on each loopback host with a port from 1 to 65535', () => {
    const accepted: [typed: string, baseUrl: string][] = [
      ['http://127.0.0.1:3090', 'http://127.0.0.1:3090'],
      ['http://localhost:3090', 'http://localhost:3090'],
      ['http://[::1]:3090', 'http://[::1]:3090'],
      ['http://127.0.0.1:1', 'http://127.0.0.1:1'],
      ['http://127.0.0.1:65535', 'http://127.0.0.1:65535'],
      ['http://127.0.0.1:3090/', 'http://127.0.0.1:3090'],
      ['HTTP://LOCALHOST:3090', 'http://localhost:3090']
    ]
    for (const [typed, baseUrl] of accepted) {
      const parsed = parseConnectionSettings({ baseUrl: typed }, env)
      assert.deepEqual(parsed, {
        ok: true,
        typed: { baseUrl: typed, archonHome: '' },
        stored: { baseUrl: typed, archonHome: '' },
        baseUrl,
        home: DEFAULT_HOME
      })
    }
  })

  test('carries the reason sentences word for word', () => {
    assert.deepEqual(REASONS, {
      notAddress: 'This is not a web address.',
      notHttp: 'The address must start with `http://`.',
      notLoopback:
        'Orchon works only with an Archon on this computer. Use `127.0.0.1`, `localhost` or `[::1]`.',
      notBare: 'The address must be `http://`, a host and a port, and nothing else.',
      badPort: 'The port must be a number from 1 to 65535.',
      notFullPath: 'The folder must be a full path.'
    })
  })

  test('refuses a Base URL that is not a web address', () => {
    const typed = ['archon', '127.0.0.1:3090', ' ', 'http://', 'http://:3090', 'http://127.0.0.1 :3090', 42, true, null, {}]
    for (const value of typed) {
      assert.deepEqual(refusal({ baseUrl: value }), [`baseUrl: ${REASONS.notAddress}`], JSON.stringify(value))
    }
  })

  test('refuses surrounding spaces instead of trimming them', () => {
    assert.deepEqual(refusal({ baseUrl: ' http://127.0.0.1:3090' }), [`baseUrl: ${REASONS.notAddress}`])
    assert.deepEqual(refusal({ baseUrl: 'http://127.0.0.1:3090 ' }), [`baseUrl: ${REASONS.notAddress}`])
  })

  test('refuses a Base URL that is not http', () => {
    for (const typed of ['https://127.0.0.1:3090', 'ftp://127.0.0.1:3090', 'localhost:3090', 'http:127.0.0.1:3090']) {
      assert.deepEqual(refusal({ baseUrl: typed }), [`baseUrl: ${REASONS.notHttp}`], typed)
    }
  })

  test('refuses a host that is not one of the three loopback spellings', () => {
    const hosts = ['example.com', '192.168.1.20', '127.0.0.2', '127.1', '0.0.0.0', '[::]', '[::2]', 'localhost.example.com']
    for (const host of hosts) {
      assert.deepEqual(refusal({ baseUrl: `http://${host}:3090` }), [`baseUrl: ${REASONS.notLoopback}`], host)
    }
  })

  test('refuses a path, a query, a fragment or credentials', () => {
    const typed = [
      'http://127.0.0.1:3090/api',
      'http://127.0.0.1:3090//',
      'http://127.0.0.1:3090?x=1',
      'http://127.0.0.1:3090/?x=1',
      'http://127.0.0.1:3090#top',
      'http://user@127.0.0.1:3090',
      'http://user:secret@127.0.0.1:3090',
      'http://example.com@127.0.0.1:3090'
    ]
    for (const value of typed) {
      assert.deepEqual(refusal({ baseUrl: value }), [`baseUrl: ${REASONS.notBare}`], value)
    }
  })

  test('refuses a missing port and one outside 1 to 65535', () => {
    const typed = [
      'http://127.0.0.1',
      'http://localhost/',
      'http://127.0.0.1:',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:99999999',
      'http://127.0.0.1:03090',
      'http://127.0.0.1:30.9',
      'http://127.0.0.1:-1',
      'http://127.0.0.1:port',
      'http://[::1]:1e3'
    ]
    for (const value of typed) {
      assert.deepEqual(refusal({ baseUrl: value }), [`baseUrl: ${REASONS.badPort}`], value)
    }
  })

  test('never reads a host out of the credentials', () => {
    assert.deepEqual(refusal({ baseUrl: 'http://127.0.0.1:3090@example.com:80' }), [
      `baseUrl: ${REASONS.notLoopback}`
    ])
  })

  test('expands a leading ~ in the home folder and accepts a full path', () => {
    const full = join(parse(process.cwd()).root, 'opt', 'archon')
    const accepted: [typed: string, home: string][] = [
      ['~', HOME_DIR],
      ['~/.archon', join(HOME_DIR, '.archon')],
      ['~/work/archon home', join(HOME_DIR, 'work', 'archon home')],
      [full, full]
    ]
    for (const [typed, home] of accepted) {
      const parsed = parseConnectionSettings({ archonHome: typed }, env)
      assert.deepEqual(parsed, {
        ok: true,
        typed: { baseUrl: '', archonHome: typed },
        stored: { baseUrl: '', archonHome: typed },
        baseUrl: null,
        home
      })
    }
  })

  test('refuses a home folder that is not a full path once ~ is expanded', () => {
    const typed = ['archon', './archon', '../archon', '~someone/.archon', ' ', '.archon/~', 7, false, null, ['~']]
    for (const value of typed) {
      assert.deepEqual(refusal({ archonHome: value }), [`archonHome: ${REASONS.notFullPath}`], JSON.stringify(value))
    }
  })

  test('lists both settings when both are refused, the Base URL first', () => {
    const parsed = parseConnectionSettings({ baseUrl: 'https://archon.example.com', archonHome: 'archon' }, env)
    assert.deepEqual(parsed, {
      ok: false,
      typed: { baseUrl: 'https://archon.example.com', archonHome: 'archon' },
      stored: { baseUrl: 'https://archon.example.com', archonHome: 'archon' },
      refused: [
        { key: 'baseUrl', value: 'https://archon.example.com', reason: REASONS.notHttp },
        { key: 'archonHome', value: 'archon', reason: REASONS.notFullPath }
      ],
      home: null
    })
  })

  test('keeps the home folder when only the Base URL is refused', () => {
    const parsed = parseConnectionSettings({ baseUrl: 'archon', archonHome: '~/elsewhere' }, env)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.home, join(HOME_DIR, 'elsewhere'))
  })

  test('shows a refused value as typed, cut at 200 characters', () => {
    const long = `https://${'a'.repeat(400)}`
    const parsed = parseConnectionSettings({ baseUrl: long, archonHome: { folder: '~' } }, env)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    const cut = `${long.slice(0, 199)}…`
    assert.equal(cut.length, 200)
    assert.deepEqual(parsed.typed, { baseUrl: cut, archonHome: '{"folder":"~"}' })
    assert.deepEqual(
      parsed.refused.map((refused) => refused.value),
      [cut, '{"folder":"~"}']
    )
  })

  test('reads only its own keys of the settings object', () => {
    const inherited = Object.create({ baseUrl: 'https://example.com', archonHome: 'archon' }) as object
    assert.equal(parseConnectionSettings(inherited, env).ok, true)
  })
})
