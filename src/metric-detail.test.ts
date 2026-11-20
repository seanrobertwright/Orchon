// The worker's request protocol seam for a metric's view: the worker mounted on a scripted Archon
// that replays the recorded 0.14.0 metrics answers, and a stand-in Orca host. These tests cover
// `metric.read`: the figures of one metric the worker answers, that it answers from the report it
// holds, and that it reads that one metric by name when it holds none.
//
// The spend-mode recording (`fixtures/0.14.0/spend/metrics/metrics.json`) is SYNTHETIC: every
// record in it was made up by the recorder's own pack, `orchon_synthetic.*`. It measures nothing.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, DEFAULT_OPENAPI, HANG, health, json, recorded, scene, settle, type MountedScene, type Scene, type Scripted } from '../scripts/scripted-archon.ts'
import type { MetricAnswer, MetricDetail, MetricRequest, MetricView } from './metric-view'

const SPEND = 'spend/metrics/metrics'
/** Where each answer sits in the spend-mode recording's log, read off the fixture by hand. */
const AT = { views: 9, week: 15, year: 17, projectYear: 19 } as const
/** The project the recorder registered, read off the fixture by hand. */
const PROJECT = '5f4afdd455b56667a1e364254e8d353c'

const VIEWS = `${DEFAULT}/api/metric-views`
const report = (since: string, codebaseId?: string): string =>
  `${DEFAULT}/api/metrics?since=${since}${codebaseId === undefined ? '' : `&codebaseId=${codebaseId}`}`
const byName = (since: string, name: string, codebaseId?: string): string =>
  `${DEFAULT}/api/metrics?since=${since}&name=${name}${codebaseId === undefined ? '' : `&codebaseId=${codebaseId}`}`

function metricsScene(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
  stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
  return stage
}

/** A scene whose Archon answers the declarations and the given week for "All projects". */
function allProjects(week: Scripted = recorded('0.14.0', SPEND, AT.week)): Scene {
  const stage = metricsScene()
  stage.archon.answer(VIEWS, recorded('0.14.0', SPEND, AT.views))
  stage.archon.answer(report('7d'), week)
  stage.archon.answer(report('365d'), recorded('0.14.0', SPEND, AT.year))
  return stage
}

const metricCalls = (stage: Scene): string[] => stage.archon.calls.filter((call) => call.url.includes('/api/metric')).map((call) => call.url)

async function readMetric(mounted: MountedScene, input: unknown): Promise<MetricAnswer> {
  return (await mounted.worker.request('metric.read', input as MetricRequest)) as MetricAnswer
}

const ready = (view: MetricView): MetricDetail => {
  if (view.kind !== 'ready') throw new Error(`The metric view is ${view.kind}.`)
  return view.metric
}

/** The recorded week, as a value a test can change. */
type Body = Record<string, unknown>
function weekBody(): Body {
  const answer = recorded('0.14.0', SPEND, AT.week)
  if (answer.kind !== 'json') throw new Error('The recorded week is not JSON.')
  return structuredClone(answer.value) as Body
}
const metricOf = (body: Body, name: string): Body => (body.metrics as Body[]).find((metric) => metric.name === `orchon_synthetic.${name}`) as Body
const headlineOf = (body: Body, name: string): Body => (metricOf(body, name).instruments as Body[])[0] as Body

describe("a metric's view from the report the worker holds", () => {
  test('after the Details read, selecting the recorded review score answers its figures and asks Archon nothing more', async () => {
    const stage = allProjects()
    const mounted = await stage.mount({})
    await mounted.worker.request('metrics.read', {})
    // The year-long report for calibrations answers after the read does.
    await settle()
    const before = metricCalls(stage).length
    const answer = await readMetric(mounted, { name: 'orchon_synthetic.review_score', window: '7d' })
    assert.deepEqual(ready(answer.metric), {
      name: 'orchon_synthetic.review_score',
      judgeVersion: null,
      value: '70%',
      interval: '20% – 120%',
      records: 3,
      knownCost: 'none recorded',
      runs: 1,
      gaps: { withoutCost: 1, withoutTokens: 1, partialCost: 0, missing: 0 },
      tokens: 'no tokens recorded',
      latest: { value: '90%', at: Date.UTC(2026, 10, 20, 2, 29, 21), subject: 'synthetic-item-3' },
      olderVersions: [],
      olderMore: 0,
      byDay: [{ day: '2026-11-20', value: '70%', records: 3 }],
      byDayMore: 0,
      // Nothing calibrates the review score (`calibration.test.ts` covers the lines).
      calibrations: { state: 'loaded', lines: [], more: 0, sentence: null }
    })
    assert.equal(metricCalls(stage).length, before)
    await mounted.worker.deactivate()
  })
})

describe('after a restart, when the worker holds no report', () => {
  test('it reads that one metric by name for the scope and window, in one query, and sends no other option', async () => {
    const stage = metricsScene()
    // Only the year was recorded for the project; it stands in for the project's week of one metric.
    stage.archon.answer(byName('7d', 'orchon_synthetic.tests_added', PROJECT), recorded('0.14.0', SPEND, AT.projectYear))
    const mounted = await stage.mount({})
    const metric = ready((await readMetric(mounted, { name: 'orchon_synthetic.tests_added', window: '7d', codebaseId: PROJECT })).metric)
    assert.equal(metric.name, 'orchon_synthetic.tests_added')
    assert.equal(metric.value, '8 tests')
    assert.deepEqual(metricCalls(stage), [byName('7d', 'orchon_synthetic.tests_added', PROJECT)])
    await mounted.worker.deactivate()
  })

  test('another scope or window than the one the worker holds is read by name too', async () => {
    const stage = allProjects()
    stage.archon.answer(byName('30d', 'orchon_synthetic.tests_added'), recorded('0.14.0', SPEND, AT.week))
    const mounted = await stage.mount({})
    await mounted.worker.request('metrics.read', {})
    ready((await readMetric(mounted, { name: 'orchon_synthetic.tests_added', window: '30d' })).metric)
    assert.deepEqual(metricCalls(stage), [VIEWS, report('7d'), report('365d'), byName('30d', 'orchon_synthetic.tests_added')])
    await mounted.worker.deactivate()
  })

  test('the read waits 30 seconds, then reads as a timeout and is not sent again', async () => {
    const stage = metricsScene()
    stage.archon.answer(byName('7d', 'orchon_synthetic.tests_added'), HANG)
    const mounted = await stage.mount({})
    const answers: MetricAnswer[] = []
    void readMetric(mounted, { name: 'orchon_synthetic.tests_added', window: '7d' }).then((value) => answers.push(value))
    await stage.clock.advance(30_000 - 1)
    assert.equal(answers.length, 0)
    await stage.clock.advance(1)
    assert.deepEqual(answers[0]?.metric, { kind: 'timeout' })
    await stage.clock.advance(120_000)
    assert.equal(metricCalls(stage).length, 1)
    await mounted.worker.deactivate()
  })

  test("a refused read carries Archon's message, an unreadable one says so, and a name Archon does not report is absent", async () => {
    const stage = metricsScene()
    stage.archon.answer(byName('7d', 'orchon_synthetic.refused'), json({ error: 'unknown name' }, 400))
    stage.archon.answer(byName('7d', 'orchon_synthetic.broken'), json({ window: {} }))
    stage.archon.answer(byName('7d', 'orchon_synthetic.none'), recorded('0.14.0', 'metrics', 1))
    const mounted = await stage.mount({})
    const view = async (name: string): Promise<MetricView> => (await readMetric(mounted, { name: `orchon_synthetic.${name}`, window: '7d' })).metric
    assert.deepEqual(await view('refused'), { kind: 'failed', message: 'unknown name' })
    assert.deepEqual(await view('broken'), { kind: 'unreadable' })
    assert.deepEqual(await view('none'), { kind: 'absent' })
    await mounted.worker.deactivate()
  })
})

describe("the figures of a metric's view", () => {
  test('the judge version, the older versions it hides at most 5 with how many more, the cost gaps and the tokens', async () => {
    const body = weekBody()
    const metric = metricOf(body, 'review_score')
    const headline = headlineOf(body, 'review_score')
    const judged = (instrument: string, models: string[]): Body => ({ ...headline, instrument, measured_by: models })
    metric.headline_instrument = 'judge-v8'
    metric.headline_measured_by = ['claude-opus']
    metric.instruments = [
      ...Array.from({ length: 7 }, (_, index) => judged(`judge-v${String(index + 1)}`, index === 0 ? [] : ['claude-sonnet'])),
      {
        ...judged('judge-v8', ['claude-opus']),
        cost: {
          usd: 1.4249,
          input_tokens: 12000,
          output_tokens: 3400.5,
          runs: 9,
          runs_without_cost: 2,
          runs_without_tokens: 3,
          runs_partial_cost: 1,
          runs_missing: 4
        }
      }
    ]
    const mounted = await allProjects(json(body)).mount({})
    await mounted.worker.request('metrics.read', {})
    const detail = ready((await readMetric(mounted, { name: 'orchon_synthetic.review_score', window: '7d' })).metric)
    assert.equal(detail.judgeVersion, 'judge-v8 on claude-opus')
    assert.deepEqual(detail.olderVersions, [
      'judge-v1',
      'judge-v2 on claude-sonnet',
      'judge-v3 on claude-sonnet',
      'judge-v4 on claude-sonnet',
      'judge-v5 on claude-sonnet'
    ])
    assert.equal(detail.olderMore, 2)
    assert.equal(detail.knownCost, '≥ $1.42')
    assert.equal(detail.runs, 9)
    assert.deepEqual(detail.gaps, { withoutCost: 2, withoutTokens: 3, partialCost: 1, missing: 4 })
    assert.equal(detail.tokens, '12,000 in / 3,400.5 out tokens')
    await mounted.worker.deactivate()
  })

  test('"By day" is newest first with each day exactly as Archon gave it, at most 91 days, with how many more', async () => {
    const body = weekBody()
    const headline = headlineOf(body, 'tests_added')
    // 95 UTC days, oldest first as Archon sends them: days 1 to 28 of August to November 2026.
    headline.series = Array.from({ length: 95 }, (_, index) => ({
      day: `2026-${String(Math.floor(index / 28) + 8).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      value: index,
      n: index + 1
    }))
    const mounted = await allProjects(json(body)).mount({})
    await mounted.worker.request('metrics.read', {})
    const detail = ready((await readMetric(mounted, { name: 'orchon_synthetic.tests_added', window: '7d' })).metric)
    assert.equal(detail.byDay.length, 91)
    assert.deepEqual(detail.byDay[0], { day: '2026-11-11', value: '94', records: 95 })
    assert.deepEqual(detail.byDay[1], { day: '2026-11-10', value: '93', records: 94 })
    assert.deepEqual(detail.byDay[90], { day: '2026-08-05', value: '4', records: 5 })
    assert.equal(detail.byDayMore, 4)
    await mounted.worker.deactivate()
  })

  test('a latest time that does not parse drops the time and keeps the value and subject', async () => {
    const body = weekBody()
    ;(headlineOf(body, 'tests_added').latest as Body).at = 'yesterday'
    const mounted = await allProjects(json(body)).mount({})
    await mounted.worker.request('metrics.read', {})
    const detail = ready((await readMetric(mounted, { name: 'orchon_synthetic.tests_added', window: '7d' })).metric)
    assert.deepEqual(detail.latest, { value: '3', at: null, subject: 'synthetic-item-2' })
    await mounted.worker.deactivate()
  })

  test('a metric of a kind Orchon does not know has no figures', async () => {
    const body = weekBody()
    ;(body.metrics as Body[]).push({ name: 'orchon_synthetic.a_histogram', kind: 'histogram', calibrates: null })
    const mounted = await allProjects(json(body)).mount({})
    await mounted.worker.request('metrics.read', {})
    assert.deepEqual((await readMetric(mounted, { name: 'orchon_synthetic.a_histogram', window: '7d' })).metric, { kind: 'unknown-kind' })
    await mounted.worker.deactivate()
  })
})

describe("the report's validator reads every figure a metric's view shows", () => {
  const series = (body: Body): Body => (headlineOf(body, 'tests_added').series as Body[])[0] as Body
  const unreadable: [string, (body: Body) => void][] = [
    ['a day that is not a UTC day', (body) => (series(body).day = '2026-11-20T00:00:00Z')],
    ['a day value that is not a number', (body) => (series(body).value = '8')],
    ['the same day twice', (body) => (headlineOf(body, 'tests_added').series = [series(body), series(body)])],
    ['an interval without its high end', (body) => delete (headlineOf(body, 'review_score').interval as Body).high],
    ['a cost gap that is not a count', (body) => ((headlineOf(body, 'tests_added').cost as Body).runs_missing = -1)],
    ['tokens that are not a number', (body) => ((headlineOf(body, 'tests_added').cost as Body).input_tokens = '12')],
    ['a subject that is not text', (body) => ((headlineOf(body, 'tests_added').latest as Body).subject = 4)],
    ['no daily series', (body) => delete headlineOf(body, 'tests_added').series]
  ]
  for (const [what, change] of unreadable) {
    test(`${what} makes the whole report unreadable`, async () => {
      const body = weekBody()
      change(body)
      const mounted = await allProjects(json(body)).mount({})
      assert.deepEqual(((await mounted.worker.request('metrics.read', {})) as { metrics: unknown }).metrics, { kind: 'unreadable' })
      await mounted.worker.deactivate()
    })
  }
})

describe("the metric's view request", () => {
  test('a name that is not a metric name, a window that is not one, a missing window, an empty project id or an unknown key is refused', async () => {
    const mounted = await allProjects().mount({})
    for (const input of [
      { name: 'Orchon Synthetic', window: '7d' },
      { name: 'orchon_synthetic.tests_added', window: '14d' },
      { name: 'orchon_synthetic.tests_added' },
      { name: 'orchon_synthetic.tests_added', window: '7d', codebaseId: '' },
      { name: 'orchon_synthetic.tests_added', window: '7d', subject: 'x' },
      null
    ]) {
      await assert.rejects(readMetric(mounted, input))
    }
    await mounted.worker.deactivate()
  })
})
