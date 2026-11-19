// The worker's request protocol seam: the worker mounted on a scripted Archon, which replays the
// recorded dashboard-runs answers. These tests cover the runs table's request: what the worker
// asks Archon, and the trimmed view model it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  HANG,
  health,
  json,
  recorded,
  RELEASES,
  scene,
  type Release,
  type Scene,
  urls
} from '../scripts/scripted-archon.ts'
import type { RunsAnswer, RunsRequest } from './runs-view'

const RUNS = `${DEFAULT}/api/dashboard/runs`
const firstPage = `${RUNS}?limit=50&offset=0`

/** A scene connected to the default address, with health answering as `release`. */
function connectedScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  return stage
}

async function readRuns(stage: Scene, input: RunsRequest): Promise<RunsAnswer> {
  const { worker } = await stage.mount()
  return (await worker.request('runs.read', input)) as RunsAnswer
}

/** The one run each release's recording holds, as the table shows it. Read off the fixtures by hand. */
const RECORDED_RUN: Record<Release, { id: string; started: number; ended: number }> = {
  '0.12.1': {
    id: '7c28e1a1-6432-4c9d-89d6-874cfaf81f89',
    started: Date.UTC(2026, 10, 19, 1, 1, 15),
    ended: Date.UTC(2026, 10, 19, 1, 1, 18)
  },
  '0.13.2': {
    id: '542b1888-311b-4b65-b005-8b78e33a7c79',
    started: Date.UTC(2026, 10, 19, 1, 3, 14),
    ended: Date.UTC(2026, 10, 19, 1, 3, 16)
  },
  '0.14.0': {
    id: '68b479b2-217a-4e84-b86d-ecb9faf394e6',
    started: Date.UTC(2026, 10, 19, 1, 5, 13),
    ended: Date.UTC(2026, 10, 19, 1, 5, 16)
  }
}

describe('the runs table request', () => {
  for (const release of RELEASES) {
    test(`reads the recorded runs of ${release} into the trimmed view model`, async () => {
      const stage = connectedScene(release)
      stage.archon.answer(firstPage, recorded(release, 'dashboard-runs'))
      const answer = await readRuns(stage, { status: 'all', rows: 25 })
      const run = RECORDED_RUN[release]
      assert.equal(answer.connection.kind, 'connected')
      assert.deepEqual(answer.runs, {
        kind: 'ready',
        counts: { all: 1, running: 0, paused: 0, pending: 0, completed: 1, failed: 0, cancelled: 0 },
        total: 1,
        rows: [
          {
            id: run.id,
            workflow: 'orchon-recorder-echo',
            status: 'completed',
            startedAt: run.started,
            endedAt: run.ended,
            message: 'Recording a launch for Orchon: one shell step.',
            project: 'orchon-recorder/throwaway-project',
            workingPath: '<project-path>'
          }
        ],
        unreadable: 0
      })
    })

    test(`reads the recorded empty list of ${release}`, async () => {
      const stage = connectedScene(release)
      stage.archon.answer(firstPage, recorded(release, 'dashboard-runs-empty'))
      const answer = await readRuns(stage, { status: 'all', rows: 25 })
      assert.deepEqual(answer.runs, {
        kind: 'ready',
        counts: { all: 0, running: 0, paused: 0, pending: 0, completed: 0, failed: 0, cancelled: 0 },
        total: 0,
        rows: [],
        unreadable: 0
      })
    })
  }
})

/** The recorded run of the floor, as Archon sent it, to build longer lists from. */
function recordedRun(): Record<string, unknown> {
  const answer = recorded('0.12.1', 'dashboard-runs')
  if (answer.kind !== 'json') throw new Error('The recorded dashboard runs are not JSON.')
  const [run] = (answer.value as { runs: Record<string, unknown>[] }).runs
  if (run === undefined) throw new Error('The recorded dashboard runs hold no run.')
  return run
}

const COUNTS = { all: 120, running: 2, completed: 100, failed: 10, cancelled: 3, pending: 4, paused: 1 }

/** Archon holding `total` runs, run-0 the newest, answering every page of them. */
function manyRuns(stage: Scene, total: number, shape: (index: number) => Record<string, unknown> = () => ({})): void {
  const run = recordedRun()
  for (let offset = 0; offset < total + 50; offset += 50) {
    const runs = []
    for (let index = offset; index < Math.min(offset + 50, total); index += 1) {
      runs.push({ ...run, id: `run-${String(index)}`, workflow_name: `flow-${String(index)}`, ...shape(index) })
    }
    stage.archon.answer(`${RUNS}?limit=50&offset=${String(offset)}`, json({ runs, total, counts: { ...COUNTS, all: total } }))
  }
}

const ids = (answer: RunsAnswer): string[] => (answer.runs.kind === 'ready' ? answer.runs.rows.map((row) => row.id) : [])
const runsCalls = (stage: Scene): string[] => urls(stage).filter((url) => url.startsWith(RUNS))

describe('reading rows 0 to N in pages', () => {
  test('reads pages of 50 until it holds the rows asked for, and answers once with the counts', async () => {
    const stage = connectedScene()
    manyRuns(stage, 120)
    const answer = await readRuns(stage, { status: 'all', rows: 75 })
    assert.deepEqual(runsCalls(stage), [`${RUNS}?limit=50&offset=0`, `${RUNS}?limit=50&offset=50`])
    assert.equal(ids(answer).length, 75)
    assert.equal(ids(answer)[0], 'run-0')
    assert.equal(ids(answer)[74], 'run-74')
    assert.ok(answer.runs.kind === 'ready')
    assert.equal(answer.runs.total, 120)
    assert.deepEqual(answer.runs.counts, {
      all: 120,
      running: 2,
      paused: 1,
      pending: 4,
      completed: 100,
      failed: 10,
      cancelled: 3
    })
  })

  test('stops at the last run Archon has', async () => {
    const stage = connectedScene()
    manyRuns(stage, 60)
    const answer = await readRuns(stage, { status: 'all', rows: 500 })
    assert.deepEqual(runsCalls(stage), [`${RUNS}?limit=50&offset=0`, `${RUNS}?limit=50&offset=50`])
    assert.equal(ids(answer).length, 60)
  })

  test("sends the status filter, with Queued as Archon's pending", async () => {
    const stage = connectedScene()
    stage.archon.answer(`${RUNS}?status=pending&limit=50&offset=0`, recorded('0.12.1', 'dashboard-runs-empty'))
    const answer = await readRuns(stage, { status: 'pending', rows: 25 })
    assert.deepEqual(runsCalls(stage), [`${RUNS}?status=pending&limit=50&offset=0`])
    assert.equal(answer.runs.kind, 'ready')
  })

  test('sends nothing to Archon while not connected', async () => {
    const stage = scene()
    const answer = await readRuns(stage, { status: 'all', rows: 25 })
    assert.notEqual(answer.connection.kind, 'connected')
    assert.deepEqual(answer.runs, { kind: 'not-connected' })
    assert.deepEqual(runsCalls(stage), [])
  })
})

describe('the dashboard runs validator', () => {
  test('drops a run that fails, counts it, and keeps reading past it', async () => {
    const stage = connectedScene()
    manyRuns(stage, 60, (index) => {
      if (index === 1) return { workflow_name: 42 }
      if (index === 2) return { status: 'sleeping' }
      if (index === 55) return { id: null }
      return {}
    })
    const answer = await readRuns(stage, { status: 'all', rows: 100 })
    assert.ok(answer.runs.kind === 'ready')
    assert.equal(answer.runs.unreadable, 3)
    assert.equal(answer.runs.rows.length, 57)
    assert.ok(!ids(answer).includes('run-1') && !ids(answer).includes('run-2'))
  })

  test('reads a run with only the fields it needs and ignores every other field', async () => {
    const stage = connectedScene()
    stage.archon.answer(
      `${RUNS}?limit=50&offset=0`,
      json({
        runs: [{ id: 'a', workflow_name: 'fix', status: 'running', started_at: '2026-11-18 11:59:00', secret: { deep: true } }],
        total: 1,
        counts: { ...COUNTS, all: 1 },
        extra: 'ignored'
      })
    )
    const answer = await readRuns(stage, { status: 'all', rows: 25 })
    assert.ok(answer.runs.kind === 'ready')
    assert.deepEqual(answer.runs.rows, [
      {
        id: 'a',
        workflow: 'fix',
        status: 'running',
        startedAt: Date.UTC(2026, 10, 18, 11, 59, 0),
        endedAt: null,
        message: '',
        project: null,
        workingPath: null
      }
    ])
  })

  test('keeps a run whose start time does not parse, without the time', async () => {
    const stage = connectedScene()
    manyRuns(stage, 1, () => ({ started_at: 'yesterday' }))
    const answer = await readRuns(stage, { status: 'all', rows: 25 })
    assert.ok(answer.runs.kind === 'ready')
    assert.equal(answer.runs.rows[0]?.startedAt, null)
  })

  test('cuts a long launch message for the preview', async () => {
    const stage = connectedScene()
    manyRuns(stage, 1, () => ({ user_message: 'x'.repeat(5000) }))
    const answer = await readRuns(stage, { status: 'all', rows: 25 })
    assert.ok(answer.runs.kind === 'ready')
    assert.equal(answer.runs.rows[0]?.message.length, 200)
  })

  test('a page that fails as a whole is an error naming the version and the tested range', async () => {
    const stage = connectedScene('0.15.2' as Release)
    stage.archon.answer(`${RUNS}?limit=50&offset=0`, json({ runs: 'many', total: 1 }))
    const answer = await readRuns(stage, { status: 'all', rows: 25 })
    assert.deepEqual(answer.runs, {
      kind: 'failed',
      message: "Orchon could not read Archon's answer. This server reports Archon 0.15.2; Orchon is tested with 0.12.1 to 0.14.0."
    })
  })
})

describe('a failed read', () => {
  test('an error status says so', async () => {
    const stage = connectedScene()
    stage.archon.answer(`${RUNS}?limit=50&offset=0`, json({ error: 'boom' }, 500))
    const answer = await readRuns(stage, { status: 'all', rows: 25 })
    assert.deepEqual(answer.runs, { kind: 'failed', message: 'Archon answered with an error (500).' })
  })

  test('a timeout names the read timeout', async () => {
    const stage = connectedScene()
    stage.archon.answer(`${RUNS}?limit=50&offset=0`, HANG)
    const { worker } = await stage.mount()
    const pending = worker.request('runs.read', { status: 'all', rows: 25 })
    await stage.clock.advance(10_000)
    const answer = (await pending) as RunsAnswer
    assert.deepEqual(answer.runs, { kind: 'failed', message: 'Archon did not answer within 10 seconds.' })
  })
})

describe('what a frame may send', () => {
  const refused: unknown[] = [
    undefined,
    null,
    'all',
    { status: 'all' },
    { status: 'needs-you', rows: 25 },
    { status: 'all', rows: 0 },
    { status: 'all', rows: 501 },
    { status: 'all', rows: 2.5 },
    { status: 'all', rows: '25' },
    { status: 'all', rows: 25, offset: 10 }
  ]
  for (const input of refused) {
    test(`refuses ${JSON.stringify(input) ?? 'no input'}`, async () => {
      const stage = connectedScene()
      const { worker } = await stage.mount()
      await assert.rejects(
        worker.request('runs.read', input as RunsRequest),
        (error: unknown) => (error as { code?: string }).code === 'invalid_params'
      )
      assert.deepEqual(runsCalls(stage), [])
    })
  }
})
