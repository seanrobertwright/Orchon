// The worker's request protocol seam for calibrations: the worker mounted on a scripted Archon
// that replays the recorded 0.14.0 metrics answers, and a stand-in Orca host. These tests cover
// the year-long report the worker reads for calibrations after the window's, the marker a ratio
// card carries in each state, and the calibration lines a metric's view and the Details rows hold.
//
// The expected words follow Archon's console at 0.14.0 (commit
// 8def159a6b2c23e832a5283b4131cfffd9af9344): `calibrationOf` and `calibrationSentence` in
// `packages/web/src/experiments/console/routes/metrics/model.ts`, `CalibrationPill` and
// `RatioBody` in `MetricsOverview.tsx`, `MeasuredBox` and `UnmatchedCalibrations` in
// `MetricsDetails.tsx` beside it.
//
// The spend-mode recording (`fixtures/0.14.0/spend/metrics/metrics.json`) is SYNTHETIC: every
// record and every `orchon-synthetic` card in it was made up by the recorder's own pack. Its year
// holds `orchon_synthetic.useless_tests_caught`, a score that calibrates
// `orchon_synthetic.tests_useless` with a mean of 0.75 over 4 records, at the same identity as
// the numerator's headline (no instrument, no models); the pack declares `rough_below` 0.8.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  HANG,
  health,
  METRICS_AT as AT,
  METRICS_PROJECT as PROJECT,
  METRICS_SPEND as SPEND,
  recorded,
  scene,
  settle,
  type MountedScene,
  type Scene,
  type Scripted
} from '../scripts/scripted-archon.ts'
import type { MetricsCalibrationsPost } from './calibration-view'
import type { MetricAnswer } from './metric-view'
import type { MetricsAnswer, MetricsView } from './metrics-view'
import type { OverviewView } from './overview-view'

const PROJECT_VIEWS = `${DEFAULT}/api/metric-views?codebaseId=${PROJECT}`
const report = (since: string): string => `${DEFAULT}/api/metrics?since=${since}&codebaseId=${PROJECT}`
const WEEK = report('7d')
const YEAR = report('365d')

function metricsScene(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
  stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
  return stage
}

/**
 * The project's scope: its declarations, and only the year was recorded for the project, so the
 * recorded year stands in for the project's week too.
 */
function projectScene(year: Scripted = recorded('0.14.0', SPEND, AT.projectYear)): Scene {
  const stage = metricsScene()
  stage.archon.answer(PROJECT_VIEWS, recorded('0.14.0', SPEND, AT.projectViews))
  stage.archon.answer(WEEK, recorded('0.14.0', SPEND, AT.projectYear))
  stage.archon.answer(YEAR, year)
  return stage
}

async function read(mounted: MountedScene, input: Record<string, unknown> = { codebaseId: PROJECT }): Promise<MetricsAnswer> {
  return (await mounted.worker.request('metrics.read', input)) as MetricsAnswer
}
const ready = (view: MetricsView): Extract<MetricsView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The metrics view is ${view.kind}.`)
  return view
}
const metricCalls = (stage: Scene): string[] => stage.archon.calls.filter((call) => call.url.includes('/api/metric')).map((call) => call.url)
const calibrationPosts = (mounted: MountedScene): MetricsCalibrationsPost[] =>
  mounted.worker.posts.filter((post) => post.event === 'metrics.calibrations').map((post) => post.payload as MetricsCalibrationsPost)

/** The synthetic ratio card as figure, badge and line. */
function ratio(overview: OverviewView | undefined): [string, string | null, string | null] {
  const card = overview?.packs[1]?.cards[1]
  if (card?.kind !== 'figure') throw new Error('The synthetic ratio card has no figure.')
  return [card.figure, card.badge ?? null, card.line]
}

describe('the year-long report for calibrations', () => {
  test('is read after the window\'s report answers, one request at a time, and the read answers before it with "calibration loading"', async () => {
    const stage = projectScene(HANG)
    stage.archon.answer(WEEK, HANG)
    const mounted = await stage.mount({ storage: {} })
    void read(mounted)
    await settle()
    // The window's report holds Archon, so the year waits.
    assert.deepEqual(metricCalls(stage), [PROJECT_VIEWS, WEEK])
    await mounted.worker.deactivate()

    const again = projectScene(HANG)
    const answered = await again.mount({ storage: {} })
    const view = ready((await read(answered)).metrics)
    await settle()
    assert.deepEqual(metricCalls(again), [PROJECT_VIEWS, WEEK, YEAR])
    assert.deepEqual(ratio(view.overview), ['25%', 'calibration loading', '2 of 8 new tests'])
    assert.deepEqual(calibrationPosts(answered), [])
    await answered.worker.deactivate()
  })

  test('once it answers, the worker posts the cards again: the recorded calibration is below 0.8, so "rough", and the line says the judge catches 3 of 4', async () => {
    const stage = projectScene()
    const mounted = await stage.mount({ storage: {} })
    const view = ready((await read(mounted)).metrics)
    await settle()
    const [post] = calibrationPosts(mounted)
    assert.equal(calibrationPosts(mounted).length, 1)
    assert.equal(post?.codebaseId, PROJECT)
    assert.equal(post?.window, '7d')
    assert.equal(post?.fetchedAt, view.fetchedAt)
    assert.deepEqual(ratio(post?.overview), ['25%', 'rough', '2 of 8 new tests · judge catches 3 of 4'])
    await mounted.worker.deactivate()
  })
})

/** The recorded project year, as a value a test can change. */
type Body = Record<string, unknown>
function yearBody(): Body {
  const answer = recorded('0.14.0', SPEND, AT.projectYear)
  if (answer.kind !== 'json') throw new Error('The recorded year is not JSON.')
  return structuredClone(answer.value) as Body
}
const metricOf = (body: Body, name: string): Body => {
  const found = (body.metrics as Body[]).find((metric) => metric.name === `orchon_synthetic.${name}`)
  if (found === undefined) throw new Error(`The recorded year has no ${name}.`)
  return found
}
const firstInstrument = (metric: Body): Body => (metric.instruments as Body[])[0] as Body
/** The recorded year with the calibration score changed by `change`. */
function changedYear(change: (calibrator: Body) => void): Scripted {
  const body = yearBody()
  change(metricOf(body, 'useless_tests_caught'))
  return { kind: 'json', value: body }
}

/** The synthetic ratio card once the year-long report answers `year`. */
async function calibratedCard(year: Scripted): Promise<[string, string | null, string | null]> {
  const stage = projectScene(year)
  const mounted = await stage.mount({ storage: {} })
  await read(mounted)
  await settle()
  const posts = calibrationPosts(mounted)
  await mounted.worker.deactivate()
  assert.equal(posts.length, 1)
  return ratio(posts[0]?.overview)
}

describe("a ratio card's calibration marker, by the console's rules", () => {
  test('a calibration at or above the threshold carries no badge, and the line says the judge catches 9 of 10', async () => {
    const card = await calibratedCard(
      changedYear((calibrator) => Object.assign(firstInstrument(calibrator), { value: 0.9, n: 10 }))
    )
    assert.deepEqual(card, ['25%', null, '2 of 8 new tests · judge catches 9 of 10'])
    // Exactly the threshold is not below it.
    const at = await calibratedCard(changedYear((calibrator) => Object.assign(firstInstrument(calibrator), { value: 0.8, n: 10 })))
    assert.deepEqual(at, ['25%', null, '2 of 8 new tests · judge catches 8 of 10'])
  })

  test('"not calibrated" when the score was measured by another judge version than the numerator\'s headline', async () => {
    const card = await calibratedCard(
      changedYear((calibrator) => {
        calibrator.headline_instrument = 'judge-v2'
        firstInstrument(calibrator).instrument = 'judge-v2'
      })
    )
    assert.deepEqual(card, ['25%', 'not calibrated', '2 of 8 new tests'])
  })

  test('"not calibrated" when the same judge ran on other models, since the models are part of the identity', async () => {
    const card = await calibratedCard(
      changedYear((calibrator) => {
        calibrator.headline_measured_by = ['claude-opus']
        firstInstrument(calibrator).measured_by = ['claude-opus']
      })
    )
    assert.deepEqual(card, ['25%', 'not calibrated', '2 of 8 new tests'])
  })

  test('"not calibrated" when the score calibrates another metric, when the year holds no such score, and when its mean is outside 0 to 1', async () => {
    assert.deepEqual(await calibratedCard(changedYear((calibrator) => (calibrator.calibrates = 'orchon_synthetic.tests_added'))), [
      '25%',
      'not calibrated',
      '2 of 8 new tests'
    ])
    assert.deepEqual(await calibratedCard(changedYear((calibrator) => (calibrator.name = 'orchon_synthetic.other_score'))), [
      '25%',
      'not calibrated',
      '2 of 8 new tests'
    ])
    assert.deepEqual(await calibratedCard(changedYear((calibrator) => (firstInstrument(calibrator).value = 1.5))), [
      '25%',
      'not calibrated',
      '2 of 8 new tests'
    ])
  })

  test('"not calibrated" against the recorded empty install\'s report, which holds no calibration', async () => {
    assert.deepEqual(await calibratedCard(recorded('0.14.0', 'metrics', 1)), ['25%', 'not calibrated', '2 of 8 new tests'])
  })

  test('"calibration unavailable" when the year-long report fails, and the cards and the table still show', async () => {
    const stage = projectScene({ kind: 'json', value: { error: 'The metrics store is busy.' }, status: 500 })
    const mounted = await stage.mount({ storage: {} })
    const view = ready((await read(mounted)).metrics)
    await settle()
    assert.equal(view.rows.length, 6)
    assert.deepEqual(ratio(calibrationPosts(mounted)[0]?.overview), ['25%', 'calibration unavailable', '2 of 8 new tests'])
    // A read within 5 minutes answers the cards as they now stand, and asks Archon nothing.
    const before = metricCalls(stage).length
    const again = ready((await read(mounted)).metrics)
    assert.deepEqual(ratio(again.overview), ['25%', 'calibration unavailable', '2 of 8 new tests'])
    assert.equal(again.rows.length, 6)
    assert.equal(metricCalls(stage).length, before)
    await mounted.worker.deactivate()
  })

  test('the year-long report waits 30 seconds, then the card reads "calibration unavailable"; it is not sent again', async () => {
    const stage = projectScene(HANG)
    const mounted = await stage.mount({ storage: {} })
    await read(mounted)
    await stage.clock.advance(30_000 - 1)
    assert.deepEqual(calibrationPosts(mounted), [])
    await stage.clock.advance(1)
    assert.deepEqual(ratio(calibrationPosts(mounted)[0]?.overview), ['25%', 'calibration unavailable', '2 of 8 new tests'])
    await stage.clock.advance(120_000)
    assert.equal(metricCalls(stage).filter((url) => url === YEAR).length, 1)
    await mounted.worker.deactivate()
  })

  test('a new read of Archon stops the year-long report in flight, so the declarations never run beside it, and the stopped one posts nothing', async () => {
    const stage = projectScene(HANG)
    const mounted = await stage.mount({ storage: {} })
    await read(mounted)
    await settle()
    stage.archon.answer(YEAR, recorded('0.14.0', SPEND, AT.projectYear))
    await read(mounted, { codebaseId: PROJECT, refresh: true })
    // Past the first one's timeout: had it kept running, it would post "calibration unavailable".
    await stage.clock.advance(60_000)
    assert.deepEqual(metricCalls(stage), [PROJECT_VIEWS, WEEK, YEAR, PROJECT_VIEWS, WEEK, YEAR])
    assert.deepEqual(
      calibrationPosts(mounted).map((post) => ratio(post.overview)[1]),
      ['rough']
    )
    await mounted.worker.deactivate()
  })
})

async function metricCalibrations(mounted: MountedScene, name: string, input: Record<string, unknown> = { codebaseId: PROJECT }): Promise<unknown> {
  const answer = (await mounted.worker.request('metric.read', { name: `orchon_synthetic.${name}`, window: '7d', ...input })) as MetricAnswer
  if (answer.metric.kind !== 'ready') throw new Error(`The metric view is ${answer.metric.kind}.`)
  return answer.metric.metric.calibrations
}

const ROUGH_SENTENCE = 'Judge catches 3 of 4 labelled cases (75%); below 80% the share is rough.'

describe("a metric's view lists its calibrations", () => {
  test('the recorded score that calibrates the useless tests: one line with its plain name, and the sentence that explains "rough"', async () => {
    const stage = projectScene()
    const mounted = await stage.mount({ storage: {} })
    await read(mounted)
    await settle()
    const before = metricCalls(stage).length
    assert.deepEqual(await metricCalibrations(mounted, 'tests_useless'), {
      state: 'loaded',
      lines: ['Synthetic judge catch rate: 75% from 4 records'],
      more: 0,
      sentence: ROUGH_SENTENCE
    })
    // A metric nothing calibrates and no ratio declares a calibration for lists none.
    assert.deepEqual(await metricCalibrations(mounted, 'tests_added'), { state: 'loaded', lines: [], more: 0, sentence: null })
    assert.equal(metricCalls(stage).length, before)
    await mounted.worker.deactivate()
  })

  test('a score of another judge version says it is not calibrated for this version, and no sentence is given', async () => {
    const stage = projectScene(
      changedYear((calibrator) => {
        calibrator.headline_instrument = 'judge-v2'
        firstInstrument(calibrator).instrument = 'judge-v2'
      })
    )
    const mounted = await stage.mount({ storage: {} })
    await read(mounted)
    await settle()
    assert.deepEqual(await metricCalibrations(mounted, 'tests_useless'), {
      state: 'loaded',
      lines: ['Synthetic judge catch rate: not calibrated for this version'],
      more: 0,
      sentence: null
    })
    await mounted.worker.deactivate()
  })

  test("at most 5 lines in Archon's order, and how many more", async () => {
    const body = yearBody()
    const calibrator = metricOf(body, 'useless_tests_caught')
    for (const index of [1, 2, 3, 4, 5, 6]) {
      ;(body.metrics as Body[]).push({ ...structuredClone(calibrator), name: `orchon_synthetic.catch_${String(index)}` })
    }
    const stage = projectScene({ kind: 'json', value: body })
    const mounted = await stage.mount({ storage: {} })
    await read(mounted)
    await settle()
    assert.deepEqual(await metricCalibrations(mounted, 'tests_useless'), {
      state: 'loaded',
      lines: [
        'Synthetic judge catch rate: 75% from 4 records',
        'orchon_synthetic.catch_1: 75% from 4 records',
        'orchon_synthetic.catch_2: 75% from 4 records',
        'orchon_synthetic.catch_3: 75% from 4 records',
        'orchon_synthetic.catch_4: 75% from 4 records'
      ],
      more: 2,
      sentence: ROUGH_SENTENCE
    })
    await mounted.worker.deactivate()
  })

  test('while the year-long report loads it says so, and once it fails it says why', async () => {
    const stage = projectScene(HANG)
    const mounted = await stage.mount({ storage: {} })
    await read(mounted)
    assert.deepEqual(await metricCalibrations(mounted, 'tests_useless'), { state: 'loading' })
    await stage.clock.advance(30_000)
    assert.deepEqual(await metricCalibrations(mounted, 'tests_useless'), { state: 'unavailable', message: 'Archon did not answer within 30 seconds.' })
    await mounted.worker.deactivate()
  })

  test('after a restart, when the worker holds no report, it reads the one metric and no calibrations', async () => {
    const stage = metricsScene()
    const byName = `${DEFAULT}/api/metrics?since=7d&name=orchon_synthetic.tests_useless&codebaseId=${PROJECT}`
    stage.archon.answer(byName, recorded('0.14.0', SPEND, AT.projectYear))
    const mounted = await stage.mount({ storage: {} })
    assert.deepEqual(await metricCalibrations(mounted, 'tests_useless'), { state: 'unread' })
    assert.deepEqual(metricCalls(stage), [byName])
    await mounted.worker.deactivate()
  })
})

describe('the Details rows', () => {
  test('a calibration whose metric has records in the window is not listed under the table', async () => {
    const mounted = await projectScene().mount({ storage: {} })
    const view = ready((await read(mounted)).metrics)
    assert.deepEqual([view.unmatchedCalibrations, view.unmatchedMore], [[], 0])
    await mounted.worker.deactivate()
  })

  test("calibrations whose metric has no records in the window are listed under the table, at most 5, with how many more", async () => {
    const body = yearBody()
    body.metrics = (body.metrics as Body[]).filter((metric) => metric.name !== 'orchon_synthetic.tests_useless')
    const stage = projectScene()
    stage.archon.answer(WEEK, { kind: 'json', value: body })
    const mounted = await stage.mount({ storage: {} })
    const view = ready((await read(mounted)).metrics)
    assert.deepEqual(view.unmatchedCalibrations, [
      'orchon_synthetic.useless_tests_caught calibrates orchon_synthetic.tests_useless, which has no records in this window: 75% from 4 records.'
    ])
    await mounted.worker.deactivate()

    const calibrator = metricOf(body, 'useless_tests_caught')
    for (const index of [1, 2, 3, 4, 5, 6]) {
      ;(body.metrics as Body[]).push({ ...structuredClone(calibrator), name: `orchon_synthetic.catch_${String(index)}` })
    }
    const many = projectScene()
    many.archon.answer(WEEK, { kind: 'json', value: body })
    const again = await many.mount({ storage: {} })
    const capped = ready((await read(again)).metrics)
    assert.equal(capped.unmatchedCalibrations.length, 5)
    assert.equal(capped.unmatchedMore, 2)
    assert.ok(capped.unmatchedCalibrations[4]?.startsWith('orchon_synthetic.catch_4 calibrates'))
    await again.worker.deactivate()
  })
})
