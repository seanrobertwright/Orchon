// The worker's request protocol seam: the worker mounted on a scripted Archon, clock and disk.
// These tests cover discovery: which address each pass tries, and what counts as found.
import { assert, describe, test } from 'orca/testing'
import {
  ARCHON_HOME,
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  HANG,
  health,
  html,
  json,
  scene,
  SERVER_RECORD,
  urls,
  type Scene
} from '../scripts/scripted-archon.ts'

/** A scene whose Archon home folder exists and holds this `server.json`. */
function withRecord(record: unknown): Scene {
  const stage = scene()
  stage.disk.folders.add(ARCHON_HOME)
  stage.disk.files.set(SERVER_RECORD, typeof record === 'string' ? record : JSON.stringify(record))
  return stage
}

describe('discovery', () => {
  test('with nothing set and no server.json, finds Archon at the default address', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
    const state = (await stage.mount()).latest()
    assert.equal(state.kind, 'connected')
    assert.deepEqual(
      { ...state, since: 0, settings: null },
      {
        kind: 'connected',
        since: 0,
        settings: null,
        baseUrl: DEFAULT,
        source: 'default',
        version: '0.12.1',
        storeId: 'store-a',
        features: { metrics: false },
        live: false
      }
    )
    assert.equal(stage.archon.calls[0]?.url, DEFAULT_HEALTH)
    assert.equal(stage.archon.calls[0]?.method, 'GET')
  })

  test('opens the disk for the Archon home folder alone, and reads only server.json in it', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    await stage.mount()
    assert.deepEqual(stage.disk.opened, [[ARCHON_HOME]])
    assert.deepEqual(stage.disk.asked, [SERVER_RECORD])
  })

  test('with the Base URL set, tries that address and no other', async () => {
    const stage = withRecord({ port: 4100, host: '127.0.0.1' })
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer('http://127.0.0.1:4100/api/health', health())
    stage.archon.answer('http://localhost:4000/api/health', health({ version: '0.14.0' }))
    const state = (await stage.mount({ settings: { baseUrl: 'http://localhost:4000' } })).latest()
    assert.equal(state.kind, 'connected')
    if (state.kind !== 'connected') return
    assert.deepEqual([state.baseUrl, state.source, state.version], ['http://localhost:4000', 'setting', '0.14.0'])
    // The path list is read from the confirmed address too, and from nowhere else.
    assert.deepEqual(urls(stage), ['http://localhost:4000/api/health', 'http://localhost:4000/api/openapi.json'])
    assert.deepEqual(stage.disk.asked, [])
  })

  test('with the Base URL set and nothing there, does not fall back to server.json or the default', async () => {
    const stage = withRecord({ port: 4100, host: '127.0.0.1' })
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer('http://127.0.0.1:4100/api/health', health())
    const state = (await stage.mount({ settings: { baseUrl: 'http://127.0.0.1:4000' } })).latest()
    assert.equal(state.kind, 'not-found')
    if (state.kind !== 'not-found') return
    // The home folder is not looked at: a set Base URL always gets the "not running" wording.
    assert.deepEqual([state.address, state.source, state.home], ['http://127.0.0.1:4000', 'setting', 'unchecked'])
    assert.deepEqual(urls(stage), ['http://127.0.0.1:4000/api/health'])
    assert.deepEqual(stage.disk.asked, [])
  })

  test('takes the port from server.json, reads 0.0.0.0 as 127.0.0.1 and ignores the pid', async () => {
    const stage = withRecord({ pid: 1, version: '0.13.2', startedAt: '2026-11-15T03:52:33.126Z', port: 4100, host: '0.0.0.0' })
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer('http://127.0.0.1:4100/api/health', health({ version: '0.13.2' }))
    const state = (await stage.mount()).latest()
    assert.equal(state.kind, 'connected')
    if (state.kind !== 'connected') return
    assert.deepEqual([state.baseUrl, state.source, state.version], ['http://127.0.0.1:4100', 'server-json', '0.13.2'])
    assert.deepEqual(urls(stage), ['http://127.0.0.1:4100/api/health', 'http://127.0.0.1:4100/api/openapi.json'])
  })

  test('reads the other loopback spellings of a host in server.json', async () => {
    for (const [host, baseUrl] of [
      ['localhost', 'http://localhost:4100'],
      ['::1', 'http://[::1]:4100'],
      ['[::1]', 'http://[::1]:4100']
    ] as const) {
      const stage = withRecord({ port: 4100, host })
      stage.archon.answer(`${baseUrl}/api/health`, health())
      const state = (await stage.mount()).latest()
      assert.equal(state.kind === 'connected' && state.baseUrl, baseUrl, host)
    }
  })

  test('reads a server.json with no host as this computer', async () => {
    const stage = withRecord({ port: 4100 })
    stage.archon.answer('http://127.0.0.1:4100/api/health', health())
    const state = (await stage.mount()).latest()
    assert.equal(state.kind === 'connected' && state.baseUrl, 'http://127.0.0.1:4100')
  })

  test('when server.json carries a storeId, health must report the same one', async () => {
    const same = withRecord({ port: 4100, host: '127.0.0.1', storeId: 'store-a' })
    same.archon.answer('http://127.0.0.1:4100/api/health', health({ storeId: 'store-a' }))
    const found = (await same.mount()).latest()
    assert.equal(found.kind === 'connected' && found.storeId, 'store-a')

    for (const reported of [{ storeId: 'store-b' }, {}]) {
      const other = withRecord({ port: 4100, host: '127.0.0.1', storeId: 'store-a' })
      other.archon.answer('http://127.0.0.1:4100/api/health', health(reported))
      other.archon.answer(DEFAULT_HEALTH, health(reported))
      const state = (await other.mount()).latest()
      assert.equal(state.kind, 'not-found', JSON.stringify(reported))
      if (state.kind !== 'not-found') return
      assert.deepEqual([state.address, state.source, state.home], ['http://127.0.0.1:4100', 'server-json', 'exists'])
      assert.deepEqual(urls(other), ['http://127.0.0.1:4100/api/health'])
    }
  })

  test('a server.json with no storeId is confirmed by health alone', async () => {
    const stage = withRecord({ port: 4100, host: '127.0.0.1' })
    stage.archon.answer('http://127.0.0.1:4100/api/health', health({ storeId: 'store-b' }))
    const state = (await stage.mount()).latest()
    assert.equal(state.kind === 'connected' && state.storeId, 'store-b')
  })

  test('treats a host in server.json that is not loopback as not found, and never calls it', async () => {
    for (const host of ['192.168.1.20', 'archon.example.com', '::', '127.0.0.2']) {
      const stage = withRecord({ port: 4100, host })
      stage.archon.answer(DEFAULT_HEALTH, health())
      const state = (await stage.mount()).latest()
      assert.equal(state.kind, 'not-found', host)
      assert.equal(state.kind === 'not-found' && state.source, 'server-json', host)
      assert.deepEqual(urls(stage), [], host)
    }
  })

  test('a server.json that is not a record does not apply: the default address is tried', async () => {
    const notRecords = [
      '{"port":',
      '[]',
      '"text"',
      '{}',
      { host: '127.0.0.1' },
      { port: '4100' },
      { port: 0 },
      { port: 65536 },
      { port: 4100.5 },
      { port: 4100, host: 7 },
      { port: 4100, host: '' },
      { port: 4100, storeId: 12 }
    ]
    for (const record of notRecords) {
      const stage = withRecord(record)
      stage.archon.answer(DEFAULT_HEALTH, health())
      const state = (await stage.mount()).latest()
      assert.equal(state.kind === 'connected' && state.source, 'default', JSON.stringify(record))
      assert.deepEqual(urls(stage), [DEFAULT_HEALTH, DEFAULT_OPENAPI], JSON.stringify(record))
    }
  })

  test('counts a candidate only when health answers JSON with status ok', async () => {
    const notArchon = [
      html(),
      json({ status: 'degraded', version: '0.12.1' }),
      json({ version: '0.12.1' }),
      json(['ok']),
      json('ok'),
      json({ status: 'ok', storeId: 12 }),
      json({ status: 'ok' }, 500),
      json({ status: 'ok' }, 302)
    ]
    for (const answer of notArchon) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, answer)
      const state = (await stage.mount()).latest()
      assert.equal(state.kind, 'not-found', JSON.stringify(answer))
    }
  })

  test('shows the version as text and never decides by it', async () => {
    for (const [reported, shown] of [
      [{ version: '0.1.0' }, '0.1.0'],
      [{ version: 'not a version' }, 'not a version'],
      [{ version: 12 }, null],
      [{ version: undefined }, null],
      [{ version: 'v'.repeat(500) }, 'v'.repeat(40)]
    ] as const) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, health(reported))
      const state = (await stage.mount()).latest()
      assert.equal(state.kind === 'connected' ? state.version : 'not connected', shown, JSON.stringify(reported))
    }
  })

  test('gives health 3 seconds: a server that hangs is not found', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, HANG)
    const { latest } = await stage.mount()
    await stage.clock.advance(2_999)
    assert.equal(latest().kind, 'searching')
    await stage.clock.advance(1)
    assert.equal(latest().kind, 'not-found')
  })

  test('says whether the home folder exists when nothing answers at the default address', async () => {
    const missing = scene()
    const without = (await missing.mount()).latest()
    assert.equal(without.kind === 'not-found' && without.home, 'missing')
    assert.deepEqual(missing.disk.asked, [SERVER_RECORD, ARCHON_HOME])

    const present = scene()
    present.disk.folders.add(ARCHON_HOME)
    const within = (await present.mount()).latest()
    assert.equal(within.kind === 'not-found' && within.home, 'exists')
  })

  test('looks in the folder the home folder setting names', async () => {
    const stage = scene()
    const elsewhere = `${ARCHON_HOME}-elsewhere`
    stage.disk.folders.add(elsewhere)
    stage.disk.files.set(`${elsewhere}/server.json`, JSON.stringify({ port: 4200, host: '127.0.0.1' }))
    stage.disk.files.set(`${elsewhere}\\server.json`, JSON.stringify({ port: 4200, host: '127.0.0.1' }))
    stage.archon.answer('http://127.0.0.1:4200/api/health', health())
    const state = (await stage.mount({ settings: { archonHome: elsewhere } })).latest()
    assert.equal(state.kind === 'connected' && state.baseUrl, 'http://127.0.0.1:4200')
    assert.deepEqual(stage.disk.opened, [[elsewhere]])
    assert.equal(state.settings.homeFolder, elsewhere)
  })
})
