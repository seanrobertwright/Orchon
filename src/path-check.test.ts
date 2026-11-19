// The worker's request protocol seam: the worker mounted on a scripted Archon, clock and disk.
// These tests cover the path check: after health confirms a server, the worker reads its path
// list and decides Supported or Unsupported from the paths alone, never from the version.
import { assert, describe, test } from 'orca/testing'
import {
  ARCHON_HOME,
  CLOCK_START as START,
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  HANG,
  health,
  html,
  json,
  kinds,
  pathListWithout,
  RELEASES,
  recorded,
  REFUSE,
  scene,
  urls,
  type Scene,
  type Scripted
} from '../scripts/scripted-archon.ts'

describe('the path check', () => {
  test('reads the path list after health and before Connected, and a full list connects', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
    stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
    const mounted = await stage.mount()
    assert.deepEqual(urls(stage), [DEFAULT_HEALTH, DEFAULT_OPENAPI])
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
    const state = mounted.latest()
    assert.equal(state.kind, 'connected')
    assert.deepEqual(state.kind === 'connected' && state.features, { metrics: true })
    assert.equal(state.since, START + 2)
  })

  test('a path list that lacks one required path is Unsupported, with the address and version shown', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
    stage.archon.answer(DEFAULT_OPENAPI, pathListWithout('0.14.0', '/api/workflows/runs/{runId}/answer'))
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported'])
    assert.deepEqual(mounted.latest(), {
      kind: 'unsupported',
      since: START + 2,
      settings: { baseUrl: '', archonHome: '', homeFolder: ARCHON_HOME },
      baseUrl: DEFAULT,
      source: 'default',
      version: '0.14.0'
    })
  })

  test('a document that is not JSON, or has no paths object, is Unsupported', async () => {
    const answers: [what: string, answer: Scripted][] = [
      ['the HTML page, as a release without the document answers', recorded('0.12.1', 'missing-path')],
      ['HTML from a stand-in', html()],
      ['JSON that does not parse', { kind: 'text', text: '{"paths": {', contentType: 'application/json' }],
      ['a document with no paths', json({ openapi: '3.0.0', info: { title: 'Archon API' } })],
      ['paths that are a list', json({ openapi: '3.0.0', paths: ['/api/health'] })],
      ['paths that are null', json({ openapi: '3.0.0', paths: null })],
      ['a list, not a document', json([{ paths: {} }])]
    ]
    for (const [what, answer] of answers) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, health())
      stage.archon.answer(DEFAULT_OPENAPI, answer)
      const mounted = await stage.mount()
      assert.deepEqual(kinds(mounted), ['searching', 'unsupported'], what)
    }
  })

  test('a list without the metrics paths connects, with no metrics', async () => {
    for (const missing of [['/api/metrics', '/api/metric-views'], ['/api/metrics'], ['/api/metric-views']]) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
      stage.archon.answer(DEFAULT_OPENAPI, pathListWithout('0.14.0', ...missing))
      const mounted = await stage.mount()
      const state = mounted.latest()
      assert.equal(state.kind, 'connected', missing.join())
      assert.deepEqual(state.kind === 'connected' && state.features, { metrics: false }, missing.join())
    }
  })

  test('the version string never decides: an old version with every required path is supported', async () => {
    for (const version of ['0.11.1', '0.1.0', 'not a version', undefined]) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, health({ version }))
      stage.archon.answer(DEFAULT_OPENAPI, recorded('0.12.1', 'openapi'))
      const mounted = await stage.mount()
      assert.equal(mounted.latest().kind, 'connected', String(version))
    }
    // And a new version on a server that lacks a required path is not.
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
    stage.archon.answer(DEFAULT_OPENAPI, pathListWithout('0.14.0', '/api/codebases'))
    assert.equal((await stage.mount()).latest().kind, 'unsupported')
  })

  test('the recorded releases are each supported, and only 0.14.0 has metrics', async () => {
    const metrics: Record<string, boolean> = {}
    for (const release of RELEASES) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, recorded(release, 'health'))
      stage.archon.answer(DEFAULT_OPENAPI, recorded(release, 'openapi'))
      const state = (await stage.mount()).latest()
      assert.equal(state.kind, 'connected', release)
      if (state.kind !== 'connected') return
      assert.equal(state.version, release)
      metrics[release] = state.features.metrics
    }
    assert.deepEqual(metrics, { '0.12.1': false, '0.13.2': false, '0.14.0': true })
  })

  test('a refused connection on the document stays Searching, and discovery runs again', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer(DEFAULT_OPENAPI, REFUSE)
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching'])
    assert.deepEqual(urls(stage), [DEFAULT_HEALTH, DEFAULT_OPENAPI])

    stage.archon.answer(DEFAULT_OPENAPI, recorded('0.12.1', 'openapi'))
    await stage.clock.advance(2_000)
    assert.deepEqual(urls(stage), [DEFAULT_HEALTH, DEFAULT_OPENAPI, DEFAULT_HEALTH, DEFAULT_OPENAPI])
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
  })

  test('an error status or a document past the read cap stays Searching, and discovery runs again', async () => {
    const mebibyte = new Uint8Array(1024 * 1024).fill(0x20)
    const answers: [what: string, answer: Scripted][] = [
      ['a server error', json({ error: 'Internal error' }, 500)],
      ['a not-found status', html(404)],
      ['a document past 8 MiB', { kind: 'chunks', chunks: Array.from({ length: 9 }, () => mebibyte) }]
    ]
    for (const [what, answer] of answers) {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, health())
      stage.archon.answer(DEFAULT_OPENAPI, answer)
      const mounted = await stage.mount()
      assert.deepEqual(kinds(mounted), ['searching'], what)
      stage.archon.answer(DEFAULT_OPENAPI, recorded('0.12.1', 'openapi'))
      await stage.clock.advance(2_000)
      assert.deepEqual(kinds(mounted), ['searching', 'connected'], what)
    }
  })

  test('a document that times out stays Searching, after the read timeout of 10 seconds', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer(DEFAULT_OPENAPI, HANG)
    const mounted = await stage.mount()
    await stage.clock.advance(10_000)
    assert.deepEqual(kinds(mounted), ['searching'])
    // Discovery runs again after the first wait of the backoff.
    await stage.clock.advance(2_000)
    assert.deepEqual(urls(stage), [DEFAULT_HEALTH, DEFAULT_OPENAPI, DEFAULT_HEALTH, DEFAULT_OPENAPI])
    assert.deepEqual(kinds(mounted), ['searching'])
  })

  test('a document refused after Not found shows Searching, not Not found again', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching', 'not-found'])
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer(DEFAULT_OPENAPI, REFUSE)
    await stage.clock.advance(2_000)
    assert.deepEqual(kinds(mounted), ['searching', 'not-found', 'searching'])
  })
})

describe('the Unsupported re-check', () => {
  /** A scene whose default address serves a path list that lacks a required path. */
  function unsupportedScene(): { stage: Scene; times: number[] } {
    const stage = scene()
    const times: number[] = []
    stage.archon.answer(DEFAULT_HEALTH, () => {
      times.push(stage.clock.now() - START)
      return health({ version: '0.11.1' })
    })
    stage.archon.answer(DEFAULT_OPENAPI, pathListWithout('0.12.1', '/api/update-check'))
    return { stage, times }
  }

  test('runs discovery again every 30 seconds, with no doubling, and keeps the screen meanwhile', async () => {
    const { stage, times } = unsupportedScene()
    const mounted = await stage.mount()
    await stage.clock.advance(120_000)
    assert.deepEqual(times, [0, 30_000, 60_000, 90_000, 120_000])
    // Each pass reads health, then the path list.
    assert.equal(stage.archon.calls.length, 10)
    // Nothing differs between the passes, so nothing more is posted: no Searching in between.
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported'])
  })

  test('connects once the server lists every required path', async () => {
    const { stage } = unsupportedScene()
    const mounted = await stage.mount()
    stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.12.1' }))
    stage.archon.answer(DEFAULT_OPENAPI, recorded('0.12.1', 'openapi'))
    await stage.clock.advance(29_999)
    assert.equal(mounted.latest().kind, 'unsupported')
    await stage.clock.advance(1)
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported', 'connected'])
  })

  test('"Try again" runs discovery at once, and the 30 seconds start over', async () => {
    const { stage, times } = unsupportedScene()
    const mounted = await stage.mount()
    await stage.clock.advance(10_000)
    const answer = await mounted.worker.request('connection.retry')
    assert.equal(answer.connection.kind, 'searching')
    await stage.clock.advance(0)
    assert.deepEqual(times, [0, 10_000])
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported', 'searching', 'unsupported'])
    await stage.clock.advance(30_000)
    assert.deepEqual(times, [0, 10_000, 40_000])
  })

  test('a settings change runs discovery at once with the new value', async () => {
    const { stage } = unsupportedScene()
    stage.archon.answer('http://127.0.0.1:4000/api/health', health({ version: '0.13.2' }))
    stage.archon.answer('http://127.0.0.1:4000/api/openapi.json', recorded('0.13.2', 'openapi'))
    const mounted = await stage.mount()
    await stage.clock.advance(5_000)
    await mounted.orca.settings.set('baseUrl', 'http://127.0.0.1:4000')
    await stage.clock.advance(0)
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported', 'searching', 'connected'])
  })

  test('a server lost from Unsupported goes straight to Not found, then backs off from 2 seconds', async () => {
    const { stage } = unsupportedScene()
    stage.disk.folders.add(ARCHON_HOME)
    const mounted = await stage.mount()
    const refusals: number[] = []
    stage.archon.answer(DEFAULT_HEALTH, () => {
      refusals.push(stage.clock.now() - START)
      return REFUSE
    })
    await stage.clock.advance(30_000)
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported', 'not-found'])
    await stage.clock.advance(6_000)
    assert.deepEqual(refusals, [30_000, 32_000, 36_000])
  })
})
