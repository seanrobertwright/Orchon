// The ceilings of a spend-mode run: the tokens Archon reports and the time it takes are watched,
// and the run is cancelled through Archon's own route as soon as either is crossed.
import { assert, describe, test } from 'orca/testing'
import { createCeilingGuard, watchRun } from './ceiling.ts'
import type { Answer, LoopbackClient } from './http.ts'
import { createTape } from './recording.ts'

const json = (body: unknown, status = 200): Answer => ({ status, contentType: 'application/json', body })

/** A node's spend as Archon 0.14.0 reports it on a node event and in run metadata. */
const spend = (input: number, output: number, cacheRead = 0) => ({
  tokens: { source: 'provider', value: { input, output, cacheRead, cacheWrite: 0 } },
  costUsd: null,
  stopReason: null,
  numTurns: 1
})

const toolCall = (seq: number) => ({ attemptId: 'a1', seq, event: { type: 'tool_call', toolCallId: `call-${seq}`, title: 'Glob' } })

/** A clock the test moves by hand. */
function scriptedClock(): { now: () => number; advance: (ms: number) => Promise<void> } {
  let time = 0
  return {
    now: () => time,
    advance: async (ms) => {
      time += ms
    }
  }
}

interface Script {
  /** What the run detail answers at each poll: its status and the spend reported so far. */
  polls: { status: string; spend?: ReturnType<typeof spend>; events?: unknown[] }[]
  /** Whether cancel ends the run. */
  cancelEnds?: boolean
}

/** A release that answers the run's detail and events from a script, and keeps what it was sent. */
function scriptedRelease(script: Script): { client: LoopbackClient; sent: string[] } {
  const sent: string[] = []
  let poll = 0
  let cancelled = false
  const current = () => script.polls[Math.min(poll, script.polls.length - 1)] ?? { status: 'running' }
  const client: LoopbackClient = {
    port: 41000,
    async request(method, path) {
      const route = `${method} ${path.split('?')[0] ?? path}`
      sent.push(route)
      if (route === 'GET /api/workflows/runs/run-1') {
        const step = current()
        poll += 1
        const status = cancelled && script.cancelEnds !== false ? 'cancelled' : step.status
        return json({ run: { id: 'run-1', status, metadata: step.spend === undefined ? {} : { execution: { spend: step.spend } } } })
      }
      if (route === 'GET /api/workflows/runs/run-1/provider-events') return json({ events: current().events ?? [] })
      if (route === 'POST /api/workflows/runs/run-1/cancel') {
        cancelled = true
        return json({ success: true })
      }
      return json({ error: 'Not found' }, 404)
    },
    async openStream() {
      throw new Error('no streams here')
    }
  }
  return { client, sent }
}

const cancels = (sent: readonly string[]): number => sent.filter((route) => route === 'POST /api/workflows/runs/run-1/cancel').length

async function watch(script: Script, ceilings: { tokenCeiling: number; wallClockMs: number; maxToolCalls?: number }) {
  const { client, sent } = scriptedRelease(script)
  const clock = scriptedClock()
  const tape = createTape(client, clock.now)
  const guard = createCeilingGuard({ ...ceilings, now: clock.now })
  const outcome = await watchRun(tape, 'run-1', 'list', guard, { sleep: clock.advance, pollMs: 1000, cancelGraceMs: 10_000 })
  return { outcome, sent, tape, guard }
}

describe('the ceilings of a spend-mode run', () => {
  test('a run that ends under both ceilings is left alone', async () => {
    const { outcome, sent, guard } = await watch(
      { polls: [{ status: 'running' }, { status: 'running' }, { status: 'completed', spend: spend(40_000, 1_200) }] },
      { tokenCeiling: 150_000, wallClockMs: 300_000 }
    )
    assert.deepEqual(outcome, { ended: 'finished', status: 'completed' })
    assert.equal(cancels(sent), 0)
    assert.equal(guard.tokens(), 41_200)
  })

  test('cancels the run through its cancel route once the tokens Archon reports cross the ceiling', async () => {
    const { outcome, sent, tape } = await watch(
      { polls: [{ status: 'running', spend: spend(30_000, 500) }, { status: 'running', spend: spend(90_000, 2_000, 70_000) }] },
      { tokenCeiling: 150_000, wallClockMs: 300_000 }
    )
    assert.equal(outcome.ended, 'cancelled')
    assert.deepEqual(outcome.ended === 'cancelled' ? outcome.crossed : null, { by: 'tokens', seen: 192_500, ceiling: 150_000 })
    assert.equal(cancels(sent), 1)
    const crossed = tape.log.find((entry) => entry.kind === 'ceiling-crossed')
    assert.ok(crossed, 'the log does not say a ceiling was crossed')
    assert.equal(crossed.by, 'tokens')
    assert.ok(tape.log.some((entry) => entry.kind === 'http' && entry.method === 'POST' && entry.path === '/api/workflows/runs/run-1/cancel'))
  })

  test('counts the same report once, however often it is read', async () => {
    const same = spend(60_000, 1_000)
    const { outcome, sent, guard } = await watch(
      { polls: [{ status: 'running', spend: same }, { status: 'running', spend: same }, { status: 'running', spend: same }, { status: 'completed', spend: same }] },
      { tokenCeiling: 100_000, wallClockMs: 300_000 }
    )
    assert.deepEqual(outcome, { ended: 'finished', status: 'completed' })
    assert.equal(cancels(sent), 0)
    assert.equal(guard.tokens(), 61_000)
  })

  test('cancels the run when its wall-clock ceiling passes, though no tokens were reported', async () => {
    const { outcome, sent, tape } = await watch({ polls: [{ status: 'running' }] }, { tokenCeiling: 150_000, wallClockMs: 5_000 })
    assert.equal(outcome.ended, 'cancelled')
    assert.equal(outcome.ended === 'cancelled' ? outcome.crossed.by : null, 'time')
    assert.equal(cancels(sent), 1)
    assert.ok(tape.log.some((entry) => entry.kind === 'ceiling-crossed' && entry.by === 'time'))
  })

  test('cancels the run when the step makes more tool calls than it may', async () => {
    const { outcome, sent } = await watch(
      { polls: [{ status: 'running', events: [toolCall(1), toolCall(2)] }, { status: 'running', events: [toolCall(1), toolCall(2), toolCall(3), toolCall(4)] }] },
      { tokenCeiling: 150_000, wallClockMs: 300_000, maxToolCalls: 3 }
    )
    assert.deepEqual(outcome.ended === 'cancelled' ? outcome.crossed : null, { by: 'tool-calls', seen: 4, ceiling: 3 })
    assert.equal(cancels(sent), 1)
  })

  test('says so when a cancel did not end the run, so the caller stops the release', async () => {
    const { outcome, sent } = await watch(
      { polls: [{ status: 'running', spend: spend(200_000, 0) }], cancelEnds: false },
      { tokenCeiling: 150_000, wallClockMs: 300_000 }
    )
    assert.equal(outcome.ended, 'cancel-failed')
    assert.equal(cancels(sent), 1)
  })

  test('a ceiling of 0 is crossed by the first token reported', () => {
    const clock = scriptedClock()
    const guard = createCeilingGuard({ tokenCeiling: 0, wallClockMs: 60_000, now: clock.now })
    assert.equal(guard.check(), null)
    guard.observe({ usage: { input_tokens: 1, output_tokens: 0 } })
    assert.deepEqual(guard.check(), { by: 'tokens', seen: 1, ceiling: 0 })
  })
})
