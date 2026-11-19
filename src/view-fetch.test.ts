// Pure logic: the per-view fetch rules every view of the panel and the tabs shares. Driven with
// the scripted clock, and loads the test settles by hand.
import { assert, describe, hostError, test } from 'orca/testing'
import { createClock, settle } from '../scripts/scripted-archon.ts'
import { createViewFetch, type ViewFetch } from './view-fetch'

/** A load the test answers by hand, recording when each one started and whether it was aborted. */
type Pending = { at: number; signal: AbortSignal; answer(value: string): void; reject(error: unknown): void }

function harness(options: { minGapMs?: number; safetyMs?: number } = {}) {
  const clock = createClock(0)
  const loads: Pending[] = []
  const applied: string[] = []
  const failed: unknown[] = []
  const view: ViewFetch = createViewFetch<string>({
    load: (signal) =>
      new Promise<string>((resolve, reject) => {
        loads.push({ at: clock.now(), signal, answer: resolve, reject })
      }),
    apply: (value) => applied.push(value),
    fail: (error) => failed.push(error),
    minGapMs: options.minGapMs ?? 2_000,
    safetyMs: options.safetyMs ?? 30_000,
    now: clock.now,
    timers: clock.timers
  })
  const last = (): Pending => {
    const pending = loads.at(-1)
    if (pending === undefined) throw new Error('Nothing was loaded.')
    return pending
  }
  return { clock, loads, applied, failed, view, last }
}

describe('the per-view fetch rules', () => {
  test('a user action loads at once and applies the answer', async () => {
    const { view, loads, applied, last } = harness()
    view.restart()
    assert.equal(loads.length, 1)
    last().answer('first')
    await settle()
    assert.deepEqual(applied, ['first'])
    view.stop()
  })

  test('only the answer to the newest request is applied, and the older one is aborted', async () => {
    const { view, loads, applied } = harness()
    view.restart()
    view.restart()
    assert.equal(loads.length, 2)
    assert.equal(loads[0]?.signal.aborted, true)
    assert.equal(loads[1]?.signal.aborted, false)
    loads[1]?.answer('newest')
    loads[0]?.answer('older')
    await settle()
    assert.deepEqual(applied, ['newest'])
    view.stop()
  })

  test('a failure of an older request is not reported either', async () => {
    const { view, loads, failed } = harness()
    view.restart()
    view.restart()
    loads[0]?.reject(new Error('aborted'))
    loads[1]?.reject(new Error('real'))
    await settle()
    assert.deepEqual(
      failed.map((error) => (error as Error).message),
      ['real']
    )
    view.stop()
  })

  test('one fetch in flight: refreshes meanwhile queue one more, which waits out the gap', async () => {
    const { view, loads, clock, last } = harness()
    view.restart()
    view.refresh()
    view.refresh()
    view.refresh()
    assert.equal(loads.length, 1)
    await clock.advance(500)
    last().answer('a')
    await settle()
    // The queued fetch starts 2 seconds after the one before it started, not at once.
    assert.equal(loads.length, 1)
    await clock.advance(1_499)
    assert.equal(loads.length, 1)
    await clock.advance(1)
    assert.equal(loads.length, 2)
    assert.equal(last().at, 2_000)
    last().answer('b')
    await settle()
    // Only one was queued.
    await clock.advance(5_000)
    assert.equal(loads.length, 2)
    view.stop()
  })

  test('a refresh inside the gap waits for it; one after the gap loads at once', async () => {
    const { view, loads, clock, last } = harness()
    view.restart()
    last().answer('a')
    await clock.advance(1_000)
    view.refresh()
    view.refresh()
    assert.equal(loads.length, 1)
    await clock.advance(1_000)
    assert.equal(loads.length, 2)
    last().answer('b')
    await clock.advance(3_000)
    view.refresh()
    assert.equal(loads.length, 3)
    view.stop()
  })

  test('the gap is the one the view names', async () => {
    const { view, loads, clock, last } = harness({ minGapMs: 1_000 })
    view.restart()
    last().answer('a')
    view.refresh()
    await clock.advance(999)
    assert.equal(loads.length, 1)
    await clock.advance(1)
    assert.equal(loads.length, 2)
    view.stop()
  })

  test('a user action ignores the gap and the queue', async () => {
    const { view, loads, clock, last } = harness()
    view.restart()
    view.refresh()
    view.restart()
    assert.equal(loads.length, 2)
    last().answer('b')
    await clock.advance(5_000)
    // The refresh queued behind the aborted fetch was dropped with it.
    assert.equal(loads.length, 2)
    view.stop()
  })

  test('refetches by itself 30 seconds after the last fetch ended', async () => {
    const { view, loads, clock, last } = harness()
    view.restart()
    await clock.advance(1_000)
    last().answer('a')
    await clock.advance(29_999)
    assert.equal(loads.length, 1)
    await clock.advance(1)
    assert.equal(loads.length, 2)
    last().reject(new Error('down'))
    // A failed fetch keeps the safety refetch going.
    await clock.advance(30_000)
    assert.equal(loads.length, 3)
    view.stop()
  })

  test('stop clears every timer and drops an answer that arrives after it', async () => {
    const { view, clock, applied, failed, last } = harness()
    view.restart()
    view.refresh()
    const pending = last()
    view.stop()
    assert.equal(pending.signal.aborted, true)
    assert.deepEqual(clock.waiting(), [])
    pending.answer('late')
    await clock.advance(60_000)
    assert.deepEqual(applied, [])
    assert.deepEqual(failed, [])
    view.restart()
    view.refresh()
    assert.deepEqual(clock.waiting(), [])
  })

  test('a read rejected as rate_limited waits retryAfterMs and is sent once more', async () => {
    const { view, loads, clock, applied, failed, last } = harness()
    view.restart()
    last().reject(hostError('rate_limited', 'Too many requests.', 1_500))
    await clock.advance(1_499)
    assert.equal(loads.length, 1)
    assert.deepEqual(failed, [])
    await clock.advance(1)
    assert.equal(loads.length, 2)
    last().answer('after the wait')
    await settle()
    assert.deepEqual(applied, ['after the wait'])
    view.stop()
  })

  test('a read rate-limited again is not sent a third time until the safety refetch', async () => {
    const { view, loads, clock, failed, last } = harness()
    view.restart()
    last().reject(hostError('rate_limited', 'Too many requests.', 100))
    await clock.advance(100)
    last().reject(hostError('rate_limited', 'Too many requests.', 100))
    await clock.advance(29_999)
    assert.equal(loads.length, 2)
    assert.equal(failed.length, 1)
    await clock.advance(1)
    assert.equal(loads.length, 3)
    view.stop()
  })

  test('a newer fetch drops the wait of a rate-limited one, and stop clears it', async () => {
    const { view, loads, clock, last } = harness()
    view.restart()
    last().reject(hostError('rate_limited', 'Too many requests.', 1_000))
    await settle()
    view.stop()
    assert.deepEqual(clock.waiting(), [])
    await clock.advance(5_000)
    assert.equal(loads.length, 1)
  })

  test('consent_required is reported and sets no safety refetch', async () => {
    const { view, loads, clock, failed, last } = harness()
    view.restart()
    last().reject(hostError('consent_required', 'Turned off.'))
    await settle()
    assert.equal(failed.length, 1)
    assert.deepEqual(clock.waiting(), [])
    await clock.advance(120_000)
    assert.equal(loads.length, 1)
    // A person's action still fetches.
    view.restart()
    assert.equal(loads.length, 2)
    view.stop()
  })
})
