// The frame seam for the Metrics section: src/panel.tsx mounted on a scripted worker that answers
// the metrics read, the scope and the runs table. These tests cover the section's header, the
// Details table, what it says while a window loads and when a read fails, and when the panel asks
// the worker for the report again.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answeringMetrics, REPORT_END, sampleReport } from '../scripts/metrics-samples.ts'
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

async function mountMetrics(
  metrics: (request: MetricsRequest) => MetricsView | Promise<MetricsView>,
  options: Parameters<typeof answeringMetrics>[1] = {}
): Promise<TestPanel> {
  panel = await mount(panelModule, { host: mockHost(answeringMetrics(metrics, options)), persisted: { workspace: { section: 'metrics' } } })
  return panel
}

/** Every metrics request the panel sent, by its input, in order. */
const sent = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'metrics.read')
    .map((params) => (params as { input?: unknown }).input ?? null)

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

const TABLE = { type: 'Table', label: 'Metrics' }

describe('the section header', () => {
  test('a horizontal "Window" radio group of 7d, 30d and 90d on 7d, a named Refresh button, the status line and the Overview and Details tabs', async () => {
    const view = await mountMetrics(() => sampleReport())
    const window = view.find({ type: 'RadioGroup', label: 'Window' })
    assert.equal(window?.props.orientation, 'horizontal')
    assert.deepEqual(
      (window?.props.options as { value: string; label: string }[]).map((option) => [option.value, option.label]),
      [
        ['7d', '7d'],
        ['30d', '30d'],
        ['90d', '90d']
      ]
    )
    assert.equal(view.valueOf({ type: 'RadioGroup', label: 'Window' }), '7d')
    assert.equal(view.find({ type: 'IconButton', label: 'Refresh' })?.props.icon, 'refresh')
    assert.equal(view.find({ text: /^Last 7 days · / })?.text, 'Last 7 days · Nov 11 – Nov 18 · updated 2 minutes ago')
    const tabs = view.find({ type: 'Tabs', label: 'Metrics views' })
    assert.ok(tabs)
    assert.deepEqual(
      view.findAll({ type: 'Tab' }).filter((tab) => tab.path.startsWith(tabs.path) && tab.path !== tabs.path).map((tab) => tab.props.label),
      ['Overview', 'Details']
    )
    assert.equal(view.valueOf({ type: 'Tabs', label: 'Metrics views' }), 'details')
    clean(view)
  })
})

describe('the Details table', () => {
  test('one row per metric with its plain name and value; Records and Known cost from 360 px and Latest from 480 px', async () => {
    const view = await mountMetrics(() => sampleReport())
    assert.deepEqual(view.rowsOf(TABLE), ['sdlc.prs_merged', 'sdlc.review_score', 'sdlc.test_histogram'])
    assert.deepEqual(view.columnsOf(TABLE, { width: 220 }), ['metric', 'value'])
    assert.deepEqual(view.columnsOf(TABLE, { width: 360 }), ['metric', 'value', 'records', 'cost'])
    assert.deepEqual(view.columnsOf(TABLE, { width: 480 }), ['metric', 'value', 'records', 'cost', 'latest'])
    const rows = view.find(TABLE)?.props.rows as { key: string; cells: Record<string, unknown> }[]
    assert.deepEqual(rows[0]?.cells, { metric: 'PRs merged', value: '12 PRs', records: 12, cost: 'none recorded', latest: '1' })
    assert.deepEqual(rows[1]?.cells, { metric: 'Review score', value: '70%', records: 3, cost: '≥ $1.42', latest: '90%' })
    assert.deepEqual(rows[2]?.cells, { metric: 'Test histogram', value: 'a kind this version of Orchon does not show', records: null, cost: null, latest: null })
    assert.ok(view.find({ text: /^Known cost is the cost of the runs that produced a metric's records\./ }))
    assert.deepEqual(sent(view), [{ codebaseId: 'cb-web' }])
    clean(view)
  })
})
