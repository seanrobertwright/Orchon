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

async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

const SECTION_BAR = { label: 'Orchon sections' }
const WINDOW = { type: 'RadioGroup', label: 'Window' }

/** Lets the panel draw what a press set off, without waiting for a request still held. */
const drawn = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Worker answers the test lets go of by hand, for what the section shows while a read is in flight. */
function heldAnswers(): { answer(): Promise<MetricsView>; release(view: MetricsView): void } {
  const pending: ((view: MetricsView) => void)[] = []
  return {
    answer: () => new Promise<MetricsView>((resolve) => pending.push(resolve)),
    release: (view) => pending.shift()?.(view)
  }
}

describe('when the section reads', () => {
  test('a new window reads Archon again for it and is chosen at once; Refresh reads Archon again for the window on screen', async () => {
    const view = await mountMetrics((request) => sampleReport(request.window ?? '7d'))
    await view.select(WINDOW, '30d')
    assert.equal(view.valueOf(WINDOW), '30d')
    await view.press({ type: 'IconButton', label: 'Refresh' })
    assert.deepEqual(sent(view), [
      { codebaseId: 'cb-web' },
      { codebaseId: 'cb-web', window: '30d', refresh: true },
      { codebaseId: 'cb-web', window: '30d', refresh: true }
    ])
    assert.match(view.find({ text: /^Last 30 days · / })?.text ?? '', /^Last 30 days · Oct 19 – Nov 18 · updated/)
    clean(view)
  })

  test('a change of scope reads the new scope from Archon: "All projects" sends no project id', async () => {
    const view = await mountMetrics(() => sampleReport())
    await view.select({ type: 'RadioGroup', label: 'Scope' }, 'all')
    assert.deepEqual(sent(view), [{ codebaseId: 'cb-web' }, { refresh: true }])
    clean(view)
  })

  test("a change of scope never shows the last scope's figures: a spinner while the new scope loads, and only the callout when its read fails", async () => {
    const held = heldAnswers()
    const view = await mountMetrics((request) => (request.codebaseId === undefined ? held.answer() : sampleReport()))
    assert.equal(view.rowsOf(TABLE).length, 3)
    const selecting = view.select({ type: 'RadioGroup', label: 'Scope' }, 'all')
    await drawn()
    assert.equal(view.find({ type: 'Table' }), null)
    assert.equal(view.find({ text: /^Last 7 days · / }), null)
    assert.ok(view.find({ type: 'Spinner', label: 'Loading metrics…' }))
    held.release({ kind: 'timeout' })
    await selecting
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Archon took too long to answer\./)
    assert.equal(view.find({ type: 'Table' }), null)
    clean(view)
  })

  test('it has no safety refetch and ignores run hints; a return to the section asks the worker, which keeps a fresh report', async () => {
    const view = await mountMetrics(() => sampleReport())
    await advance(view, 600_000)
    await view.post('runs.changed', { types: ['workflow_status', 'dag_node'], runs: 'many' })
    await advance(view, 5_000)
    assert.equal(sent(view).length, 1)
    await view.select(SECTION_BAR, 'runs')
    await view.select(SECTION_BAR, 'metrics')
    assert.deepEqual(sent(view), [{ codebaseId: 'cb-web' }, { codebaseId: 'cb-web' }])
    clean(view)
  })

  test('while a new window loads, the previous figures stay under "Loading last 30 days… Showing last 7 days" with a spinner', async () => {
    const held = heldAnswers()
    const view = await mountMetrics((request) => (request.window === '30d' ? held.answer() : sampleReport()))
    const selecting = view.select(WINDOW, '30d')
    await drawn()
    assert.ok(view.find({ type: 'Spinner', label: 'Loading last 30 days…' }))
    assert.ok(view.find({ text: 'Loading last 30 days… Showing last 7 days' }))
    assert.deepEqual(view.rowsOf(TABLE), ['sdlc.prs_merged', 'sdlc.review_score', 'sdlc.test_histogram'])
    assert.match(view.find({ text: /^Last 7 days · / })?.text ?? '', /^Last 7 days/)
    held.release(sampleReport('30d', []))
    await selecting
    assert.equal(view.find({ type: 'Spinner' }), null)
    assert.ok(view.find({ type: 'EmptyState', label: 'No measurements in the last 30 days.' }))
    clean(view)
  })

  test('opens on the window the worker kept', async () => {
    const view = await mountMetrics((request) => sampleReport(request.window ?? '90d'), { kept: '90d' })
    assert.equal(view.valueOf(WINDOW), '90d')
    assert.deepEqual(sent(view), [{ codebaseId: 'cb-web' }])
    clean(view)
  })
})

describe('a read that fails', () => {
  test('a timeout reads "Archon took too long to answer" with Retry, is not tried again by itself, and Retry reads Archon again', async () => {
    const view = await mountMetrics(() => ({ kind: 'timeout' }))
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Archon took too long to answer\. Retry$/)
    await advance(view, 600_000)
    assert.equal(sent(view).length, 1)
    await view.press({ type: 'Button', text: 'Retry' })
    assert.deepEqual(sent(view), [{ codebaseId: 'cb-web' }, { codebaseId: 'cb-web', window: '7d', refresh: true }])
    assert.equal(view.find({ type: 'Table' }), null)
    clean(view)
  })

  test('a failed report reads "Could not load metrics." with the message Archon gave, and keeps the figures on screen', async () => {
    let failing = false
    const view = await mountMetrics(() => (failing ? { kind: 'failed', message: 'since must be a duration' } : sampleReport()))
    failing = true
    await view.press({ type: 'IconButton', label: 'Refresh' })
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Could not load metrics\. since must be a duration Retry$/)
    assert.equal(view.rowsOf(TABLE).length, 3)
    clean(view)
  })

  test('past the read cap the section says the answer is too large and shows no table', async () => {
    const view = await mountMetrics(() => ({ kind: 'too-large' }))
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Archon's metrics answer is too large to read\./)
    assert.equal(view.find({ type: 'Table' }), null)
    clean(view)
  })

  test('an answer that does not validate says the metrics answer could not be read', async () => {
    const view = await mountMetrics(() => ({ kind: 'unreadable' }))
    assert.match(view.find({ type: 'Callout' })?.text ?? '', /^Archon's metrics answer could not be read\./)
    clean(view)
  })

  test('a server that answers the metrics routes with HTML says plainly that metrics need a newer Archon', async () => {
    const view = await mountMetrics(() => ({ kind: 'missing', message: 'Metrics needs Archon 0.14.0 or newer. This server reports 0.14.0.' }))
    assert.equal(view.find({ type: 'EmptyState' })?.text, 'Metrics Metrics needs Archon 0.14.0 or newer. This server reports 0.14.0.')
    clean(view)
  })
})

describe('the rest of the section', () => {
  test('past 200 rows a line says how many more are in the console', async () => {
    const view = await mountMetrics(() => sampleReport('7d', undefined, { more: 12 }))
    assert.ok(view.find({ text: "and 12 more in Archon's console" }))
    clean(view)
  })

  test('the console link opens the Details screen for the project, its id percent-encoded, and the window; on Overview, the overview', async () => {
    const view = await mountMetrics(() => sampleReport(), {
      scope: () => ({ kind: 'matched', project: { id: 'cb/web 1', name: 'acme/web' }, by: 'path', choices: { projects: [], more: 0, unreadable: 0 } })
    })
    await view.select(WINDOW, '30d')
    await view.press({ type: 'Link', text: 'Open in Archon console' })
    await view.select({ type: 'Tabs', label: 'Metrics views' }, 'overview')
    await view.press({ type: 'Link', text: 'Open in Archon console' })
    assert.deepEqual(view.host.callsOf('shell.openExternal'), [
      { url: 'http://127.0.0.1:3090/console/p/cb%2Fweb%201/metrics/details?window=30d' },
      { url: 'http://127.0.0.1:3090/console/p/cb%2Fweb%201/metrics?window=30d' }
    ])
    clean(view)
  })

  test('under "All projects" the console link opens the metrics of every project', async () => {
    const view = await mountMetrics(() => sampleReport(), { scope: () => ({ kind: 'remote' }) })
    await view.press({ type: 'Link', text: 'Open in Archon console' })
    assert.deepEqual(view.host.callsOf('shell.openExternal'), [{ url: 'http://127.0.0.1:3090/console/metrics/details?window=7d' }])
    assert.deepEqual(sent(view), [{}])
    clean(view)
  })

  test('Overview is left for a later version and builds no cards', async () => {
    const view = await mountMetrics(() => sampleReport())
    await view.select({ type: 'Tabs', label: 'Metrics views' }, 'overview')
    assert.equal(view.find({ type: 'Table' }), null)
    assert.equal(view.find({ type: 'Card' }), null)
    clean(view)
  })
})
