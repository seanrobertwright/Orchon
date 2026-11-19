// The frame seam for run detail: src/panel.tsx mounted on a scripted worker, opened on a run. These
// tests cover how run detail stays current and what it draws through an outage: the refetch a
// hint naming the run starts, its 1 second gap, the safety refetch, a failed read, Searching
// with data and Worker unreachable. The frame's timers are Node's mocked ones, moved by hand.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected, searching } from '../scripts/connection-samples.ts'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import type { Connected, ConnectionView } from './connection-view'
import * as panelModule from './panel'
import type { RunDetailAnswer, RunDetailRequest, RunDetailView } from './run-detail-view'
import type { RunsRequest } from './runs-view'

let panel: TestPanel | undefined
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 18, 12) })
})
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

const ready = (): RunDetailView => ({ kind: 'ready', detail: sampleDetail(1) })
const STEPS = { type: 'Tree', label: 'Steps' }
const TRY_AGAIN = { type: 'Button', text: 'Try again' }

/** Mounts the panel opened on run-1, with run detail answered by `answer`. */
async function openRun(
  answer: (request: RunDetailRequest) => RunDetailAnswer | RunDetailView = ready,
  state: Connected = connected
): Promise<TestPanel> {
  const base = answeringRun((request: RunsRequest) => busyRuns(40, request), ready, state)
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'run.read': (request: RunDetailRequest) => {
          const answered = answer(request)
          return Object.hasOwn(answered, 'connection') ? (answered as RunDetailAnswer) : { connection: state, run: answered as RunDetailView }
        }
      }
    }),
    persisted: { workspace: { section: 'runs', openRun: 'run-1' } }
  })
  return panel
}

/** How many run detail reads the panel has sent. */
const detailReads = (view: TestPanel): number =>
  view.host.callsOf('plugin.request').filter((params) => (params as { name: string }).name === 'run.read').length

async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

describe('run detail stays current', () => {
  test('refetches on a workflow_status or a dag_node hint that names the run, no sooner than 1 second after the last read', async () => {
    const view = await openRun()
    assert.equal(detailReads(view), 1)
    await view.post('runs.changed', { types: ['dag_node'], runs: ['run-1'] })
    assert.equal(detailReads(view), 1)
    await advance(view, 1_000)
    assert.equal(detailReads(view), 2)
    await view.post('runs.changed', { types: ['workflow_status'], runs: ['run-9', 'run-1'] })
    await advance(view, 1_000)
    assert.equal(detailReads(view), 3)
    await view.post('runs.changed', { types: ['dag_node'], runs: 'many' })
    await advance(view, 1_000)
    assert.equal(detailReads(view), 4)
  })

  test('a hint that names only other runs reads nothing, and neither the table', async () => {
    const view = await openRun()
    const tableReads = (): number =>
      view.host.callsOf('plugin.request').filter((params) => (params as { name: string }).name === 'runs.read').length
    await view.post('runs.changed', { types: ['workflow_status', 'dag_node'], runs: ['run-2'] })
    await advance(view, 5_000)
    assert.equal(detailReads(view), 1)
    assert.equal(tableReads(), 0)
  })

  test('a refetch after the first read does not ask the worker to look the sub-runs up at once', async () => {
    const view = await openRun()
    await view.post('runs.changed', { types: ['dag_node'], runs: ['run-1'] })
    await advance(view, 1_000)
    const inputs = view.host
      .callsOf('plugin.request')
      .filter((params) => (params as { name: string }).name === 'run.read')
      .map((params) => (params as { input: unknown }).input)
    assert.deepEqual(inputs, [{ runId: 'run-1', open: true }, { runId: 'run-1' }])
  })

  test('refetches every 30 seconds, and every 5 while live updates are off', async () => {
    const view = await openRun()
    await advance(view, 29_999)
    assert.equal(detailReads(view), 1)
    await advance(view, 1)
    assert.equal(detailReads(view), 2)
    await view.unmount()
    const off = await openRun(ready, { ...connected, live: false })
    await advance(off, 5_000)
    assert.equal(detailReads(off), 2)
  })

  test('clears its timers when the panel closes: nothing is read after it', async () => {
    const view = await openRun()
    await view.post('runs.changed', { types: ['dag_node'], runs: ['run-1'] })
    const reads = detailReads(view)
    await view.unmount()
    panel = undefined
    mock.timers.tick(120_000)
    await Promise.resolve()
    assert.equal(detailReads(view), reads)
  })
})

describe('run detail through an outage', () => {
  test('a failed refetch keeps the run under one warning line with the time of the last good answer and "Try again"', async () => {
    let fail = false
    const view = await openRun(() => (fail ? { kind: 'failed', message: 'Archon answered with an error (500).' } : ready()))
    fail = true
    await advance(view, 30_000)
    const line = view.find({ type: 'Callout' })?.text ?? ''
    assert.match(line, /^Archon answered with an error \(500\)\. Last good answer at \d{2}:\d{2}/)
    assert.ok(view.find(STEPS))
    fail = false
    await view.press(TRY_AGAIN)
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
  })

  test('a first read that fails shows the error in place of the run, with the way back', async () => {
    const view = await openRun(() => ({ kind: 'failed', message: 'Archon answered with an error (500).' }))
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Archon answered with an error \(500\)\. Try again$/)
    assert.equal(view.find(STEPS), null)
    assert.equal(view.findAll({ type: 'Spinner' }).length, 0)
    assert.ok(view.find({ type: 'Button', text: 'Runs' }))
  })

  test('Searching with data keeps the run under the banner', async () => {
    let state: ConnectionView = connected
    const view = await openRun(() => ({ connection: state, run: ready() }))
    state = { ...searching, since: connected.since + 1 }
    await view.post('connection.changed', state)
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Archon stopped answering/)
    assert.ok(view.find(STEPS))
  })

  test('Worker unreachable: a read the worker does not answer says so and offers "Try again"; a rate-limited read is sent once more', async () => {
    let mode: 'down' | 'limited' | 'up' = 'up'
    const view = await openRun(() => {
      if (mode === 'down') throw hostError('unavailable')
      if (mode === 'limited') {
        mode = 'up'
        throw hostError('rate_limited', 'slow down', 500)
      }
      return ready()
    })
    mode = 'down'
    await advance(view, 30_000)
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Orchon's background process is not answering\./)
    assert.ok(view.find(STEPS))
    mode = 'limited'
    await view.press(TRY_AGAIN)
    await advance(view, 500)
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
  })
})
