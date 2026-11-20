// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded 0.14.0 metrics answers, and a stand-in Orca host. These tests cover the Metrics
// section's read: which reports the worker asks Archon for under each scope and window, the
// Details rows it answers, what it keeps, and what it says when the report cannot be shown.
//
// The spend-mode recording (`fixtures/0.14.0/spend/metrics/metrics.json`) is SYNTHETIC: every
// record in it was made up by the recorder's own pack, `orchon_synthetic.*`. It measures nothing.
import { assert, describe, test, type MockHostOptions } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  HANG,
  health,
  html,
  json,
  pathListWithout,
  recorded,
  scene,
  type MountedScene,
  type Scene,
  type Scripted
} from '../scripts/scripted-archon.ts'
import { READ_CAP_BYTES } from './client'
import type { MetricsAnswer, MetricsView } from './metrics-view'

const SPEND = 'spend/metrics/metrics'
/** Where each answer sits in the spend-mode recording's log, read off the fixture by hand. */
const AT = { views: 9, projectViews: 11, defaultWindow: 13, week: 15, year: 17, projectYear: 19 } as const
/** The project the recorder registered, read off the fixture by hand. */
const PROJECT = '5f4afdd455b56667a1e364254e8d353c'

const VIEWS = `${DEFAULT}/api/metric-views`
const report = (since: string, codebaseId?: string): string =>
  `${DEFAULT}/api/metrics?since=${since}${codebaseId === undefined ? '' : `&codebaseId=${codebaseId}`}`

function metricsScene(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
  stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
  return stage
}

async function read(mounted: MountedScene, input: Record<string, unknown> = {}): Promise<MetricsAnswer> {
  return (await mounted.worker.request('metrics.read', input)) as MetricsAnswer
}

const ready = (view: MetricsView): Extract<MetricsView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The metrics view is ${view.kind}${view.kind === 'failed' ? `: ${view.message}` : ''}.`)
  return view
}

const host = (storage: MockHostOptions['storage'] = {}): MockHostOptions => ({ storage })

describe('the Details rows of the recorded synthetic report', () => {
  test('under "All projects" the worker reads the declarations and the week, and answers one row per metric by name without the calibration', async () => {
    const stage = metricsScene()
    stage.archon.answer(VIEWS, recorded('0.14.0', SPEND, AT.views))
    stage.archon.answer(report('7d'), recorded('0.14.0', SPEND, AT.week))
    const mounted = await stage.mount(host())
    const answer = await read(mounted)
    assert.equal(answer.window, '7d')
    const view = ready(answer.metrics)
    assert.equal(view.since, Date.UTC(2026, 10, 13, 2, 29, 21, 974))
    assert.equal(view.until, Date.UTC(2026, 10, 20, 2, 29, 21, 974))
    assert.equal(view.codebaseId, undefined)
    // The bundled pack names no synthetic metric, so each row reads its dotted name.
    const shown = (name: string, value: string, records: number, latest: string) => ({
      name: `orchon_synthetic.${name}`,
      label: `orchon_synthetic.${name}`,
      state: 'shown',
      value,
      records,
      knownCost: 'none recorded',
      latest
    })
    assert.deepEqual(view.rows, [
      shown('items_abandoned', '1 items', 1, '1'),
      shown('items_merged', '2 items', 2, '1'),
      shown('items_opened', '4 items', 4, '1'),
      shown('review_score', '70%', 3, '90%'),
      shown('tests_added', '8 tests', 2, '3'),
      shown('tests_useless', '2 tests', 2, '1')
    ])
    assert.equal(view.more, 0)
    assert.ok(!stage.archon.calls.some((call) => /compare|byModel|subject|codebaseId/.test(call.url)))
    await mounted.worker.deactivate()
  })
})

describe('the scope', () => {
  test('under "This project" both reads send the project id, and the project\'s pack gives the plain names', async () => {
    const stage = metricsScene()
    stage.archon.answer(`${VIEWS}?codebaseId=${PROJECT}`, recorded('0.14.0', SPEND, AT.projectViews))
    // Only the year was recorded for the project, so it stands in for the project's week.
    stage.archon.answer(report('7d', PROJECT), recorded('0.14.0', SPEND, AT.projectYear))
    const mounted = await stage.mount(host())
    const view = ready((await read(mounted, { codebaseId: PROJECT })).metrics)
    assert.equal(view.codebaseId, PROJECT)
    assert.deepEqual(
      view.rows.map((row) => [row.name, row.label]),
      [
        ['orchon_synthetic.items_abandoned', 'Synthetic items abandoned'],
        ['orchon_synthetic.items_merged', 'Synthetic items merged'],
        ['orchon_synthetic.items_opened', 'Synthetic items opened'],
        ['orchon_synthetic.review_score', 'Synthetic review score'],
        ['orchon_synthetic.tests_added', 'Synthetic new tests'],
        ['orchon_synthetic.tests_useless', 'Synthetic useless tests']
      ]
    )
    assert.deepEqual(
      stage.archon.calls.filter((call) => call.url.includes('/api/metric')).map((call) => call.url),
      [`${VIEWS}?codebaseId=${PROJECT}`, report('7d', PROJECT)]
    )
    await mounted.worker.deactivate()
  })
})

/** The recorded week, as a value a test can change. */
function weekBody(): Record<string, unknown> {
  const answer = recorded('0.14.0', SPEND, AT.week)
  if (answer.kind !== 'json') throw new Error('The recorded week is not JSON.')
  return structuredClone(answer.value) as Record<string, unknown>
}
type Body = Record<string, unknown>
const weekMetrics = (body: Body): Body[] => body.metrics as Body[]
const firstInstrument = (body: Body, index: number): Body => (weekMetrics(body)[index]?.instruments as Body[])[0] as Body

/** A scene whose Archon answers the declarations and the given week for "All projects". */
function allProjects(week: Scripted = recorded('0.14.0', SPEND, AT.week)): Scene {
  const stage = metricsScene()
  stage.archon.answer(VIEWS, recorded('0.14.0', SPEND, AT.views))
  stage.archon.answer(report('7d'), week)
  return stage
}
const reportCalls = (stage: Scene): string[] =>
  stage.archon.calls.filter((call) => call.url.startsWith(`${DEFAULT}/api/metrics?`)).map((call) => call.url)

describe('what the worker keeps', () => {
  test('a read within 5 minutes answers the report it holds, one past them reads Archon again, and Refresh always does', async () => {
    const stage = allProjects()
    const mounted = await stage.mount(host())
    const first = ready((await read(mounted)).metrics)
    assert.equal(first.fetchedAt, stage.clock.now())
    await stage.clock.advance(5 * 60_000)
    assert.equal(ready((await read(mounted)).metrics).fetchedAt, first.fetchedAt)
    assert.equal(reportCalls(stage).length, 1)
    await stage.clock.advance(1)
    assert.equal(ready((await read(mounted)).metrics).fetchedAt, stage.clock.now())
    assert.equal(reportCalls(stage).length, 2)
    assert.equal(ready((await read(mounted, { refresh: true })).metrics).fetchedAt, stage.clock.now())
    assert.equal(reportCalls(stage).length, 3)
    await mounted.worker.deactivate()
  })

  test('it holds one report: another scope or window reads Archon, and so does coming back to the first', async () => {
    const stage = allProjects()
    stage.archon.answer(report('30d'), recorded('0.14.0', SPEND, AT.defaultWindow))
    const mounted = await stage.mount(host())
    await read(mounted)
    const month = ready((await read(mounted, { window: '30d' })).metrics)
    assert.equal(month.window, '30d')
    assert.equal(month.since, Date.UTC(2026, 9, 21, 2, 29, 21, 970))
    await read(mounted, { window: '7d' })
    assert.deepEqual(reportCalls(stage), [report('7d'), report('30d'), report('7d')])
    await mounted.worker.deactivate()
  })
})

describe('the window', () => {
  test('opens on 7 days, and a chosen window is kept in plugin storage after a pause and used by a read that names none', async () => {
    const stage = allProjects()
    stage.archon.answer(report('90d'), recorded('0.14.0', SPEND, AT.defaultWindow))
    const mounted = await stage.mount(host())
    assert.equal((await read(mounted)).window, '7d')
    assert.equal((await read(mounted, { window: '90d' })).window, '90d')
    await stage.clock.advance(999)
    assert.equal(mounted.host.data().storage['metrics-window'], undefined)
    await stage.clock.advance(1)
    assert.equal(mounted.host.data().storage['metrics-window'], '90d')
    const kept = await read(mounted)
    assert.equal(kept.window, '90d')
    assert.equal(ready(kept.metrics).window, '90d')
    await mounted.worker.deactivate()
  })

  test('a window kept in storage is read on start, and a stored value that is not a window is the default', async () => {
    const stage = allProjects()
    stage.archon.answer(report('30d'), recorded('0.14.0', SPEND, AT.defaultWindow))
    const mounted = await stage.mount(host({ 'metrics-window': '30d' }))
    assert.equal((await read(mounted)).window, '30d')
    assert.deepEqual(reportCalls(stage), [report('30d')])
    await mounted.worker.deactivate()
    const other = allProjects()
    const again = await other.mount(host({ 'metrics-window': '14d' }))
    assert.equal((await read(again)).window, '7d')
    await again.worker.deactivate()
  })

  test('a request with a window that is not one, an unknown key or a refresh that is not true is refused', async () => {
    const mounted = await allProjects().mount(host())
    for (const input of [{ window: '14d' }, { window: 7 }, { since: '7d' }, { compare: 'x' }, { refresh: false }, { codebaseId: '' }]) {
      await assert.rejects(read(mounted, input))
    }
    await mounted.worker.deactivate()
  })
})

describe('a report that cannot be shown', () => {
  test('the report query waits 30 seconds, then reads as a timeout and is not sent again', async () => {
    const stage = allProjects(HANG)
    const mounted = await stage.mount(host())
    const answers: MetricsAnswer[] = []
    void read(mounted).then((value) => answers.push(value))
    await stage.clock.advance(30_000 - 1)
    assert.equal(answers.length, 0)
    await stage.clock.advance(1)
    assert.deepEqual(answers[0]?.metrics, { kind: 'timeout' })
    await stage.clock.advance(120_000)
    assert.equal(reportCalls(stage).length, 1)
    await mounted.worker.deactivate()
  })

  test('past the 8 MiB read cap the report is too large and nothing of it is kept', async () => {
    const big = new Uint8Array(READ_CAP_BYTES + 1).fill(0x20)
    const mounted = await allProjects({ kind: 'chunks', chunks: [big] }).mount(host())
    assert.deepEqual((await read(mounted)).metrics, { kind: 'too-large' })
    await mounted.worker.deactivate()
  })

  test("a refused report carries Archon's message", async () => {
    const mounted = await allProjects(json({ error: 'since must be a duration' }, 400)).mount(host())
    assert.deepEqual((await read(mounted)).metrics, { kind: 'failed', message: 'since must be a duration' })
    await mounted.worker.deactivate()
  })

  test('a release before 0.14.0 that lists no metrics paths is not asked, and says which release metrics needs', async () => {
    const stage = metricsScene()
    stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.13.2' }))
    stage.archon.answer(DEFAULT_OPENAPI, pathListWithout('0.14.0', '/api/metrics', '/api/metric-views'))
    const mounted = await stage.mount(host())
    assert.deepEqual((await read(mounted)).metrics, { kind: 'missing', message: 'Metrics needs Archon 0.14.0 or newer. This server reports 0.13.2.' })
    assert.ok(!stage.archon.calls.some((call) => call.url.includes('/api/metric')))
    await mounted.worker.deactivate()
  })

  test('a server that answers the metrics routes with its HTML page, as 0.13.2 was recorded to, says the same', async () => {
    const stage = metricsScene()
    stage.archon.answer(VIEWS, recorded('0.13.2', 'metrics', 0))
    stage.archon.answer(report('7d'), html())
    const mounted = await stage.mount(host())
    assert.deepEqual((await read(mounted)).metrics, { kind: 'missing', message: 'Metrics needs Archon 0.14.0 or newer. This server reports 0.14.0.' })
    await mounted.worker.deactivate()
  })
})

describe("the report's validator", () => {
  const unreadable: [string, (body: Body) => void][] = [
    ['a name that is not a metric name', (body) => (weekMetrics(body)[0]!.name = 'Orchon Synthetic')],
    ['a name longer than 128', (body) => (weekMetrics(body)[0]!.name = `a${'.b'.repeat(64)}`)],
    ['a value that is not a number', (body) => (firstInstrument(body, 0).value = '1')],
    ['a record count that is not a whole number', (body) => (firstInstrument(body, 0).n = 1.5)],
    ["a count's cost without its run count", (body) => delete (firstInstrument(body, 0).cost as Body).runs],
    ["a score's cost with a run count that is not a whole number", (body) => ((firstInstrument(body, 3).cost as Body).runs_without_cost = 0.5)],
    ['a window that is not a time', (body) => ((body.window as Body).since = 'last week')],
    ['a known kind without its unit', (body) => delete weekMetrics(body)[0]!.unit],
    ['no headline among the instruments', (body) => (weekMetrics(body)[0]!.headline_instrument = 'judge-v2')],
    ['no list of metrics', (body) => delete body.metrics]
  ]
  for (const [what, change] of unreadable) {
    test(`${what} makes the whole report unreadable`, async () => {
      const body = weekBody()
      change(body)
      const mounted = await allProjects(json(body)).mount(host())
      assert.deepEqual((await read(mounted)).metrics, { kind: 'unreadable' })
      await mounted.worker.deactivate()
    })
  }

  test('a number too large to be finite is refused', async () => {
    const text = JSON.stringify(weekBody()).replace('"value":1,', '"value":1e999,')
    const mounted = await allProjects({ kind: 'text', text, contentType: 'application/json', status: 200 }).mount(host())
    assert.deepEqual((await read(mounted)).metrics, { kind: 'unreadable' })
    await mounted.worker.deactivate()
  })

  test('a metric of a kind Orchon does not know keeps its row without figures, and its other fields are not read', async () => {
    const body = weekBody()
    weekMetrics(body).push({ name: 'orchon_synthetic.a_histogram', kind: 'histogram', calibrates: null })
    const mounted = await allProjects(json(body)).mount(host())
    const view = ready((await read(mounted)).metrics)
    assert.deepEqual(view.rows[0], { name: 'orchon_synthetic.a_histogram', label: 'orchon_synthetic.a_histogram', state: 'unknown-kind' })
    assert.equal(view.rows.length, 7)
    await mounted.worker.deactivate()
  })

  test('a known cost and a small value are written as the console writes them', async () => {
    const body = weekBody()
    const instrument = firstInstrument(body, 4)
    ;(instrument.cost as Body).usd = 1.4249
    instrument.value = 0.0042
    const mounted = await allProjects(json(body)).mount(host())
    const row = ready((await read(mounted)).metrics).rows.find((each) => each.name === 'orchon_synthetic.tests_added')
    assert.deepEqual(row, {
      name: 'orchon_synthetic.tests_added',
      label: 'orchon_synthetic.tests_added',
      state: 'shown',
      value: '0.0042 tests',
      records: 2,
      knownCost: '≥ $1.42',
      latest: '3'
    })
    await mounted.worker.deactivate()
  })
})

describe('the caps', () => {
  test('at most 200 rows by name, and how many more there are', async () => {
    const body = weekBody()
    const [first] = weekMetrics(body)
    const many = Array.from({ length: 205 }, (_, index) => ({ ...first, name: `orchon_synthetic.m${String(index).padStart(3, '0')}` }))
    body.metrics = many.reverse()
    const mounted = await allProjects(json(body)).mount(host())
    const view = ready((await read(mounted)).metrics)
    assert.equal(view.rows.length, 200)
    assert.equal(view.rows[0]?.name, 'orchon_synthetic.m000')
    assert.equal(view.rows[199]?.name, 'orchon_synthetic.m199')
    assert.equal(view.more, 5)
    await mounted.worker.deactivate()
  })

  test("the recorded refusal is kept apart from the rows, and at most 20 are kept with Archon's total", async () => {
    const recordedWeek = await allProjects().mount(host())
    const week = ready((await read(recordedWeek)).metrics)
    assert.deepEqual(week.refused, [
      { reason: 'definition_conflict', runId: 'a877b80b-6cec-449f-9ad9-41007963d5d3', workflowName: 'orchon-recorder-synthetic-metrics', nodeId: 'emit' }
    ])
    assert.equal(week.refusedTotal, 1)
    await recordedWeek.worker.deactivate()
    const body = weekBody()
    const [refusal] = body.refused as unknown[]
    body.refused = Array.from({ length: 25 }, () => refusal)
    const mounted = await allProjects(json(body)).mount(host())
    const view = ready((await read(mounted)).metrics)
    assert.equal(view.refused.length, 20)
    assert.equal(view.refusedTotal, 25)
    await mounted.worker.deactivate()
  })
})

describe('the recorded empty report', () => {
  test('0.14.0 with no records answers no rows and no refusals', async () => {
    const stage = metricsScene()
    stage.archon.answer(VIEWS, recorded('0.14.0', 'metrics', 0))
    stage.archon.answer(report('7d'), recorded('0.14.0', 'metrics', 1))
    const mounted = await stage.mount(host())
    const view = ready((await read(mounted)).metrics)
    assert.deepEqual([view.rows, view.more, view.refused, view.refusedTotal], [[], 0, [], 0])
    assert.equal(view.since, Date.UTC(2026, 9, 20, 1, 5, 8, 581))
    await mounted.worker.deactivate()
  })
})
