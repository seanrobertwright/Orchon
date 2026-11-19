// A tape keeps every request, answer and frame in the order they happened.
import { assert, describe, test } from 'orca/testing'
import type { Frame } from './frames.ts'
import type { Answer, LoopbackClient } from './http.ts'
import { createTape } from './recording.ts'

/** A stand-in release: scripted answers, and a stream the test pushes frames into. */
function scriptedClient(answers: Record<string, Answer | Error>) {
  let push: (frame: Frame) => void = () => undefined
  let end: (by: 'server' | 'recorder') => void = () => undefined
  const client: LoopbackClient = {
    port: 41000,
    async request(method, path) {
      const answer = answers[`${method} ${path}`]
      if (answer === undefined) return { status: 404, contentType: 'text/html', body: '<!doctype html>' }
      if (answer instanceof Error) throw answer
      return answer
    },
    async openStream(path, onFrame) {
      if (path === '/api/stream/refused') throw new Error('connect ECONNREFUSED')
      push = onFrame
      const ended = new Promise<{ by: 'server' | 'recorder' }>((resolve) => {
        end = (by) => resolve({ by })
      })
      return { status: 200, contentType: 'text/event-stream', ended, close: async () => end('recorder') }
    }
  }
  return { client, push: (frame: Frame) => push(frame), end: () => end('server') }
}

/** A clock the test moves by hand. */
function clock() {
  let now = 1000
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('a tape', () => {
  test('logs a request with its body, its answer and both times', async () => {
    const time = clock()
    const { client } = scriptedClient({
      'POST /api/conversations': { status: 200, contentType: 'application/json', body: { id: 'c1' } }
    })
    const tape = createTape(client, time.now)
    time.advance(40)
    const answer = await tape.call('POST', '/api/conversations', { codebaseId: 'p1' })
    assert.deepEqual(answer.body, { id: 'c1' })
    assert.deepEqual(tape.log, [
      {
        atMs: 40,
        kind: 'http',
        method: 'POST',
        path: '/api/conversations',
        requestBody: { codebaseId: 'p1' },
        startedMs: 40,
        status: 200,
        contentType: 'application/json',
        body: { id: 'c1' }
      }
    ])
  })

  test('logs a request with no body as null, and a failed request before it throws', async () => {
    const { client } = scriptedClient({ 'GET /api/health': new Error('fetch failed') })
    const tape = createTape(client, () => 0)
    await assert.rejects(tape.call('GET', '/api/health'), /fetch failed/)
    assert.deepEqual(tape.log, [
      { atMs: 0, kind: 'http-failed', method: 'GET', path: '/api/health', requestBody: null, startedMs: 0, error: 'Error: fetch failed' }
    ])
  })

  test('does not log a peek', async () => {
    const { client } = scriptedClient({})
    const tape = createTape(client, () => 0)
    assert.equal((await tape.peek('GET', '/api/missing')).status, 404)
    assert.deepEqual(tape.log, [])
  })

  test('logs a stream as its opening, each frame and its end, between the notes around them', async () => {
    const time = clock()
    const { client, push, end } = scriptedClient({})
    const tape = createTape(client, time.now)
    const reader = await tape.stream('first', '/api/stream/c1')
    time.advance(5)
    tape.note('launch-sent')
    time.advance(5)
    push({ raw: 'data: {"type":"text"}', data: { type: 'text' } })
    assert.equal(reader.hasEnded(), false)
    end()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(reader.hasEnded(), true)
    assert.deepEqual(reader.frames, [{ raw: 'data: {"type":"text"}', data: { type: 'text' } }])
    assert.deepEqual(tape.log, [
      { atMs: 0, kind: 'stream-open', label: 'first', path: '/api/stream/c1', status: 200, contentType: 'text/event-stream' },
      { atMs: 5, kind: 'launch-sent' },
      { atMs: 10, kind: 'frame', label: 'first', raw: 'data: {"type":"text"}', data: { type: 'text' } },
      { atMs: 10, kind: 'stream-end', label: 'first', by: 'server' }
    ])
  })

  test('logs a stream that could not be opened and goes on', async () => {
    const { client } = scriptedClient({})
    const tape = createTape(client, () => 0)
    const reader = await tape.stream('late', '/api/stream/refused')
    assert.equal(reader.hasEnded(), true)
    assert.deepEqual(tape.log, [
      { atMs: 0, kind: 'stream-open-failed', label: 'late', path: '/api/stream/refused', error: 'Error: connect ECONNREFUSED' }
    ])
  })
})
