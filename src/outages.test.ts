// The worker's request protocol seam: the worker mounted on a scripted Archon, clock and disk.
// These tests cover what the connection state does when a connected Archon restarts, hangs or
// stops: the grace before Not found, and the health check after a call times out.
import { assert, describe, test } from 'orca/testing'
import {
  ARCHON_HOME,
  CLOCK_START as START,
  DEFAULT,
  DEFAULT_HEALTH,
  HANG,
  health,
  kinds,
  REFUSE,
  scene,
  type MountedScene,
  type Scene
} from '../scripts/scripted-archon.ts'
import { DASHBOARD_RUNS_PATH } from './dashboard-runs'
import type { RunsAnswer } from './runs-view'

const RUNS_PAGE = `${DEFAULT}${DASHBOARD_RUNS_PATH}?limit=50&offset=0`

/** Records the clock time, from the start, of every health call to the default address. */
function healthTimes(stage: Scene, answer: () => ReturnType<typeof health> = () => REFUSE): number[] {
  const times: number[] = []
  stage.archon.answer(DEFAULT_HEALTH, () => {
    times.push(stage.clock.now() - START)
    return answer()
  })
  return times
}

/** A runs table read, as a frame sends it, once what it set off has run. */
async function readRuns(stage: Scene, mounted: MountedScene): Promise<RunsAnswer> {
  const answer = mounted.worker.request('runs.read', { status: 'all', rows: 25 }) as Promise<RunsAnswer>
  await stage.clock.advance(0)
  return answer
}

/** A scene connected to the default address, with the home folder in place. */
async function connectedScene(): Promise<{ stage: Scene; mounted: MountedScene }> {
  const stage = scene()
  stage.disk.folders.add(ARCHON_HOME)
  stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
  const mounted = await stage.mount()
  assert.deepEqual(kinds(mounted), ['searching', 'connected'])
  return { stage, mounted }
}

describe('the grace before Not found', () => {
  test('a server lost from Connected stays Searching for 20 seconds, looking every 2, then is Not found', async () => {
    const { stage, mounted } = await connectedScene()
    const lostAt = stage.clock.now() - START
    const times = healthTimes(stage)
    // A refused call is how a stopped Archon shows itself first.
    await readRuns(stage, mounted)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching'])
    await stage.clock.advance(19_999)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching'])
    await stage.clock.advance(1)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching', 'not-found'])
    assert.deepEqual(
      times.map((time) => time - lostAt),
      [0, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 14_000, 16_000, 18_000, 20_000]
    )
    // Not found then looks on its own backoff, 2 seconds first.
    assert.ok(stage.clock.waiting().includes(2_000))
  })
})

describe('the grace, continued', () => {
  test('a server back within the grace connects again and never reaches Not found', async () => {
    const { stage, mounted } = await connectedScene()
    healthTimes(stage)
    await readRuns(stage, mounted)
    await stage.clock.advance(11_000)
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
    await stage.clock.advance(1_000)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching', 'connected'])
    await stage.clock.advance(60_000)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching', 'connected'])
  })

  test('a server lost from Unsupported goes straight to Not found', async () => {
    const stage = scene()
    stage.disk.folders.add(ARCHON_HOME)
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer(`${DEFAULT}/api/openapi.json`, { kind: 'json', value: { paths: {} } })
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported'])
    stage.archon.answer(DEFAULT_HEALTH, REFUSE)
    await stage.clock.advance(30_000)
    assert.deepEqual(kinds(mounted), ['searching', 'unsupported', 'not-found'])
  })

  test('a frame reading the state sends nothing to Archon', async () => {
    const { stage, mounted } = await connectedScene()
    const before = stage.archon.calls.length
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a', version: '9.9.9' }))
    await mounted.read()
    await mounted.read()
    assert.equal(stage.archon.calls.length, before)
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
  })
})

describe('a call that times out', () => {
  test('sends one health check; when health answers, only that call fails and the state stays Connected', async () => {
    const { stage, mounted } = await connectedScene()
    stage.archon.answer(RUNS_PAGE, HANG)
    const times = healthTimes(stage, () => health({ storeId: 'store-a', version: '0.13.2' }))
    const answer = mounted.worker.request('runs.read', { status: 'all', rows: 25 }) as Promise<RunsAnswer>
    await stage.clock.advance(10_000)
    const { runs, connection } = await answer
    assert.deepEqual(runs, { kind: 'failed', message: 'Archon did not answer within 10 seconds.' })
    assert.equal(connection.kind, 'connected')
    assert.deepEqual(times, [10_000])
    await stage.clock.advance(60_000)
    // The version health reports decides nothing.
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
  })

  test('when health does not answer either, the state moves to Searching with the grace', async () => {
    const { stage, mounted } = await connectedScene()
    stage.archon.answer(RUNS_PAGE, HANG)
    const times = healthTimes(stage, () => HANG)
    void mounted.worker.request('runs.read', { status: 'all', rows: 25 })
    void mounted.worker.request('runs.read', { status: 'all', rows: 25 })
    await stage.clock.advance(10_000)
    // Two calls timed out together, and one health check is in flight.
    assert.deepEqual(times, [10_000])
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
    // From here nothing listens, while the check already sent waits out its 3 seconds.
    stage.archon.answer(DEFAULT_HEALTH, REFUSE)
    await stage.clock.advance(3_000)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching'])
    await stage.clock.advance(19_999)
    assert.equal(mounted.latest().kind, 'searching')
    await stage.clock.advance(1)
    assert.equal(mounted.latest().kind, 'not-found')
  })

  test('when another store answers health there, the worker connects to it afresh', async () => {
    const { stage, mounted } = await connectedScene()
    stage.archon.answer(RUNS_PAGE, HANG)
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-b' }))
    void mounted.worker.request('runs.read', { status: 'all', rows: 25 })
    await stage.clock.advance(10_000)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching', 'connected'])
    const state = mounted.latest()
    assert.equal(state.kind === 'connected' && state.storeId, 'store-b')
  })
})
