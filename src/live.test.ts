// The worker's request protocol seam: the worker mounted on a scripted Archon and clock. These
// tests cover live updates: the dashboard stream the worker holds while Connected, the hints it
// posts, the watchdog and the backoff, and what is left when it stops. The stream's frames are
// scripted the way Archon's `streamSSE` writes them; no recorded fixture holds a stream.
import { assert, describe, test } from 'orca/testing'
import {
  CLOCK_START,
  DEFAULT,
  DEFAULT_HEALTH,
  HANG,
  health,
  kinds,
  openStream,
  REFUSE,
  scene,
  settle,
  type MountedScene,
  type Scene,
  type ScriptedStream
} from '../scripts/scripted-archon.ts'
import type { FetchAnswer, FetchLike } from './client'
import { DASHBOARD_RUNS_PATH } from './dashboard-runs'

const STREAM = `${DEFAULT}/api/stream/__dashboard__`
const RUNS_PAGE = `${DEFAULT}${DASHBOARD_RUNS_PATH}?limit=50&offset=0`

/** A connected scene whose dashboard stream answers each open with a fresh held-open stream. */
function connectedScene(): { stage: Scene; streams: ScriptedStream[] } {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health())
  const streams: ScriptedStream[] = []
  stage.archon.answer(STREAM, () => {
    const stream = openStream()
    streams.push(stream)
    return stream
  })
  return { stage, streams }
}

const frame = (fields: Record<string, unknown>): string => `data: ${JSON.stringify(fields)}\n\n`
const HEARTBEAT = frame({ type: 'heartbeat', timestamp: 1 })

/** Every hint the worker posted, in order. */
function hints(mounted: MountedScene): unknown[] {
  return mounted.worker.posts.filter((post) => post.event === 'runs.changed').map((post) => post.payload)
}

/** Whether each Connected state posted was live, in order. */
function liveness(mounted: MountedScene): boolean[] {
  return mounted.posted().flatMap((state) => (state.kind === 'connected' ? [state.live] : []))
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1)
  if (item === undefined) throw new Error('Nothing there.')
  return item
}

describe('the dashboard stream', () => {
  test('is opened once Connected, and Connected says it is live', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    assert.deepEqual(
      stage.archon.streams.map((call) => [call.url, call.method, call.redirect, call.headers]),
      [[STREAM, 'GET', 'manual', { accept: 'text/event-stream' }]]
    )
    assert.equal(streams.length, 1)
    // Connected is entered taking the stream as live, so nothing more is posted once it opens.
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
    assert.deepEqual(liveness(mounted), [true])
    assert.deepEqual(mounted.worker.refusals, [])
    await mounted.worker.deactivate()
  })

  test('posts a hint naming the frame type and the run, and ignores heartbeats', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    const stream = last(streams)
    stream.send(HEARTBEAT)
    stream.send(frame({ type: 'workflow_tool_activity', runId: 'run-1' }))
    await settle()
    assert.deepEqual(hints(mounted), [])
    stream.send(frame({ type: 'workflow_status', runId: 'run-1', workflowName: 'plan', status: 'paused' }))
    await settle()
    // The hint carries the type and the id only: nothing of the run's data.
    assert.deepEqual(hints(mounted), [{ types: ['workflow_status'], runs: ['run-1'] }])
    await mounted.worker.deactivate()
  })

  test('folds the runs of one second into one hint, at most one hint a second', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    const stream = last(streams)
    stream.send(frame({ type: 'dag_node', runId: 'run-1', nodeId: 'a' }))
    await settle()
    assert.deepEqual(hints(mounted), [{ types: ['dag_node'], runs: ['run-1'] }])
    await stage.clock.advance(300)
    // A frame split across two chunks, and a run named twice.
    stream.send('data: {"type":"dag_node","run')
    stream.send('Id":"run-2"}\n\n')
    stream.send(frame({ type: 'workflow_status', runId: 'run-3' }) + frame({ type: 'dag_node', runId: 'run-2' }))
    await stage.clock.advance(699)
    assert.equal(hints(mounted).length, 1)
    await stage.clock.advance(1)
    assert.deepEqual(hints(mounted), [
      { types: ['dag_node'], runs: ['run-1'] },
      { types: ['workflow_status', 'dag_node'], runs: ['run-2', 'run-3'] }
    ])
    // A quiet second posts nothing.
    await stage.clock.advance(5_000)
    assert.equal(hints(mounted).length, 2)
    await mounted.worker.deactivate()
  })

  test('says "many" in place of the ids past 50 runs', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    const stream = last(streams)
    stream.send(frame({ type: 'dag_node', runId: 'first' }))
    await settle()
    const fifty = Array.from({ length: 50 }, (_, index) => frame({ type: 'workflow_status', runId: `run-${String(index)}` }))
    stream.send(fifty.join(''))
    await stage.clock.advance(1_000)
    assert.deepEqual(hints(mounted).at(-1), { types: ['workflow_status'], runs: fifty.map((_, index) => `run-${String(index)}`) })
    stream.send(fifty.join('') + frame({ type: 'workflow_status', runId: 'one-more' }))
    await stage.clock.advance(1_000)
    assert.deepEqual(hints(mounted).at(-1), { types: ['workflow_status'], runs: 'many' })
    await mounted.worker.deactivate()
  })
})

describe('keeping the stream open', () => {
  test('reopens the stream after 75 seconds of silence, and posts "many" on the reconnect', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    last(streams).send(HEARTBEAT)
    await stage.clock.advance(30_000)
    // Anything read starts the silence over.
    last(streams).send(HEARTBEAT)
    await stage.clock.advance(74_999)
    assert.equal(streams.length, 1)
    await stage.clock.advance(1)
    assert.equal(streams.length, 2)
    assert.equal(streams[0]?.closed, true)
    assert.deepEqual(liveness(mounted), [true, false, true])
    assert.deepEqual(hints(mounted), [{ types: ['workflow_status', 'dag_node'], runs: 'many' }])
    await mounted.worker.deactivate()
  })

  test('also gives up on an open that has not answered after 75 seconds', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const mounted = await stage.mount()
    // An unscripted stream takes the connection and never answers.
    await stage.clock.advance(74_999)
    assert.equal(stage.archon.streams.length, 1)
    await stage.clock.advance(1)
    assert.equal(stage.archon.streams.length, 2)
    assert.deepEqual(liveness(mounted), [true, false])
    assert.deepEqual(hints(mounted), [])
    await mounted.worker.deactivate()
  })

  test('retries a stream that will not open after 1 second, doubling to one try every 30 seconds', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const times: number[] = []
    stage.archon.answer(STREAM, () => {
      times.push(stage.clock.now() - CLOCK_START)
      return openStream({ status: 404 })
    })
    const mounted = await stage.mount()
    await stage.clock.advance(150_000)
    assert.deepEqual(times, [0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000, 121_000])
    // Archon answers its other calls all along: the state stays Connected, and is not live from the first failure.
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'connected'])
    assert.deepEqual(liveness(mounted), [true, false])
    await mounted.worker.deactivate()
  })

  test('a stream that breaks or ends is retried after 1 second, the backoff started over once it opened', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    last(streams).break()
    await stage.clock.advance(999)
    assert.equal(streams.length, 1)
    await stage.clock.advance(1)
    assert.equal(streams.length, 2)
    last(streams).end()
    await stage.clock.advance(1_000)
    assert.equal(streams.length, 3)
    assert.deepEqual(liveness(mounted), [true, false, true, false, true])
    // Each reopening is a reconnect: frames may have been lost meanwhile.
    assert.deepEqual(hints(mounted), [
      { types: ['workflow_status', 'dag_node'], runs: 'many' },
      { types: ['workflow_status', 'dag_node'], runs: 'many' }
    ])
    await mounted.worker.deactivate()
  })

  test('a refused connection on the stream moves the state to Searching, and the stream opens at once after the rediscovery', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const opens: number[] = []
    stage.archon.answer(STREAM, () => {
      opens.push(stage.clock.now() - CLOCK_START)
      return opens.length === 1 ? REFUSE : openStream()
    })
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching'])
    // Discovery runs again on its own backoff, and the stream is opened the moment it connects.
    await stage.clock.advance(2_000)
    assert.deepEqual(
      stage.archon.calls.map((call) => new URL(call.url).pathname),
      ['/api/health', '/api/openapi.json', '/api/health', '/api/openapi.json']
    )
    assert.deepEqual(opens, [0, 2_000])
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching', 'connected'])
    assert.equal(last(liveness(mounted)), true)
    await mounted.worker.deactivate()
  })

  test('a refused connection on the stream from a server that has stopped keeps the grace before Not found', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    stage.archon.answer(STREAM, () => {
      stage.archon.answer(DEFAULT_HEALTH, REFUSE)
      return REFUSE
    })
    const mounted = await stage.mount()
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching'])
    // Discovery looks every 2 seconds and the state stays Searching for 20 seconds, as for any refused call.
    await stage.clock.advance(19_999)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching'])
    await stage.clock.advance(1)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'searching', 'not-found'])
    await mounted.worker.deactivate()
  })

  test('a server that answers health and keeps refusing the stream is asked at the pace of discovery, not in a loop', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health())
    const opens: number[] = []
    stage.archon.answer(STREAM, () => {
      opens.push(stage.clock.now() - CLOCK_START)
      return REFUSE
    })
    const mounted = await stage.mount()
    await stage.clock.advance(10_000)
    assert.deepEqual(opens, [0, 2_000, 4_000, 6_000, 8_000, 10_000])
    await mounted.worker.deactivate()
  })

  test('after any rediscovery the stream is tried again at once, with the backoff started over', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
    const times: number[] = []
    stage.archon.answer(STREAM, () => {
      times.push(stage.clock.now() - CLOCK_START)
      return openStream({ status: 503 })
    })
    const mounted = await stage.mount()
    // A runs read that hangs times out at 10 seconds, and the health check it sends finds another
    // store there: discovery connects afresh.
    stage.archon.answer(RUNS_PAGE, HANG)
    void mounted.worker.request('runs.read', { status: 'all', rows: 25 })
    await stage.clock.advance(9_999)
    assert.deepEqual(times, [0, 1_000, 3_000, 7_000])
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-b' }))
    await stage.clock.advance(1)
    assert.deepEqual(kinds(mounted), ['searching', 'connected', 'connected', 'searching', 'connected', 'connected'])
    assert.deepEqual(times, [0, 1_000, 3_000, 7_000, 10_000])
    await stage.clock.advance(1_000)
    assert.deepEqual(times, [0, 1_000, 3_000, 7_000, 10_000, 11_000])
    await mounted.worker.deactivate()
  })

  test('closes the stream and clears its timers when the state leaves Connected', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    await mounted.orca.settings.set('baseUrl', 'not a url')
    await stage.clock.advance(0)
    assert.equal(mounted.latest().kind, 'bad-setting')
    assert.equal(last(streams).closed, true)
    await stage.clock.advance(1_000)
    assert.deepEqual(stage.clock.waiting(), [])
    await mounted.worker.deactivate()
  })

  test('clears every timer, the waiting hint included, when the worker is deactivated', async () => {
    const { stage, streams } = connectedScene()
    const mounted = await stage.mount()
    const stream = last(streams)
    stream.send(frame({ type: 'dag_node', runId: 'run-1' }))
    await settle()
    stream.send(frame({ type: 'dag_node', runId: 'run-2' }))
    await settle()
    // The watchdog, the second hint, the status bar item and the snapshot's safety read wait.
    assert.equal(stage.clock.waiting().length, 4)
    await mounted.worker.deactivate()
    assert.deepEqual(stage.clock.waiting(), [])
    assert.equal(stream.closed, true)
    await stage.clock.advance(120_000)
    assert.equal(hints(mounted).length, 1)
    assert.equal(streams.length, 1)
  })
})

describe('failures in the stream code', () => {
  /** Runs a connected worker whose stream transport fails as `broken` does, and returns what went unhandled. */
  async function unhandledWith(broken: FetchLike): Promise<{ unhandled: unknown[]; kind: string }> {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const stage = scene()
      stage.archon.answer(DEFAULT_HEALTH, health())
      const scripted = stage.archon.fetch
      stage.archon.fetch = (url, init) => (url === STREAM ? broken(url, init) : scripted(url, init))
      const mounted = await stage.mount()
      await stage.clock.advance(70_000)
      // Gives a rejection the process would report the time to be reported.
      await new Promise((resolve) => setTimeout(resolve, 20))
      const kind = mounted.latest().kind
      await mounted.worker.deactivate()
      return { unhandled, kind }
    } finally {
      process.off('unhandledRejection', record)
    }
  }

  const answer = (body: AsyncIterable<Uint8Array>): FetchAnswer => ({
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body
  })

  test('a transport that throws where it should answer leaves no rejection unhandled', async () => {
    const result = await unhandledWith(() => {
      throw new Error('transport broke')
    })
    // A transport that throws is a refused connection, so the state is back in Searching.
    assert.deepEqual(result, { unhandled: [], kind: 'searching' })
  })

  test('a body whose reads and whose closing both reject leaves no rejection unhandled', async () => {
    const result = await unhandledWith(() =>
      Promise.resolve(
        answer({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('read failed')),
            return: () => Promise.reject(new Error('close failed'))
          })
        })
      )
    )
    assert.deepEqual(result, { unhandled: [], kind: 'connected' })
  })

  test('a body that never answers a read, nor its closing, leaves nothing unhandled when dropped', async () => {
    const result = await unhandledWith(() =>
      Promise.resolve(
        answer({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
            return: () => new Promise<IteratorResult<Uint8Array>>(() => {})
          })
        })
      )
    )
    assert.deepEqual(result, { unhandled: [], kind: 'connected' })
  })
})
