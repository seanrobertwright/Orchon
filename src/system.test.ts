// The worker's request protocol seam: the worker mounted on a scripted Archon, clock and disk.
// These tests cover the System group of the Settings section: what health and the update check
// are read into, and when each is read.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  CLOCK_START,
  HANG,
  html,
  health,
  json,
  recorded,
  RELEASES,
  REFUSE,
  scene,
  settle,
  type MountedScene,
  type Release,
  type Scripted
} from '../scripts/scripted-archon.ts'
import { CODE_EXTENSIONS, hasExtension, listRepoFiles, readRepoText } from '../scripts/repo-files.ts'
import type { SystemView } from './system-view'

const UPDATE_CHECK = `${DEFAULT}/api/update-check`

/** A worker connected at the default address to a release, answering its recorded fixtures. */
async function connectedTo(release: Release): Promise<{ stage: ReturnType<typeof scene>; mounted: MountedScene }> {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, recorded(release, 'health'))
  stage.archon.answer(DEFAULT_OPENAPI, recorded(release, 'openapi'))
  stage.archon.answer(UPDATE_CHECK, recorded(release, 'update-check'))
  const mounted = await stage.mount()
  assert.equal(mounted.latest().kind, 'connected')
  return { stage, mounted }
}

/** Every System view the worker posted, in order. */
const systemPosts = (mounted: MountedScene): SystemView[] =>
  mounted.worker.posts.filter((post) => post.event === 'system.changed').map((post) => post.payload as SystemView)

/** The view with the greatest `since`, as a frame keeps it. */
function newest(views: SystemView[]): SystemView {
  return views.reduce((kept, next) => (next.since > kept.since ? next : kept))
}

describe('the System group', () => {
  // What each release's recorded health answer holds, read by eye from the fixture files.
  const expected: Record<Release, { storeId: string | null }> = {
    '0.12.1': { storeId: null },
    '0.13.2': { storeId: '<store-id>' },
    '0.14.0': { storeId: '<store-id>' }
  }
  for (const release of RELEASES) {
    test(`reads the recorded health of ${release} into the System rows`, async () => {
      const { mounted } = await connectedTo(release)
      const { connection, system } = await mounted.worker.request('system.open')
      assert.equal(connection.kind, 'connected')
      assert.deepEqual(system.health, {
        status: 'ok',
        adapter: 'web',
        database: null,
        version: release,
        storeId: expected[release].storeId,
        concurrency: { active: 0, max: 10 },
        runningWorkflows: 0,
        platforms: { names: ['Web'], more: 0 }
      })
      assert.equal(system.failure, null)
      await mounted.worker.deactivate()
    })
  }

  const RELEASE_TAG = 'https://github.com/coleam00/Archon/releases/tag/v0.14.0'
  // What each release's recorded update check answered, read by eye from the fixture files.
  const updates: Record<Release, SystemView['updates']> = {
    '0.12.1': { kind: 'available', version: '0.14.0', releaseUrl: RELEASE_TAG },
    '0.13.2': { kind: 'available', version: '0.14.0', releaseUrl: RELEASE_TAG },
    '0.14.0': { kind: 'up-to-date', version: '0.14.0' }
  }
  for (const release of RELEASES) {
    test(`posts the recorded update check of ${release} once it answers`, async () => {
      const { mounted } = await connectedTo(release)
      const { system } = await mounted.worker.request('system.open')
      await settle()
      // A frame keeps the newest view, whichever of the answer and the post came last.
      const shown = newest([system, ...systemPosts(mounted)])
      assert.deepEqual(shown.updates, updates[release])
      assert.equal(shown.health?.version, release)
      await mounted.worker.deactivate()
    })
  }

  test('says "Checking" while the update check is out, and "unavailable" when it times out', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    stage.archon.answer(UPDATE_CHECK, HANG)
    const { system } = await mounted.worker.request('system.open')
    assert.deepEqual(system.updates, { kind: 'checking' })
    assert.equal(system.health?.version, '0.12.1')
    await stage.clock.advance(10_000)
    assert.deepEqual(systemPosts(mounted).at(-1)?.updates, { kind: 'unavailable' })
    await mounted.worker.deactivate()
  })

  /** How many times health and the update check were called since the mark. */
  function callsSince(stage: ReturnType<typeof scene>, mark: number): { health: number; updates: number } {
    const later = stage.archon.calls.slice(mark).map((call) => call.url)
    return {
      health: later.filter((url) => url === DEFAULT_HEALTH).length,
      updates: later.filter((url) => url === UPDATE_CHECK).length
    }
  }

  test('reads health every 30 seconds while the section shows, and the update check only on open', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    const mark = stage.archon.calls.length
    await mounted.worker.request('system.open')
    await settle()
    assert.deepEqual(callsSince(stage, mark), { health: 1, updates: 1 })
    await stage.clock.advance(29_999)
    assert.deepEqual(callsSince(stage, mark), { health: 1, updates: 1 })
    await stage.clock.advance(1)
    assert.deepEqual(callsSince(stage, mark), { health: 2, updates: 1 })
    await stage.clock.advance(60_000)
    assert.deepEqual(callsSince(stage, mark), { health: 4, updates: 1 })
    // Each timed read is posted.
    assert.equal(systemPosts(mounted).filter((view) => view.health !== null).length >= 3, true)
    await mounted.worker.deactivate()
  })

  test('reads nothing on the timer once the section no longer shows', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('system.open')
    await settle()
    assert.equal(await mounted.worker.request('system.close'), null)
    const mark = stage.archon.calls.length
    await stage.clock.advance(120_000)
    assert.deepEqual(callsSince(stage, mark), { health: 0, updates: 0 })
    assert.deepEqual(stage.clock.waiting(), [])
    await mounted.worker.deactivate()
  })

  test('Refresh reads health and the update check at once, and the timer starts over', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('system.open')
    await stage.clock.advance(20_000)
    const mark = stage.archon.calls.length
    const { system } = await mounted.worker.request('system.refresh')
    await settle()
    assert.equal(system.health?.version, '0.14.0')
    assert.deepEqual(callsSince(stage, mark), { health: 1, updates: 1 })
    await stage.clock.advance(29_999)
    assert.deepEqual(callsSince(stage, mark), { health: 1, updates: 1 })
    await stage.clock.advance(1)
    assert.deepEqual(callsSince(stage, mark), { health: 2, updates: 1 })
    await mounted.worker.deactivate()
  })

  test('stops reading when the worker is deactivated', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('system.open')
    await mounted.worker.deactivate()
    assert.deepEqual(stage.clock.waiting(), [])
  })

  test('refuses a request that carries an input', async () => {
    const { mounted } = await connectedTo('0.14.0')
    for (const name of ['system.open', 'system.refresh', 'system.close'] as const) {
      await assert.rejects(mounted.worker.request(name, { refresh: true } as never), /takes no input/)
    }
    await mounted.worker.deactivate()
  })

  test('a timed read still out when the section closes sets no new timer', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('system.open')
    await settle()
    stage.archon.answer(DEFAULT_HEALTH, HANG)
    await stage.clock.advance(30_000)
    await mounted.worker.request('system.close')
    // The read times out after 10 seconds.
    await stage.clock.advance(10_000)
    const mark = stage.archon.calls.length
    await stage.clock.advance(120_000)
    assert.deepEqual(callsSince(stage, mark), { health: 0, updates: 0 })
    await mounted.worker.deactivate()
  })

  test('names at most 20 platforms and counts the rest', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    const names = Array.from({ length: 23 }, (_, index) => `Platform ${index + 1}`)
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: '<store-id>', version: '0.14.0', activePlatforms: names }))
    const { system } = await mounted.worker.request('system.open')
    assert.deepEqual(system.health?.platforms, {
      names: names.slice(0, 20),
      more: 3
    })
    assert.equal(system.health?.platforms?.names.at(-1), 'Platform 20')
    await mounted.worker.deactivate()
  })

  test('reads a field the server did not send, or sent in another shape, as missing', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, json({ status: 'ok' }))
    stage.archon.answer(UPDATE_CHECK, json({ updateAvailable: 'yes' }))
    const mounted = await stage.mount()
    const missing = {
      status: 'ok',
      adapter: null,
      database: null,
      version: null,
      storeId: null,
      concurrency: null,
      runningWorkflows: null,
      platforms: null
    }
    assert.deepEqual((await mounted.worker.request('system.open')).system.health, missing)
    await settle()
    assert.deepEqual(systemPosts(mounted).at(-1)?.updates, { kind: 'unavailable' })

    const odd = {
      status: 'ok',
      adapter: 7,
      database: '',
      version: ['0.14.0'],
      concurrency: { active: '2', maxConcurrent: 10 },
      runningWorkflows: -1,
      activePlatforms: 'Web'
    }
    stage.archon.answer(DEFAULT_HEALTH, json(odd))
    assert.deepEqual((await mounted.worker.request('system.refresh')).system.health, missing)
    await mounted.worker.deactivate()
  })

  test('links the latest version only to an https address on github.com', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    const cases: [releaseUrl: unknown, link: string | null][] = [
      ['https://github.com/coleam00/Archon/releases/tag/v0.14.0', 'https://github.com/coleam00/Archon/releases/tag/v0.14.0'],
      ['http://github.com/coleam00/Archon/releases/tag/v0.14.0', null],
      ['https://github.com.example.com/releases', null],
      ['https://example.com/github.com', null],
      ['https://someone@github.com/coleam00/Archon', null],
      ['https://github.com:8443/coleam00/Archon', null],
      ['javascript:alert(1)', null],
      ['not an address', null],
      ['', null],
      [42, null]
    ]
    for (const [releaseUrl, link] of cases) {
      stage.archon.answer(UPDATE_CHECK, json({ updateAvailable: true, currentVersion: '0.12.1', latestVersion: '0.14.0', releaseUrl }))
      const { system } = await mounted.worker.request('system.refresh')
      await settle()
      assert.deepEqual(
        newest([system, ...systemPosts(mounted)]).updates,
        { kind: 'available', version: '0.14.0', releaseUrl: link },
        String(releaseUrl)
      )
    }
    await mounted.worker.deactivate()
  })

  test('a source build that answers "no update" with no link is up to date', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    stage.archon.answer(UPDATE_CHECK, json({ updateAvailable: false, currentVersion: '0.12.1', latestVersion: '0.12.1', releaseUrl: '' }))
    const { system } = await mounted.worker.request('system.open')
    await settle()
    assert.deepEqual(newest([system, ...systemPosts(mounted)]).updates, { kind: 'up-to-date', version: '0.12.1' })
    await mounted.worker.deactivate()
  })

  test('an update check Archon refuses is unavailable', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    stage.archon.answer(UPDATE_CHECK, json({ error: 'GitHub did not answer' }, 502))
    const { system } = await mounted.worker.request('system.open')
    await settle()
    assert.deepEqual(newest([system, ...systemPosts(mounted)]).updates, { kind: 'unavailable' })
    await mounted.worker.deactivate()
  })

  test('a failed health read keeps the last answer, marked as failed, with the time it was read', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    const first = (await mounted.worker.request('system.open')).system
    assert.equal(first.readAt, CLOCK_START)
    stage.archon.answer(DEFAULT_HEALTH, REFUSE)
    await stage.clock.advance(30_000)
    const failed = systemPosts(mounted).at(-1)
    assert.equal(failed?.failure, 'Archon did not answer.')
    assert.deepEqual(failed?.health, first.health)
    assert.equal(failed?.readAt, CLOCK_START)

    stage.archon.answer(DEFAULT_HEALTH, recorded('0.14.0', 'health'))
    const again = (await mounted.worker.request('system.refresh')).system
    assert.equal(again.failure, null)
    assert.equal(again.readAt, CLOCK_START + 30_000)
    await mounted.worker.deactivate()
  })

  test('asks Archon nothing while not Connected', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    assert.equal(mounted.latest().kind, 'not-found')
    const mark = stage.archon.calls.length
    const { connection, system } = await mounted.worker.request('system.open')
    assert.equal(connection.kind, 'not-found')
    assert.equal(system.health, null)
    await settle()
    assert.deepEqual(callsSince(stage, mark), { health: 0, updates: 0 })
    await mounted.worker.deactivate()
  })

  test('opened before Connected, reads health and the update check once it connects', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    assert.equal(mounted.latest().kind, 'not-found')
    await mounted.worker.request('system.open')
    stage.archon.answer(DEFAULT_HEALTH, recorded('0.14.0', 'health'))
    stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
    stage.archon.answer(UPDATE_CHECK, recorded('0.14.0', 'update-check'))
    const mark = stage.archon.calls.length
    await mounted.worker.request('connection.retry')
    await settle()
    assert.equal(mounted.latest().kind, 'connected')
    assert.deepEqual(callsSince(stage, mark).updates, 1)
    const view = newest(systemPosts(mounted))
    assert.equal(view.health?.version, '0.14.0')
    assert.deepEqual(view.updates, { kind: 'up-to-date', version: '0.14.0' })
    await mounted.worker.deactivate()
  })

  test('opened and closed before Connected, reads nothing once it connects', async () => {
    const stage = scene()
    const mounted = await stage.mount()
    await mounted.worker.request('system.open')
    await mounted.worker.request('system.close')
    stage.archon.answer(DEFAULT_HEALTH, recorded('0.14.0', 'health'))
    stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
    stage.archon.answer(UPDATE_CHECK, recorded('0.14.0', 'update-check'))
    await mounted.worker.request('connection.retry')
    await settle()
    assert.equal(mounted.latest().kind, 'connected')
    assert.deepEqual(systemPosts(mounted), [])
    assert.equal(stage.archon.calls.some((call) => call.url === UPDATE_CHECK), false)
    await mounted.worker.deactivate()
  })

  test('says why a health read failed, in the words of the failed-read table', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('system.open')
    const cases: [Scripted, string][] = [
      [json({ error: 'boom' }, 500), 'Archon answered with an error (500).'],
      [html(), 'This Archon does not have this feature.'],
      [json(['not', 'health']), "Orchon could not read Archon's answer."]
    ]
    for (const [answer, words] of cases) {
      stage.archon.answer(DEFAULT_HEALTH, answer)
      assert.equal((await mounted.worker.request('system.refresh')).system.failure, words)
    }
    stage.archon.answer(DEFAULT_HEALTH, HANG)
    const pending = mounted.worker.request('system.refresh')
    await stage.clock.advance(10_000)
    assert.equal((await pending).system.failure, 'Archon did not answer within 10 seconds.')
    await mounted.worker.deactivate()
  })

  test('calls no /api/auth route on open, Refresh or the timer', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('system.open')
    await mounted.worker.request('system.refresh')
    await stage.clock.advance(90_000)
    const paths = stage.archon.calls.map((call) => new URL(call.url).pathname)
    assert.deepEqual(
      paths.filter((path) => path.startsWith('/api/auth')),
      []
    )
    assert.deepEqual([...new Set(paths)].sort(), ['/api/health', '/api/openapi.json', '/api/update-check'])
    await mounted.worker.deactivate()
  })
})

describe('the routes the shipped source names', () => {
  test('no file Orca loads names an /api/auth route', () => {
    const shipped = listRepoFiles()
      .map((file) => file.path)
      .filter((path) => /^(?:src|editors)\//.test(path) && !/\.(?:test|check)\.[a-z]+$/.test(path))
      .filter((path) => hasExtension(path, [...CODE_EXTENSIONS, 'html']))
    assert.ok(shipped.includes('src/system.ts'))
    assert.deepEqual(
      shipped.filter((path) => readRepoText(path).includes('/api/auth')),
      []
    )
  })
})
