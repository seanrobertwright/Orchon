// The frame seam for a metric's view: src/panel.tsx mounted on a scripted worker that answers the
// metrics read, a metric's view, the scope and the runs table. These tests cover selecting a
// Details row, what the metric's view draws, the way back, how a card's Details link meets a
// metric's view, and the console link from it.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { readFacts } from '../scripts/fact-rows.ts'
import { answeringMetric, sampleMetric } from '../scripts/metric-samples.ts'
import { REPORT_END, sampleReport } from '../scripts/metrics-samples.ts'
import { formatDateTime } from './dates'
import type { MetricRequest, MetricView } from './metric-view'
import type { MetricsRequest, MetricsView } from './metrics-view'
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

async function mountMetric(
  metric: (request: MetricRequest) => MetricView | Promise<MetricView> = () => ({ kind: 'ready', metric: sampleMetric() }),
  metrics: (request: MetricsRequest) => MetricsView | Promise<MetricsView> = () => sampleReport(),
  options: Parameters<typeof answeringMetric>[2] = {}
): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answeringMetric(metrics, metric, options)),
    locale: 'en-US',
    // The section lands on Overview; the Details table is its other tab.
    persisted: { workspace: { section: 'metrics', metricsTab: 'details' } }
  })
  return panel
}

/** Every request of `name` the panel sent, by its input, in order. */
const sent = (view: TestPanel, name: string): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input?: unknown }).input ?? null)

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

const TABLE = { type: 'Table', label: 'Metrics' }
const BACK = { type: 'Button', text: 'Details' }
const FIGURES = { type: 'List', label: 'Review score' }
const items = (view: TestPanel): [string, string][] => (readFacts(view, FIGURES.label) ?? []).map((item) => [item.label, item.value])

describe('selecting a row of the Details table', () => {
  test("replaces the table with the metric's view and a back control, and asks the worker for that metric of the report on screen", async () => {
    const view = await mountMetric()
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.equal(view.find(TABLE), null)
    assert.ok(view.find(BACK))
    assert.ok(view.find(FIGURES))
    assert.deepEqual(sent(view, 'metric.read'), [{ name: 'sdlc.review_score', window: '7d', codebaseId: 'cb-web' }])
    assert.deepEqual(sent(view, 'metrics.read'), [{ codebaseId: 'cb-web' }])
    clean(view)
  })

  test('Enter or a double click on a row opens it too', async () => {
    const view = await mountMetric()
    await view.activateRow(TABLE, 'sdlc.prs_merged')
    assert.equal(view.find(TABLE), null)
    assert.deepEqual(sent(view, 'metric.read'), [{ name: 'sdlc.prs_merged', window: '7d', codebaseId: 'cb-web' }])
    clean(view)
  })

  test('the back control shows the table again without reading the report again', async () => {
    const view = await mountMetric()
    await view.selectRows(TABLE, ['sdlc.review_score'])
    await view.press(BACK)
    assert.deepEqual(view.rowsOf(TABLE), ['sdlc.prs_merged', 'sdlc.review_score', 'sdlc.test_histogram'])
    assert.equal(view.find(FIGURES), null)
    assert.deepEqual(sent(view, 'metrics.read'), [{ codebaseId: 'cb-web' }])
    clean(view)
  })
})

describe("the metric's view", () => {
  test('labelled values: the dotted name, judge version, value and interval, records, known cost with its gaps and tokens, and the latest record', async () => {
    const view = await mountMetric()
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.deepEqual(items(view), [
      ['Name', 'sdlc.review_score'],
      ['Judge version', 'judge-v2 on claude-opus'],
      ['Value', '70%'],
      ['95% interval', '20% – 100%'],
      ['Records', '3'],
      ['Known cost', '≥ $1.42'],
      ['Runs', '4'],
      ['Runs without cost', '1'],
      ['Runs without tokens', '2'],
      ['Runs with partial cost', '0'],
      ['Runs missing', '1'],
      ['Tokens', '12,000 in / 3,400 out tokens'],
      ['Latest', '90%'],
      ['Latest recorded', formatDateTime(Date.UTC(2026, 10, 17, 14, 32, 0), 'en-US')],
      ['Latest subject', 'pull request 42']
    ])
    clean(view)
  })

  test('without a judge version, an interval, a parsable latest time or a subject, those lines say so or are left out', async () => {
    const metric = sampleMetric({ judgeVersion: null, interval: null, latest: { value: '1', at: null, subject: null } })
    const view = await mountMetric(() => ({ kind: 'ready', metric }))
    await view.selectRows(TABLE, ['sdlc.review_score'])
    const labels = items(view).map(([label]) => label)
    assert.ok(!labels.includes('Judge version'))
    assert.ok(!labels.includes('Latest recorded'))
    assert.deepEqual(
      items(view).filter(([label]) => label === '95% interval' || label === 'Latest subject'),
      [
        ['95% interval', 'none reported'],
        ['Latest subject', 'none']
      ]
    )
    clean(view)
  })

  test('hidden older judge versions are listed, at most 5, then "and N more in Archon\'s console"', async () => {
    const olderVersions = ['judge-v1', 'judge-v2', 'judge-v3', 'judge-v4', 'judge-v5']
    const view = await mountMetric(() => ({ kind: 'ready', metric: sampleMetric({ olderVersions, olderMore: 3 }) }))
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.ok(view.find({ text: 'Hidden older judge versions' }))
    for (const version of olderVersions) assert.ok(view.find({ text: version }), version)
    assert.ok(view.find({ text: "and 3 more in Archon's console" }))
    clean(view)
  })

  test('"By day" is collapsed, and opened shows day, value and records newest first under "Day (UTC)", each day as Archon gave it', async () => {
    const view = await mountMetric(() => ({ kind: 'ready', metric: sampleMetric({ byDayMore: 2 }) }))
    await view.selectRows(TABLE, ['sdlc.review_score'])
    const byDay = { type: 'Collapsible', label: 'By day' }
    assert.equal(view.find(byDay)?.props.open, false)
    await view.toggle(byDay)
    assert.equal(view.find(byDay)?.props.open, true)
    const table = view.find({ type: 'Table', label: 'By day' })
    assert.deepEqual(
      (table?.props.columns as { key: string; label: string }[]).map((column) => column.label),
      ['Day (UTC)', 'Value', 'Records']
    )
    assert.deepEqual(
      (table?.props.rows as { key: string; cells: Record<string, unknown> }[]).map((row) => [row.key, row.cells]),
      [
        ['2026-11-17', { day: '2026-11-17', value: '90%', records: 1 }],
        ['2026-11-15', { day: '2026-11-15', value: '60%', records: 2 }]
      ]
    )
    assert.ok(view.find({ text: "and 2 more in Archon's console" }))
    clean(view)
  })

  test('a metric of a kind Orchon does not know, and one the report no longer has, say so', async () => {
    const view = await mountMetric((request) => (request.name === 'sdlc.test_histogram' ? { kind: 'unknown-kind' } : { kind: 'absent' }))
    await view.selectRows(TABLE, ['sdlc.test_histogram'])
    assert.ok(view.find({ text: /a kind this version of Orchon does not show/ }))
    await view.press(BACK)
    await view.selectRows(TABLE, ['sdlc.prs_merged'])
    assert.ok(view.find({ text: /^Archon reports no records of this metric in the last 7 days\./ }))
    clean(view)
  })

  test("a failed read says what the Details table would say, with Retry that asks for the metric again", async () => {
    let failing = true
    const view = await mountMetric(() => (failing ? { kind: 'timeout' } : { kind: 'ready', metric: sampleMetric() }))
    await view.selectRows(TABLE, ['sdlc.review_score'])
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Archon took too long to answer\. Retry$/)
    failing = false
    await view.press({ type: 'Button', text: 'Retry' })
    assert.ok(view.find(FIGURES))
    assert.equal(sent(view, 'metric.read').length, 2)
    assert.deepEqual(sent(view, 'metrics.read'), [{ codebaseId: 'cb-web' }])
    clean(view)
  })

  test('a new report for another window asks for the open metric of that window', async () => {
    const view = await mountMetric(undefined, (request) => sampleReport(request.window ?? '7d'))
    await view.selectRows(TABLE, ['sdlc.review_score'])
    await view.select({ type: 'RadioGroup', label: 'Window' }, '30d')
    assert.deepEqual(sent(view, 'metric.read'), [
      { name: 'sdlc.review_score', window: '7d', codebaseId: 'cb-web' },
      { name: 'sdlc.review_score', window: '30d', codebaseId: 'cb-web' }
    ])
    assert.ok(view.find(FIGURES))
    clean(view)
  })
})

const TABS = { type: 'Tabs', label: 'Metrics views' }

/** Presses the Details link of the Overview card with this title. */
async function pressCardDetails(view: TestPanel, title: string): Promise<void> {
  await view.select(TABS, 'overview')
  const card = view.find({ type: 'Card', label: title })
  assert.ok(card)
  const link = view.findAll({ type: 'Link' }).find((each) => each.path.startsWith(card.path) && each.path !== card.path)
  assert.ok(link)
  await view.press(link)
}

describe("a card's Details link and a metric's view", () => {
  test("a press on the row the card's link selected opens that metric's view", async () => {
    const view = await mountMetric()
    await pressCardDetails(view, 'PRs merged')
    assert.deepEqual(view.valueOf(TABLE), ['sdlc.prs_merged'])
    assert.deepEqual(sent(view, 'metric.read'), [])
    // A press on a selected row of a single-selection table clears the selection.
    await view.selectRows(TABLE, [])
    assert.equal(view.find(TABLE), null)
    assert.deepEqual(sent(view, 'metric.read'), [{ name: 'sdlc.prs_merged', window: '7d', codebaseId: 'cb-web' }])
    clean(view)
  })

  test("the link closes a metric's view open in Details and shows the table at the card's metric", async () => {
    const view = await mountMetric()
    await view.selectRows(TABLE, ['sdlc.review_score'])
    await pressCardDetails(view, 'PRs merged')
    assert.equal(view.valueOf(TABS), 'details')
    assert.equal(view.find(FIGURES), null)
    assert.deepEqual(view.valueOf(TABLE), ['sdlc.prs_merged'])
    clean(view)
  })
})

describe("the console link from a metric's view", () => {
  test("opens the console's Details screen at that metric's row, for the project and window", async () => {
    const view = await mountMetric()
    await view.selectRows(TABLE, ['sdlc.review_score'])
    await view.press({ type: 'Link', text: 'Open in Archon console' })
    assert.deepEqual(view.host.callsOf('shell.openExternal'), [{ url: 'http://127.0.0.1:3090/console/p/cb-web/metrics/details?window=7d#metric-sdlc.review_score' }])
    clean(view)
  })
})
