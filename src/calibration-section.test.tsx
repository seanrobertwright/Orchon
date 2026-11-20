// The frame seam for calibrations: src/panel.tsx mounted on a scripted worker that answers the
// metrics read, a metric's view, the scope and the runs table, and posts the cards again as the
// worker does once its year-long report answers. These tests cover the marker a ratio card draws
// in each state, the post that replaces the cards of the report on screen and no other, the
// calibration lines under the Details table and in a metric's view, and the sentence that
// explains "rough", which only a metric's view says.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answeringMetric, sampleMetric } from '../scripts/metric-samples.ts'
import { REPORT_END, SAMPLE_OVERVIEW, sampleReport } from '../scripts/metrics-samples.ts'
import type { MetricsCalibrationsPost } from './calibration-view'
import type { MetricRequest, MetricView } from './metric-view'
import type { MetricsRequest, MetricsView } from './metrics-view'
import type { OverviewCard, OverviewView } from './overview-view'
import * as panelModule from './panel'

let panel: TestPanel | undefined
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: REPORT_END })
})
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

async function mountMetrics(
  options: {
    metrics?: (request: MetricsRequest) => MetricsView | Promise<MetricsView>
    metric?: (request: MetricRequest) => MetricView | Promise<MetricView>
    tab?: 'overview' | 'details'
  } = {}
): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answeringMetric(options.metrics ?? (() => sampleReport()), options.metric ?? (() => ({ kind: 'ready', metric: sampleMetric() })))),
    locale: 'en-US',
    persisted: { workspace: { section: 'metrics', metricsTab: options.tab ?? 'overview' } }
  })
  return panel
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/** Lets the panel draw what a post set off. */
const drawn = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** The sample cards with the ratio card changed by `change`. */
function withRatio(change: Partial<Extract<OverviewCard, { kind: 'figure' }>>): OverviewView {
  const overview = structuredClone(SAMPLE_OVERVIEW)
  const pack = overview.packs[0]
  if (pack === undefined) throw new Error('The sample has no pack.')
  pack.cards = pack.cards.map((card) => (card.kind === 'figure' && card.shape === 'ratio' ? { ...card, ...change } : card))
  return overview
}

/** Elements of one type inside the card titled `title`. */
const inside = (view: TestPanel, title: string, type: string) => {
  const root = view.find({ type: 'Card', label: title })
  if (root === null) throw new Error(`No card ${title}.`)
  return view.findAll({ type }).filter((each) => each.path.startsWith(root.path) && each.path !== root.path)
}
const badges = (view: TestPanel): [string, unknown][] => inside(view, 'Useless tests', 'Badge').map((badge) => [badge.text, badge.props.tone])

describe("a ratio card's calibration marker", () => {
  for (const marker of ['rough', 'not calibrated', 'calibration loading', 'calibration unavailable']) {
    test(`"${marker}" is a warning badge in words beside the figure, which still shows`, async () => {
      const view = await mountMetrics({ metrics: () => sampleReport('7d', undefined, { overview: withRatio({ badge: marker }) }) })
      assert.deepEqual(badges(view), [[marker, 'warning']])
      assert.equal(inside(view, 'Useless tests', 'Heading')[0]?.text, '38%')
      clean(view)
    })
  }

  test('a calibration that holds draws no badge, and the line says what the judge catches', async () => {
    const view = await mountMetrics({
      metrics: () => sampleReport('7d', undefined, { overview: withRatio({ line: '5 of 13 new tests · judge catches 9 of 10' }) })
    })
    assert.deepEqual(badges(view), [])
    assert.ok(inside(view, 'Useless tests', 'Text').some((text) => text.text === '5 of 13 new tests · judge catches 9 of 10'))
    clean(view)
  })

  test('the cards the worker posts once the year-long report answers replace those of the report on screen, and only those', async () => {
    const loading = withRatio({ badge: 'calibration loading' })
    const view = await mountMetrics({ metrics: () => sampleReport('7d', undefined, { overview: loading }) })
    const shown = sampleReport()
    const post = (change: Partial<MetricsCalibrationsPost>): MetricsCalibrationsPost => ({
      codebaseId: 'cb-web',
      window: '7d',
      fetchedAt: shown.fetchedAt,
      overview: withRatio({ badge: 'rough', line: '5 of 13 new tests · judge catches 3 of 4' }),
      ...change
    })
    // Another scope's, another window's and an older read's cards are not the report on screen's.
    await view.post('metrics.calibrations', post({ codebaseId: 'cb-other' }))
    await view.post('metrics.calibrations', post({ window: '30d' }))
    await view.post('metrics.calibrations', post({ fetchedAt: shown.fetchedAt - 1 }))
    await drawn()
    assert.deepEqual(badges(view), [['calibration loading', 'warning']])
    await view.post('metrics.calibrations', post({}))
    await drawn()
    assert.deepEqual(badges(view), [['rough', 'warning']])
    assert.ok(inside(view, 'Useless tests', 'Text').some((text) => text.text === '5 of 13 new tests · judge catches 3 of 4'))
    clean(view)
  })
})

const ROUGH_SENTENCE = 'Judge catches 3 of 4 labelled cases (75%); below 80% the share is rough.'
const allText = (view: TestPanel): string[] => view.findAll({ type: 'Text' }).map((text) => text.text)

describe('the Details table', () => {
  test('the calibrations whose metric has no records in the window are listed under it, with how many more', async () => {
    const line = 'sdlc.judge_catch_rate calibrates sdlc.tests_unprotective, which has no records in this window: 75% from 4 records.'
    const view = await mountMetrics({ tab: 'details', metrics: () => sampleReport('7d', undefined, { unmatchedCalibrations: [line], unmatchedMore: 3 }) })
    const texts = allText(view)
    assert.ok(texts.includes(line))
    assert.ok(texts.indexOf("and 3 more in Archon's console") > texts.indexOf(line))
    clean(view)
  })

  test('they are listed when the window holds no other measurement too, under the empty table', async () => {
    const line = 'sdlc.judge_catch_rate calibrates sdlc.tests_unprotective, which has no records in this window: 75% from 4 records.'
    const view = await mountMetrics({ tab: 'details', metrics: () => sampleReport('7d', [], { unmatchedCalibrations: [line] }) })
    assert.ok(view.find({ type: 'EmptyState', label: 'No measurements in the last 7 days.' }))
    assert.ok(allText(view).includes(line))
    clean(view)
  })
})

const TABLE = { type: 'Table', label: 'Metrics' }

describe("a metric's view", () => {
  test('lists one line per calibration, how many more, and the sentence that explains "rough"', async () => {
    const view = await mountMetrics({
      tab: 'details',
      metric: () => ({
        kind: 'ready',
        metric: sampleMetric({ calibrations: { state: 'loaded', lines: ['Judge catch rate: 75% from 4 records'], more: 2, sentence: ROUGH_SENTENCE } })
      })
    })
    await view.selectRows(TABLE, ['sdlc.review_score'])
    const texts = allText(view)
    assert.ok(texts.includes('Calibrations'))
    assert.ok(texts.includes('Judge catch rate: 75% from 4 records'))
    assert.ok(texts.includes("and 2 more in Archon's console"))
    assert.ok(texts.includes(ROUGH_SENTENCE))
    clean(view)
  })

  test('a metric nothing calibrates shows no calibration heading', async () => {
    const view = await mountMetrics({ tab: 'details' })
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.ok(!allText(view).includes('Calibrations'))
    clean(view)
  })

  test('while the year-long report loads it says so, and asks again for the metric when the worker posts the calibrated cards', async () => {
    let calibrations: Extract<MetricView, { kind: 'ready' }>['metric']['calibrations'] = { state: 'loading' }
    const view = await mountMetrics({ tab: 'details', metric: () => ({ kind: 'ready', metric: sampleMetric({ calibrations }) }) })
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.ok(allText(view).includes('Calibrations are loading.'))
    calibrations = { state: 'loaded', lines: ['Judge catch rate: 75% from 4 records'], more: 0, sentence: ROUGH_SENTENCE }
    const shown = sampleReport()
    await view.post('metrics.calibrations', { codebaseId: 'cb-web', window: '7d', fetchedAt: shown.fetchedAt, overview: SAMPLE_OVERVIEW })
    await drawn()
    assert.ok(allText(view).includes(ROUGH_SENTENCE))
    assert.ok(!allText(view).includes('Calibrations are loading.'))
    clean(view)
  })

  test('a failed year-long report says the calibrations could not be read, with the reason, and one never read says Refresh reads them', async () => {
    let calibrations: Extract<MetricView, { kind: 'ready' }>['metric']['calibrations'] = { state: 'unavailable', message: 'Archon did not answer within 30 seconds.' }
    const view = await mountMetrics({ tab: 'details', metric: () => ({ kind: 'ready', metric: sampleMetric({ calibrations }) }) })
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.ok(allText(view).includes('Calibrations unavailable. Archon did not answer within 30 seconds.'))
    await view.press({ type: 'Button', text: 'Details' })
    calibrations = { state: 'unread' }
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.ok(allText(view).includes('Calibrations were not read. Refresh reads them.'))
    clean(view)
  })
})

describe('the sentence that explains "rough"', () => {
  test('is never said on Overview', async () => {
    const view = await mountMetrics({ metrics: () => sampleReport('7d', undefined, { overview: withRatio({ badge: 'rough' }) }) })
    assert.ok(!allText(view).some((text) => text.includes('the share is rough')))
    clean(view)
  })
})
