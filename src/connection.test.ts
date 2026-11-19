// The worker's request protocol seam: the worker mounted on a scripted Archon, clock and disk.
// These tests cover the connection state: when it changes, what it carries, when discovery runs
// again, and what a frame and the status bar item are told.
import { join } from 'node:path'
import { assert, describe, hostError, test } from 'orca/testing'
import {
  ARCHON_HOME,
  CLOCK_START as START,
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  HANG,
  health,
  HOME_DIR,
  json,
  kinds,
  REFUSE,
  scene,
  type Scene
} from '../scripts/scripted-archon.ts'
import { REASONS } from './connection-settings'
import { SILENCE_MS } from './live'
import { SNAPSHOT_SAFETY_MS } from './needs-you'

/** Records the clock time of every health call to the default address, which is refused. */
function timedRefusals(stage: Scene): number[] {
  const times: number[] = []
  stage.archon.answer(DEFAULT_HEALTH, () => {
    times.push(stage.clock.now() - START)
    return REFUSE
  })
  return times
}

describe('the connection state', () => {
  test('starts as Searching and is Connected once health answers and the path list is full', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
    assert.deepEqual(mounted.latest(), {
      kind: 'connected',
      since: START + 2,
      settings: { baseUrl: '', archonHome: '', homeFolder: ARCHON_HOME },
      baseUrl: DEFAULT,
      source: 'default',
      version: '0.12.1',
      storeId: 'store-a',
      features: { metrics: false },
      live: true
    })
    // Connected waits only on the dashboard stream and the snapshot: once the status bar item is
    // told, the timers left are the snapshot's safety read and the stream's watchdog. The scripted
    // stream sends nothing, so it stays not live.
    await stage.clock.advance(1_000)
    assert.deepEqual(stage.clock.waiting(), [SNAPSHOT_SAFETY_MS - 1_000, SILENCE_MS - 1_000])
  })

  test('on a cold start the first failed pass goes straight to Not found', async () => {
    const stage = scene()
    stage.disk.folders.add(ARCHON_HOME)
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching', 'not-found'])
    assert.deepEqual(mounted.latest(), {
      kind: 'not-found',
      since: START + 2,
      settings: { baseUrl: '', archonHome: '', homeFolder: ARCHON_HOME },
      address: DEFAULT,
      source: 'default',
      home: 'exists'
    })
  })

  test('stamps each state with the time it was entered, later than the one before', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    // The passes at 2, 6, 14, 30 and 60 seconds find nothing. The one at 90 seconds does.
    await stage.clock.advance(60_000)
    stage.archon.answer(DEFAULT_HEALTH, health())
    await stage.clock.advance(30_000)
    const stamps = mounted.posted().map((state) => [state.kind, state.since - START])
    // Two states entered in the same millisecond still get stamps that rise.
    assert.deepEqual(stamps, [
      ['searching', 1],
      ['not-found', 2],
      ['connected', 90_000]
    ])
  })

  test('answers a frame with the state it last posted, on every request', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    assert.deepEqual(await mounted.worker.request('connection.read'), { connection: mounted.latest() })
    stage.archon.answer(DEFAULT_HEALTH, health())
    await stage.clock.advance(2_000)
    assert.equal(mounted.latest().kind, 'connected')
    assert.deepEqual(await mounted.worker.request('connection.read'), { connection: mounted.latest() })
  })

  test('answers a frame that asks before the first pass has finished with Searching', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, HANG)
    const mounted = await stage.mount()
    const state = await mounted.read()
    assert.equal(state.kind, 'searching')
    assert.deepEqual(state.settings, { baseUrl: '', archonHome: '', homeFolder: ARCHON_HOME })
  })

  test('in Not found, looks again after 2 seconds, doubling to one try every 30 seconds', async () => {
    const stage = scene()
    const times = timedRefusals(stage)
    const mounted = await stage.mount()
    await stage.clock.advance(150_000)
    assert.deepEqual(times, [0, 2_000, 6_000, 14_000, 30_000, 60_000, 90_000, 120_000, 150_000])
    // Nothing differs between the passes, so nothing more is posted.
    assert.deepEqual(kinds(mounted), ['searching', 'not-found'])
    assert.deepEqual(stage.clock.waiting(), [30_000])
  })

  test('reconnects by itself once Archon answers, and stops looking', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    await stage.clock.advance(5_000)
    stage.archon.answer(DEFAULT_HEALTH, health())
    await stage.clock.advance(999)
    assert.equal(mounted.latest().kind, 'not-found')
    await stage.clock.advance(1)
    assert.deepEqual(kinds(mounted), ['searching', 'not-found', 'connected'])
    const calls = stage.archon.calls.length
    await stage.clock.advance(120_000)
    assert.equal(stage.archon.calls.length, calls)
    // Only the snapshot's safety read and the watchdog of the silent stream wait; the watchdog
    // reopened the stream at 75 seconds.
    assert.deepEqual(stage.clock.waiting(), [SNAPSHOT_SAFETY_MS, 2 * SILENCE_MS - 120_000])
  })

  test('posts Not found again when what it would say has changed', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    assert.equal(mounted.latest().kind === 'not-found' && mounted.latest().since, START + 2)
    stage.disk.folders.add(ARCHON_HOME)
    await stage.clock.advance(2_000)
    const states = mounted.posted()
    assert.deepEqual(
      states.map((state) => state.kind === 'not-found' && state.home),
      [false, 'missing', 'exists']
    )
    assert.equal(states[2]?.since, START + 2_000)
  })

  test('"Try again" looks at once and starts the waits over', async () => {
    const stage = scene()
    const times = timedRefusals(stage)
    const mounted = await stage.mount()
    await stage.clock.advance(20_000)
    assert.deepEqual(times, [0, 2_000, 6_000, 14_000])

    const answer = await mounted.worker.request('connection.retry')
    assert.equal(answer.connection.kind, 'searching')
    await stage.clock.advance(0)
    assert.deepEqual(times, [0, 2_000, 6_000, 14_000, 20_000])
    assert.deepEqual(kinds(mounted), ['searching', 'not-found', 'searching', 'not-found'])
    // The wait that was running (until 30 s) is gone, and the next one is 2 seconds again. The
    // other timer is the status bar item's, which is told at most once a second.
    assert.deepEqual(stage.clock.waiting(), [1_000, 2_000])
    await stage.clock.advance(6_000)
    assert.deepEqual(times, [0, 2_000, 6_000, 14_000, 20_000, 22_000, 26_000])
  })

  test('"Try again" connects when Archon has started', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    stage.archon.answer(DEFAULT_HEALTH, health())
    await mounted.worker.request('connection.retry')
    await stage.clock.advance(0)
    assert.equal(mounted.latest().kind, 'connected')
  })

  test('"Try again" changes nothing while Connected or in Bad setting', async () => {
    const connected = scene()
    connected.archon.answer(DEFAULT_HEALTH, health())
    const first = await connected.mount()
    const before = connected.archon.calls.length
    assert.deepEqual(await first.worker.request('connection.retry'), { connection: first.latest() })
    await connected.clock.advance(0)
    assert.deepEqual(kinds(first), ['searching', 'connected'])
    assert.equal(connected.archon.calls.length, before)

    const bad = scene()
    const second = await bad.mount({ settings: { baseUrl: 'archon' } })
    assert.deepEqual(await second.worker.request('connection.retry'), { connection: second.latest() })
    await bad.clock.advance(0)
    assert.deepEqual(kinds(second), ['bad-setting'])
  })

  test('refuses a request that carries an input', async () => {
    const stage = scene()
    const { worker } = await stage.mount()
    for (const name of ['connection.read', 'connection.retry']) {
      await assert.rejects(
        worker.request(name, { baseUrl: 'http://example.com' }),
        (error: unknown) => (error as { code?: string }).code === 'invalid_params'
      )
    }
  })

  test('a refused Base URL is Bad setting: the reason is carried and nothing is called', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const mounted = await stage.mount({ settings: { baseUrl: 'https://archon.example.com:3090' } })
    assert.deepEqual(mounted.posted(), [
      {
        kind: 'bad-setting',
        since: START + 1,
        settings: { baseUrl: 'https://archon.example.com:3090', archonHome: '', homeFolder: ARCHON_HOME },
        refused: [{ key: 'baseUrl', value: 'https://archon.example.com:3090', reason: REASONS.notHttp }]
      }
    ])
    await stage.clock.advance(120_000)
    assert.deepEqual(stage.archon.calls, [])
    assert.deepEqual(stage.disk.asked, [])
    assert.deepEqual(stage.clock.waiting(), [])
  })

  test('lists both settings when both are refused', async () => {
    const stage = scene()
    const mounted = await stage.mount({ settings: { baseUrl: 'http://192.168.1.20:3090', archonHome: 'archon' } })
    const state = mounted.latest()
    assert.equal(state.kind, 'bad-setting')
    if (state.kind !== 'bad-setting') return
    assert.deepEqual(state.refused, [
      { key: 'baseUrl', value: 'http://192.168.1.20:3090', reason: REASONS.notLoopback },
      { key: 'archonHome', value: 'archon', reason: REASONS.notFullPath }
    ])
    assert.deepEqual(state.settings, { baseUrl: 'http://192.168.1.20:3090', archonHome: 'archon', homeFolder: null })
    assert.deepEqual(stage.archon.calls, [])
  })

  test('parses again the moment a setting changes, and connects when it is now valid', async () => {
    const stage = scene()
    stage.archon.answer('http://127.0.0.1:4000/api/health', health())
    const mounted = await stage.mount({ settings: { baseUrl: 'http://127.0.0.1:4000/api' } })
    assert.deepEqual(kinds(mounted), ['bad-setting'])

    await mounted.orca.settings.set('baseUrl', 'http://127.0.0.1:4000')
    await stage.clock.advance(0)
    assert.deepEqual(kinds(mounted), ['bad-setting', 'searching', 'connected'])
    const state = mounted.latest()
    assert.deepEqual(state.kind === 'connected' && [state.baseUrl, state.source], ['http://127.0.0.1:4000', 'setting'])
    assert.equal(state.settings.baseUrl, 'http://127.0.0.1:4000')
  })

  test('never repairs a value: a setting that is nearly right stays refused', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const mounted = await stage.mount({ settings: { baseUrl: ' http://127.0.0.1:3090 ' } })
    assert.deepEqual(kinds(mounted), ['bad-setting'])
    assert.equal(mounted.latest().settings.baseUrl, ' http://127.0.0.1:3090 ')
    assert.deepEqual(stage.archon.calls, [])
  })

  test('a settings change in Not found looks at once with the new value', async () => {
    const stage = scene()
    const times = timedRefusals(stage)
    stage.archon.answer('http://127.0.0.1:4000/api/health', health())
    const mounted = await stage.mount()
    await stage.clock.advance(7_000)
    assert.deepEqual(times, [0, 2_000, 6_000])

    await mounted.orca.settings.set('baseUrl', 'http://127.0.0.1:4000')
    await stage.clock.advance(0)
    assert.deepEqual(kinds(mounted), ['searching', 'not-found', 'searching', 'connected'])
    // Only the status bar item's timer, the snapshot's safety read and the stream's watchdog are
    // left: nothing looks again.
    assert.deepEqual(stage.clock.waiting(), [1_000, SNAPSHOT_SAFETY_MS, SILENCE_MS])
    await stage.clock.advance(1_000)
    assert.deepEqual(stage.clock.waiting(), [SNAPSHOT_SAFETY_MS - 1_000, SILENCE_MS - 1_000])
  })

  test('a settings change while Connected looks again, and a refused value disconnects', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const mounted = await stage.mount()
    await mounted.orca.settings.set('archonHome', 'not a full path')
    await stage.clock.advance(0)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'bad-setting'])

    await mounted.orca.settings.set('archonHome', '')
    await stage.clock.advance(0)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'bad-setting', 'searching', 'connected'])
  })

  test('a change to the home folder past the shown length is a change: discovery looks in the new folder', async () => {
    const stage = scene()
    // The manifest allows 1,024 characters, and a value is shown cut to 200: these two differ
    // only after the cut.
    const before = join(HOME_DIR, 'a'.repeat(300))
    const after = join(HOME_DIR, `${'a'.repeat(250)}b${'a'.repeat(49)}`)
    const mounted = await stage.mount({ settings: { archonHome: before } })
    await mounted.orca.settings.set('archonHome', after)
    await stage.clock.advance(0)
    assert.ok(stage.disk.asked.includes(join(after, 'server.json')))
    const state = mounted.latest()
    assert.equal(state.settings.homeFolder?.endsWith('…'), true)
  })

  test('a change to a setting that is not a connection setting changes nothing', async () => {
    const stage = scene()
    const times = timedRefusals(stage)
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    await mounted.orca.settings.set('notifications', 'off')
    await stage.clock.advance(0)
    assert.deepEqual(times, [0])
    assert.deepEqual(kinds(mounted), ['searching', 'not-found'])
    // The wait that was running is kept.
    assert.deepEqual(stage.clock.waiting(), [1_000])
  })

  test('a pass that a newer one overtook changes nothing when it ends', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, HANG)
    stage.archon.answer('http://127.0.0.1:4000/api/health', health())
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching'])
    await mounted.orca.settings.set('baseUrl', 'http://127.0.0.1:4000')
    await stage.clock.advance(0)
    assert.equal(mounted.latest().kind, 'connected')
    const posted = mounted.posted().length
    await stage.clock.advance(60_000)
    assert.equal(mounted.posted().length, posted)
    // Only the watchdog of the silent stream and the snapshot's safety read wait.
    assert.deepEqual(stage.clock.waiting(), [SILENCE_MS - 60_000, SNAPSHOT_SAFETY_MS])
  })

  test('keeps looking, and says so in the log, when the settings cannot be read', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    let fail = true
    const mounted = await stage.mount({
      results: {
        'settings.get': () => {
          if (fail) throw hostError('unavailable', 'Settings are not ready.')
          return { settings: {} }
        }
      }
    })
    assert.deepEqual(kinds(mounted), [])
    assert.deepEqual(stage.archon.calls, [])
    assert.equal(mounted.worker.logs.length, 1)
    assert.match(mounted.worker.logs[0] ?? '', /^Orchon could not look for Archon: /)
    assert.equal((await mounted.read()).kind, 'searching')

    fail = false
    await stage.clock.advance(2_000)
    assert.equal(mounted.latest().kind, 'connected')
  })

  test('stops everything when the worker is deactivated', async () => {
    const stage = scene()
    const times = timedRefusals(stage)
    const mounted = await stage.mount()
    // One timer looks again in 2 seconds, the other tells the status bar item in 1.
    assert.deepEqual(stage.clock.waiting(), [1_000, 2_000])
    const told = mounted.statusBar().length
    await mounted.worker.deactivate()
    assert.deepEqual(stage.clock.waiting(), [])
    await stage.clock.advance(120_000)
    assert.deepEqual(times, [0])
    assert.deepEqual(kinds(mounted), ['searching', 'not-found'])
    assert.equal(mounted.statusBar().length, told)
  })
})

describe('the status bar item', () => {
  const item = (text: string, tooltip: string, warns = false): unknown => ({
    id: 'status',
    text,
    icon: warns ? 'warning' : 'bot',
    tone: warns ? 'warning' : 'neutral',
    tooltip
  })

  test('reads "Archon…" while Searching and "Archon" once Connected', async () => {
    const stage = scene()
    stage.disk.folders.add(ARCHON_HOME)
    stage.archon.answer(DEFAULT_HEALTH, HANG)
    const mounted = await stage.mount()
    assert.deepEqual(mounted.statusBar(), [item('Archon…', 'Looking for Archon.')])

    stage.archon.answer(DEFAULT_HEALTH, health())
    await stage.clock.advance(5_000)
    assert.deepEqual(mounted.statusBar(), [
      item('Archon…', 'Looking for Archon.'),
      item('Archon off', `Archon is not running at ${DEFAULT}.`),
      item('Archon', `Connected to Archon 0.12.1 at ${DEFAULT}.`)
    ])
  })

  test('reads "Archon off" for both Not found wordings, each with its own sentence', async () => {
    const present = scene()
    present.disk.folders.add(ARCHON_HOME)
    const running = await present.mount()
    await present.clock.advance(1_000)
    assert.deepEqual(running.statusBar().at(-1), item('Archon off', `Archon is not running at ${DEFAULT}.`))

    const absent = scene()
    const missing = await absent.mount()
    await absent.clock.advance(1_000)
    assert.deepEqual(missing.statusBar().at(-1), item('Archon off', `No Archon home folder at ${ARCHON_HOME}.`))

    const set = scene()
    const setting = await set.mount({ settings: { baseUrl: 'http://localhost:4000' } })
    await set.clock.advance(1_000)
    assert.deepEqual(setting.statusBar().at(-1), item('Archon off', 'Archon is not running at http://localhost:4000.'))
  })

  test('reads "Archon setup", as a warning, for Bad setting', async () => {
    const sentences: [settings: Record<string, string>, sentence: string][] = [
      [{ baseUrl: 'archon' }, 'The Base URL setting is not valid.'],
      [{ archonHome: 'archon' }, 'The Archon home folder setting is not valid.'],
      [{ baseUrl: 'archon', archonHome: 'archon' }, 'Two connection settings are not valid.']
    ]
    for (const [settings, sentence] of sentences) {
      const stage = scene()
      const mounted = await stage.mount({ settings })
      await stage.clock.advance(1_000)
      assert.deepEqual(mounted.statusBar().at(-1), item('Archon setup', sentence, true))
    }
  })

  test('reads "Archon setup", as a warning, for Unsupported', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.11.1' }))
    stage.archon.answer(DEFAULT_OPENAPI, json({ openapi: '3.0.0', paths: { '/api/health': {} } }))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    assert.deepEqual(
      mounted.statusBar().at(-1),
      item('Archon setup', `The Archon at ${DEFAULT} is not supported. Orchon needs 0.12.1 or newer.`, true)
    )
  })

  test('says "Connected to Archon" with no version when health reports none', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ version: undefined }))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    assert.deepEqual(mounted.statusBar().at(-1), item('Archon', `Connected to Archon at ${DEFAULT}.`))
  })

  test('is updated only when something differs', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    await stage.clock.advance(150_000)
    // Nine passes found nothing, and the item was told once.
    assert.equal(stage.archon.calls.length, 9)
    assert.deepEqual(
      mounted.statusBar().map((update) => (update as { text: string }).text),
      ['Archon…', 'Archon off']
    )
  })

  test('is updated at most once a second, ending on the newest state', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    await stage.clock.advance(10_000)
    const before = mounted.statusBar().length

    // Three presses of "Try again" in one moment: Searching and Not found, three times over.
    for (let press = 0; press < 3; press += 1) {
      await mounted.worker.request('connection.retry')
      await stage.clock.advance(0)
    }
    assert.equal(mounted.posted().length, 2 + 6)
    assert.deepEqual(
      mounted.statusBar().slice(before).map((update) => (update as { text: string }).text),
      ['Archon…']
    )
    await stage.clock.advance(1_000)
    assert.deepEqual(
      mounted.statusBar().slice(before).map((update) => (update as { text: string }).text),
      ['Archon…', 'Archon off']
    )
  })

  test('sends nothing the host refuses', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const mounted = await stage.mount()
    await stage.clock.advance(5_000)
    assert.deepEqual(mounted.worker.refusals, [])
    assert.deepEqual(mounted.worker.logs, [])
  })
})
