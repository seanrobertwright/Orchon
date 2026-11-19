// The client's own seam: its transport is scripted, so every rule the client applies to a call
// is seen from outside, in the request it sends and the answer it gives.
import { assert, describe, test } from 'orca/testing'
import { createClock, HANG, html, json, openStream, REFUSE, scriptArchon, settle } from '../scripts/scripted-archon.ts'
import { createClient, READ_CAP_BYTES, TIMEOUT_MS, type ClientCall, type FetchLike, type StreamText } from './client'

const BASE = 'http://127.0.0.1:3090'
const HEALTH = `${BASE}/api/health`

function scripted() {
  const archon = scriptArchon()
  const clock = createClock()
  const client = createClient({ fetch: archon.fetch, timers: clock.timers })
  return { archon, clock, client }
}

const read = (path: string, more: Partial<ClientCall> = {}): ClientCall => ({ baseUrl: BASE, path, timeout: 'read', ...more })

describe('the client', () => {
  test('answers the JSON value of a good answer', async () => {
    const { archon, client } = scripted()
    archon.answer(HEALTH, json({ status: 'ok', version: '0.12.1' }))
    assert.deepEqual(await client.request(read('/api/health')), {
      ok: true,
      value: { status: 'ok', version: '0.12.1' }
    })
    assert.deepEqual(archon.calls, [
      { url: HEALTH, method: 'GET', redirect: 'manual', headers: { accept: 'application/json' } }
    ])
  })

  test('refuses a base URL whose host is not loopback, without sending anything', async () => {
    const { archon, client } = scripted()
    const hosts = [
      'http://example.com:3090',
      'http://192.168.1.20:3090',
      'http://127.0.0.2:3090',
      'http://0.0.0.0:3090',
      'http://[::2]:3090',
      'https://127.0.0.1:3090',
      'http://127.0.0.1:3090@example.com',
      'http://user:secret@127.0.0.1:3090',
      'not a url',
      ''
    ]
    for (const baseUrl of hosts) {
      assert.deepEqual(
        await client.request({ baseUrl, path: '/api/health', timeout: 'health' }),
        { ok: false, failure: { kind: 'not-loopback' } },
        baseUrl
      )
    }
    assert.deepEqual(archon.calls, [])
  })

  test('refuses a path that would leave the base URL', async () => {
    const { archon, client } = scripted()
    for (const path of ['//example.com/api/health', 'http://example.com/api/health', '\\\\example.com\\api']) {
      assert.deepEqual(await client.request(read(path)), { ok: false, failure: { kind: 'not-loopback' } }, path)
    }
    assert.deepEqual(archon.calls, [])
  })

  test('calls each loopback spelling', async () => {
    const { archon, client } = scripted()
    for (const baseUrl of ['http://127.0.0.1:3090', 'http://localhost:3090', 'http://[::1]:3090']) {
      archon.answer(`${baseUrl}/api/health`, json({ status: 'ok' }))
      const result = await client.request({ baseUrl, path: '/api/health', timeout: 'health' })
      assert.equal(result.ok, true, baseUrl)
    }
    assert.equal(archon.calls.length, 3)
  })

  test('turns redirects off on every request and never follows one', async () => {
    const { archon, client } = scripted()
    archon.answer(HEALTH, { kind: 'text', text: '', contentType: null, status: 302 })
    assert.deepEqual(await client.request(read('/api/health')), {
      ok: false,
      failure: { kind: 'status', status: 302 }
    })
    await client.request({ baseUrl: BASE, path: '/api/workflows/a/run', timeout: 'write', method: 'POST', body: {} })
    assert.deepEqual(
      archon.calls.map((call) => call.redirect),
      ['manual', 'manual']
    )
    assert.equal(archon.calls.length, 2)
  })

  test('reports a refused connection', async () => {
    const { archon, client } = scripted()
    archon.answer(HEALTH, REFUSE)
    assert.deepEqual(await client.request(read('/api/health')), { ok: false, failure: { kind: 'refused' } })
  })

  test('gives health 3 seconds, a read 10 and a write 30', async () => {
    assert.deepEqual(TIMEOUT_MS, { health: 3_000, read: 10_000, write: 30_000 })
    for (const timeout of ['health', 'read', 'write'] as const) {
      const { archon, clock, client } = scripted()
      archon.answer(HEALTH, HANG)
      let result: unknown
      void client.request({ baseUrl: BASE, path: '/api/health', timeout }).then((value) => {
        result = value
      })
      await clock.advance(TIMEOUT_MS[timeout] - 1)
      assert.equal(result, undefined, `${timeout} gave up early`)
      await clock.advance(1)
      assert.deepEqual(result, { ok: false, failure: { kind: 'timeout', timeoutMs: TIMEOUT_MS[timeout] } })
      assert.deepEqual(clock.waiting(), [])
    }
  })

  test('times out even when the transport never settles', async () => {
    const clock = createClock()
    const deaf: FetchLike = () => new Promise(() => {})
    const client = createClient({ fetch: deaf, timers: clock.timers })
    const pending = client.request({ baseUrl: BASE, path: '/api/health', timeout: 'health' })
    await clock.advance(3_000)
    assert.deepEqual(await pending, { ok: false, failure: { kind: 'timeout', timeoutMs: 3_000 } })
  })

  test('counts the time spent reading the body against the timeout', async () => {
    const clock = createClock()
    const slowBody: FetchLike = (_url, init) =>
      Promise.resolve({
        status: 200,
        headers: { get: () => 'application/json' },
        body: {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<Uint8Array>>((_, reject) => {
                init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
              })
          })
        }
      })
    const client = createClient({ fetch: slowBody, timers: clock.timers })
    const pending = client.request(read('/api/health'))
    await clock.advance(10_000)
    assert.deepEqual(await pending, { ok: false, failure: { kind: 'timeout', timeoutMs: 10_000 } })
  })

  test('clears its timer once the answer is in', async () => {
    const { archon, clock, client } = scripted()
    archon.answer(HEALTH, json({ status: 'ok' }))
    await client.request(read('/api/health'))
    assert.deepEqual(clock.waiting(), [])
  })

  test('requires a JSON content type: a 200 with HTML is not JSON', async () => {
    const { archon, client } = scripted()
    archon.answer(HEALTH, html())
    assert.deepEqual(await client.request(read('/api/health')), { ok: false, failure: { kind: 'not-json' } })
    archon.answer(HEALTH, { kind: 'text', text: '{"status":"ok"}', contentType: null })
    assert.deepEqual(await client.request(read('/api/health')), { ok: false, failure: { kind: 'not-json' } })
    archon.answer(HEALTH, { kind: 'text', text: '{"status":"ok"}', contentType: 'text/json-like' })
    assert.deepEqual(await client.request(read('/api/health')), { ok: false, failure: { kind: 'not-json' } })
  })

  test('accepts the JSON content types', async () => {
    const { archon, client } = scripted()
    for (const contentType of ['application/json', 'Application/JSON; charset=utf-8', 'application/problem+json']) {
      archon.answer(HEALTH, { kind: 'text', text: '{"status":"ok"}', contentType })
      assert.deepEqual(await client.request(read('/api/health')), { ok: true, value: { status: 'ok' } }, contentType)
    }
  })

  test('reports a JSON content type over a body that is not JSON as not JSON', async () => {
    const { archon, client } = scripted()
    archon.answer(HEALTH, { kind: 'text', text: '{"status":', contentType: 'application/json' })
    assert.deepEqual(await client.request(read('/api/health')), { ok: false, failure: { kind: 'not-json' } })
    archon.answer(HEALTH, { kind: 'chunks', chunks: [Uint8Array.of(0x22, 0xff, 0xfe, 0x22)] })
    assert.deepEqual(await client.request(read('/api/health')), { ok: false, failure: { kind: 'not-json' } })
  })

  test('reports an error status before it looks at the content type', async () => {
    const { archon, client } = scripted()
    archon.answer(HEALTH, html(404))
    assert.deepEqual(await client.request(read('/api/health')), {
      ok: false,
      failure: { kind: 'status', status: 404 }
    })
    archon.answer(HEALTH, json({ error: 'boom' }, 500))
    assert.deepEqual(await client.request(read('/api/health')), {
      ok: false,
      failure: { kind: 'status', status: 500 }
    })
  })

  test("keeps an error status's JSON body only when the call asks for it", async () => {
    const { archon, client } = scripted()
    archon.answer(HEALTH, json({ error: 'Unknown provider' }, 400))
    assert.deepEqual(await client.request(read('/api/health', { errorBody: true })), {
      ok: false,
      failure: { kind: 'status', status: 400, body: { error: 'Unknown provider' } }
    })
    // A body that is not JSON is left out; the status is still reported.
    archon.answer(HEALTH, html(400))
    assert.deepEqual(await client.request(read('/api/health', { errorBody: true })), {
      ok: false,
      failure: { kind: 'status', status: 400 }
    })
  })

  test('stops reading at the cap and reports the answer as too large', async () => {
    const { archon, client } = scripted()
    const chunk = new Uint8Array(4).fill(0x20)
    archon.answer(HEALTH, { kind: 'chunks', chunks: [chunk, chunk, chunk, chunk, chunk] })
    assert.deepEqual(await client.request(read('/api/health', { maxBytes: 10 })), {
      ok: false,
      failure: { kind: 'too-large' }
    })
    // 4 + 4 + 4 passes 10 at the third chunk: the last two are never taken, and the body is closed.
    assert.deepEqual(archon.lastBody, { taken: 3, closed: true })
  })

  test('reads an answer that is exactly at the cap', async () => {
    const { archon, client } = scripted()
    const text = '{"a":1}'
    archon.answer(HEALTH, { kind: 'text', text, contentType: 'application/json' })
    assert.deepEqual(await client.request(read('/api/health', { maxBytes: text.length })), { ok: true, value: { a: 1 } })
  })

  test('caps a read at 8 MiB unless the call says otherwise', async () => {
    assert.equal(READ_CAP_BYTES, 8 * 1024 * 1024)
    const { archon, client } = scripted()
    const mebibyte = new Uint8Array(1024 * 1024).fill(0x20)
    archon.answer(HEALTH, { kind: 'chunks', chunks: Array.from({ length: 9 }, () => mebibyte) })
    assert.deepEqual(await client.request(read('/api/health')), { ok: false, failure: { kind: 'too-large' } })
    assert.deepEqual(archon.lastBody, { taken: 9, closed: true })
  })

  test('sends a write as JSON with the body it was given', async () => {
    const { archon, client } = scripted()
    const url = `${BASE}/api/workflows/plan/run`
    archon.answer(url, json({ accepted: true }))
    const result = await client.request({
      baseUrl: BASE,
      path: '/api/workflows/plan/run',
      timeout: 'write',
      method: 'POST',
      body: { message: 'go' }
    })
    assert.deepEqual(result, { ok: true, value: { accepted: true } })
    assert.deepEqual(archon.calls, [
      {
        url,
        method: 'POST',
        redirect: 'manual',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: '{"message":"go"}'
      }
    ])
  })

  test('reports a call its caller gave up on as cancelled, not as refused', async () => {
    const { archon, clock, client } = scripted()
    archon.answer(HEALTH, HANG)
    const caller = new AbortController()
    const pending = client.request(read('/api/health', { signal: caller.signal }))
    caller.abort()
    assert.deepEqual(await pending, { ok: false, failure: { kind: 'cancelled' } })
    assert.deepEqual(clock.waiting(), [])

    const before = archon.calls.length
    assert.deepEqual(await client.request(read('/api/health', { signal: caller.signal })), {
      ok: false,
      failure: { kind: 'cancelled' }
    })
    assert.equal(archon.calls.length, before)
  })
})

describe('a stream through the client', () => {
  const STREAM = `${BASE}/api/stream/__dashboard__`
  const open = (client: ReturnType<typeof scripted>['client'], signal = new AbortController().signal) =>
    client.stream({ baseUrl: BASE, path: '/api/stream/__dashboard__', signal })

  /** Collects the text of a stream as it arrives, and how it ended. */
  function collect(text: StreamText): { pieces: string[]; end: Promise<string> } {
    const pieces: string[] = []
    const end = (async () => {
      try {
        for await (const piece of text) pieces.push(piece)
        return 'ended'
      } catch {
        return 'broke'
      }
    })()
    return { pieces, end }
  }

  test('opens a loopback stream with redirects off and hands over its text as it arrives', async () => {
    const { archon, client, clock } = scripted()
    const stream = openStream()
    archon.answer(STREAM, stream)
    const opened = await open(client)
    assert.equal(opened.ok, true)
    if (!opened.ok) return
    assert.deepEqual(archon.streams, [
      { url: STREAM, method: 'GET', redirect: 'manual', headers: { accept: 'text/event-stream' } }
    ])
    const { pieces, end } = collect(opened.text)
    stream.send('data: {"type":')
    await settle()
    stream.send('"heartbeat"}\n\n')
    await settle()
    assert.deepEqual(pieces, ['data: {"type":', '"heartbeat"}\n\n'])
    stream.end()
    assert.equal(await end, 'ended')
    // The caller's watchdog bounds a stream in time, so the client sets no timer of its own.
    assert.deepEqual(clock.waiting(), [])
  })

  test('decodes a character split across two chunks', async () => {
    const { archon, client } = scripted()
    const stream = openStream()
    archon.answer(STREAM, stream)
    const opened = await open(client)
    if (!opened.ok) throw new Error('not opened')
    const { pieces, end } = collect(opened.text)
    stream.send('caf')
    stream.send('é')
    stream.end()
    assert.equal(await end, 'ended')
    assert.equal(pieces.join(''), 'café')
  })

  test('refuses what is not a loopback stream, and reports a refused connection', async () => {
    const { archon, client } = scripted()
    const signal = new AbortController().signal
    assert.deepEqual(await client.stream({ baseUrl: 'http://example.com:3090', path: '/api/stream/__dashboard__', signal }), {
      ok: false,
      failure: { kind: 'not-loopback' }
    })
    assert.deepEqual(archon.streams, [])
    archon.answer(STREAM, REFUSE)
    assert.deepEqual(await open(client), { ok: false, failure: { kind: 'refused' } })
    archon.answer(STREAM, openStream({ status: 404 }))
    assert.deepEqual(await open(client), { ok: false, failure: { kind: 'status', status: 404 } })
    archon.answer(STREAM, openStream({ contentType: 'text/html' }))
    assert.deepEqual(await open(client), { ok: false, failure: { kind: 'not-event-stream' } })
  })

  test('ends the stream when its caller aborts, even while nothing arrives', async () => {
    const { archon, client } = scripted()
    archon.answer(STREAM, HANG)
    const caller = new AbortController()
    const pending = open(client, caller.signal)
    caller.abort()
    assert.deepEqual(await pending, { ok: false, failure: { kind: 'cancelled' } })

    const stream = openStream()
    archon.answer(STREAM, stream)
    const again = new AbortController()
    const opened = await open(client, again.signal)
    if (!opened.ok) throw new Error('not opened')
    const { end } = collect(opened.text)
    again.abort()
    assert.equal(await end, 'broke')
    assert.equal(stream.closed, true)
  })

  test('a stream that breaks, or holds bytes that are not UTF-8, ends with an error', async () => {
    const { archon, client } = scripted()
    const stream = openStream()
    archon.answer(STREAM, stream)
    const opened = await open(client)
    if (!opened.ok) throw new Error('not opened')
    const { end } = collect(opened.text)
    stream.break()
    assert.equal(await end, 'broke')

    const bad: FetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: (async function* () {
          yield Uint8Array.of(0xff, 0xfe)
        })()
      })
    const strict = createClient({ fetch: bad, timers: createClock().timers })
    const badOpen = await open(strict)
    if (!badOpen.ok) throw new Error('not opened')
    assert.equal(await collect(badOpen.text).end, 'broke')
  })
})

describe('reading bytes', () => {
  const FILE = `${BASE}/api/artifacts/run/notes.md`
  const bytesCall = (maxBytes: number) => ({ baseUrl: BASE, path: '/api/artifacts/run/notes.md', timeout: 'read' as const, maxBytes })

  test('answers the bytes of any content type, asking for any, with redirects off', async () => {
    const { archon, client } = scripted()
    archon.answer(FILE, html())
    const answer = await client.bytes(bytesCall(1024))
    assert.ok(answer.ok)
    assert.equal(new TextDecoder().decode(answer.bytes), '<!doctype html><html><body>Archon</body></html>')
    assert.deepEqual(archon.calls, [{ url: FILE, method: 'GET', redirect: 'manual', headers: { accept: '*/*' } }])
  })

  test('stops at the cap with too-large, and a status outside 200 to 299 is a status', async () => {
    const { archon, client } = scripted()
    archon.answer(FILE, { kind: 'chunks', chunks: [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)] })
    assert.deepEqual(await client.bytes(bytesCall(12)), { ok: true, bytes: new Uint8Array(12) })
    assert.deepEqual(await client.bytes(bytesCall(7)), { ok: false, failure: { kind: 'too-large' } })
    assert.deepEqual(archon.lastBody, { taken: 2, closed: true })
    archon.answer(FILE, json({ error: 'Artifact file not found' }, 404))
    assert.deepEqual(await client.bytes(bytesCall(8)), { ok: false, failure: { kind: 'status', status: 404 } })
    archon.answer(FILE, REFUSE)
    assert.deepEqual(await client.bytes(bytesCall(8)), { ok: false, failure: { kind: 'refused' } })
  })
})
