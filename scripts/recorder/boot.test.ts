// Waiting for a started release to answer its first health check. The wait ends at once when the
// recording is interrupted, so Ctrl+C during a release's first boot still reaches the cleanup.
import { assert, describe, test } from 'orca/testing'
import { waitUntilHealthy } from './boot.ts'
import type { Answer, LoopbackClient } from './http.ts'
import { Interrupted } from './interrupt.ts'

/** A release that answers `answers` in turn, then the last one forever. A null answer is no answer. */
function release(answers: (Answer | null)[], exited = false) {
  let asked = 0
  const client: LoopbackClient = {
    port: 41000,
    async request() {
      const answer = answers[Math.min(asked, answers.length - 1)]
      asked += 1
      if (answer === null || answer === undefined) throw new Error('connection refused')
      return answer
    },
    openStream: async () => {
      throw new Error('no stream')
    }
  }
  return { client, release: { hasExited: () => exited, logFile: 'no-such-log-file' }, asked: () => asked }
}

const ok: Answer = { status: 200, contentType: 'application/json', body: { status: 'ok', version: '0.0.0' } }
const booting: Answer = { status: 503, contentType: 'text/plain', body: 'starting' }

describe('waiting for a release to answer', () => {
  test('answers the first health answer that is a 200', async () => {
    const fake = release([null, booting, ok])
    const health = await waitUntilHealthy({ ...fake, signal: new AbortController().signal, timeoutMs: 5000, pollMs: 1 })
    assert.deepEqual(health, ok.body)
    assert.equal(fake.asked(), 3)
  })

  test('fails at once when the release has ended before it answered', async () => {
    const fake = release([null], true)
    await assert.rejects(
      waitUntilHealthy({ ...fake, signal: new AbortController().signal, timeoutMs: 60_000, pollMs: 1 }),
      /ended before it answered/
    )
  })

  test('gives up when its time is up', async () => {
    const fake = release([null])
    await assert.rejects(waitUntilHealthy({ ...fake, signal: new AbortController().signal, timeoutMs: 50, pollMs: 5 }), /did not answer within/)
  })

  test('stops waiting as soon as the recording is interrupted, between two checks', async () => {
    const fake = release([null])
    const controller = new AbortController()
    const started = performance.now()
    setTimeout(() => controller.abort(new Interrupted('Interrupted.')), 50)
    await assert.rejects(
      waitUntilHealthy({ ...fake, signal: controller.signal, timeoutMs: 300_000, pollMs: 60_000 }),
      (error: unknown) => error instanceof Interrupted
    )
    assert.ok(performance.now() - started < 5000)
  })

  test('stops waiting when the recording is interrupted while a health check hangs', async () => {
    const hanging: LoopbackClient = {
      port: 41000,
      request: () => new Promise<Answer>(() => undefined),
      openStream: async () => {
        throw new Error('no stream')
      }
    }
    const controller = new AbortController()
    const started = performance.now()
    setTimeout(() => controller.abort(new Interrupted('Interrupted.')), 50)
    await assert.rejects(
      waitUntilHealthy({ client: hanging, release: { hasExited: () => false, logFile: 'x' }, signal: controller.signal, timeoutMs: 300_000, pollMs: 1 }),
      (error: unknown) => error instanceof Interrupted
    )
    assert.ok(performance.now() - started < 5000)
  })

  test('sends no health check once the recording is interrupted', async () => {
    const fake = release([ok])
    await assert.rejects(
      waitUntilHealthy({ ...fake, signal: AbortSignal.abort(new Interrupted('Interrupted.')), timeoutMs: 5000, pollMs: 1 }),
      (error: unknown) => error instanceof Interrupted
    )
    assert.equal(fake.asked(), 0)
  })
})
