// The frame seam for the refusals and the packs whose card declarations could not be read:
// src/panel.tsx mounted on a scripted worker that answers the metrics read, the scope, the runs
// table and run detail. These tests cover the Overview's callouts, the Details group of refusals,
// the caps and the link that opens a refused run's detail in the panel.
//
// The samples are the recorded refusal and unreadable pack of the spend recording, which is
// SYNTHETIC: the recorder's own pack made them up.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answeringMetrics, REPORT_END, sampleReport } from '../scripts/metrics-samples.ts'
import { RECORDED_REFUSAL, RECORDED_UNREADABLE, REFUSED_RUN } from '../scripts/refusals-samples.ts'
import { connectedWithMetrics } from '../scripts/connection-samples.ts'
import { sampleDetail } from '../scripts/runs-samples.ts'
import type { MetricsView, RefusalRow } from './metrics-view'
import * as panelModule from './panel'
import type { UnreadablePack } from './refusals-view'
import type { RunDetailRequest } from './run-detail-view'

let panel: TestPanel | undefined
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: REPORT_END })
})
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

type Listed = { refused?: RefusalRow[]; refusedTotal?: number; unreadablePacks?: UnreadablePack[]; moreUnreadablePacks?: number }

/** The sample report with the recorded refusal and unreadable pack, or the lists given. */
function reportWith(listed: Listed = {}): MetricsView {
  const refused = listed.refused ?? [RECORDED_REFUSAL]
  return {
    ...sampleReport(),
    refused,
    refusedTotal: listed.refusedTotal ?? refused.length,
    unreadablePacks: listed.unreadablePacks ?? [RECORDED_UNREADABLE],
    moreUnreadablePacks: listed.moreUnreadablePacks ?? 0
  }
}

async function mountMetrics(view: MetricsView, tab: 'overview' | 'details' = 'overview'): Promise<TestPanel> {
  const base = answeringMetrics(() => view)
  panel = await mount(panelModule, {
    host: mockHost({
      ...base,
      requests: {
        ...base.requests,
        'run.read': (request: RunDetailRequest) => ({
          connection: connectedWithMetrics,
          run: { kind: 'ready', detail: sampleDetail(1, { id: request.runId, workflow: 'orchon-recorder-synthetic-metrics' }) }
        })
      }
    }),
    persisted: { workspace: { section: 'metrics', metricsTab: tab } }
  })
  return panel
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

const TABS = { type: 'Tabs', label: 'Metrics views' }

describe('Overview', () => {
  test('a danger callout with the number of refused outputs and a "Details" link that opens Details', async () => {
    const view = await mountMetrics(reportWith({ refusedTotal: 3 }))
    const callout = view.findAll({ type: 'Callout' }).find((each) => each.props.tone === 'danger')
    assert.ok(callout, 'No danger callout.')
    assert.ok(view.findAll({ type: 'Text' }).some((text) => text.path.startsWith(callout.path) && text.text === '3 metric outputs refused'))
    const link = view.findAll({ type: 'Link' }).find((each) => each.path.startsWith(callout.path))
    assert.ok(link)
    assert.equal(link.text, 'Details')
    await view.press(link)
    assert.equal(view.valueOf(TABS), 'details')
    clean(view)
  })

  test("one warning callout per pack that could not be read, naming the pack, its source and Archon's message", async () => {
    const view = await mountMetrics(reportWith())
    const warnings = view.findAll({ type: 'Callout' }).filter((each) => each.props.tone === 'warning')
    assert.deepEqual(
      warnings.map((each) => each.text),
      [
        'The project pack orchon-synthetic-unreadable declares cards that could not be read: .shared/metric-views.json is invalid: cards: Too small: expected array to have >=1 items'
      ]
    )
    clean(view)
  })

  test(`at most 10 packs, followed by "and N more in Archon's console"; with nothing refused there is no danger callout`, async () => {
    const packs = Array.from({ length: 10 }, (_, at) => ({ ...RECORDED_UNREADABLE, key: `project:pack-${String(at)}`, pack: `pack-${String(at)}` }))
    const view = await mountMetrics(reportWith({ refused: [], unreadablePacks: packs, moreUnreadablePacks: 4 }))
    assert.equal(view.findAll({ type: 'Callout' }).filter((each) => each.props.tone === 'warning').length, 10)
    assert.equal(view.findAll({ type: 'Callout' }).filter((each) => each.props.tone === 'danger').length, 0)
    assert.ok(view.find({ type: 'Text', text: "and 4 more in Archon's console" }))
    clean(view)
  })

  test("a message is drawn as plain text, never as markup", async () => {
    const message = '<b>bold</b> **not bold** [a link](https://example.com)'
    const view = await mountMetrics(reportWith({ unreadablePacks: [{ ...RECORDED_UNREADABLE, message }] }))
    assert.ok(view.find({ type: 'Text', text: `The project pack orchon-synthetic-unreadable declares cards that could not be read: ${message}` }))
    assert.equal(view.findAll({ type: 'Markdown' }).length, 0)
    clean(view)
  })
})

const GROUP = { type: 'Collapsible', label: '1 metric output was refused' }

/** Every request of one name the panel sent, by its input, in order. */
function requests(view: TestPanel, name: string): unknown[] {
  return view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input?: unknown }).input ?? null)
}

/** Elements of one type inside the refusals group. */
function inGroup(view: TestPanel, type: string, label: string | RegExp = GROUP.label) {
  const group = view.find({ type: 'Collapsible', label })
  assert.ok(group, 'No refusals group.')
  return view.findAll({ type }).filter((each) => each.path.startsWith(`${group.path}/`))
}

describe('Details', () => {
  test('the refusals sit in a group above the table, shut until opened', async () => {
    const view = await mountMetrics(reportWith(), 'details')
    const group = view.find(GROUP)
    assert.ok(group, 'No refusals group.')
    assert.notEqual(group.props.defaultOpen, true)
    assert.notEqual(group.props.open, true)
    assert.equal(inGroup(view, 'Link').length, 0)
    const order = view.findAll({}).map((each) => each.type).filter((type) => type === 'Collapsible' || type === 'Table')
    assert.deepEqual(order, ['Collapsible', 'Table'])
    clean(view)
  })

  test("opened, the recorded refusal reads its workflow and node, the console's words and a link to its run", async () => {
    const view = await mountMetrics(reportWith(), 'details')
    await view.toggle(GROUP)
    assert.deepEqual(
      inGroup(view, 'Text').map((each) => each.text),
      ['orchon-recorder-synthetic-metrics/emit', 'offered orchon_synthetic.items_opened as score in ratio, but it is defined as count in items.']
    )
    assert.deepEqual(
      inGroup(view, 'Link').map((each) => each.text),
      ['Open run a877b80b']
    )
    clean(view)
  })

  test("the link opens that run's detail in the Runs section, read by its id whatever the scope switch says", async () => {
    const view = await mountMetrics(reportWith(), 'details')
    await view.toggle(GROUP)
    const [link] = inGroup(view, 'Link')
    assert.ok(link)
    await view.press(link)
    assert.equal(view.valueOf({ label: 'Orchon sections' }), 'runs')
    assert.deepEqual(requests(view, 'run.read').at(0), { runId: REFUSED_RUN, open: true })
    // Run detail is drawn in place of the runs table, though the run is not in the scoped table.
    assert.ok(view.find({ type: 'Button', text: 'Open graph' }))
    clean(view)
  })

  test("at most 20 refusals in Archon's order, followed by \"and N more in Archon's console\"", async () => {
    const refused = Array.from({ length: 20 }, (_, at) => ({ ...RECORDED_REFUSAL, key: `${REFUSED_RUN}/node-${String(at)}`, nodeId: `node-${String(at)}` }))
    const view = await mountMetrics(reportWith({ refused, refusedTotal: 26 }), 'details')
    const label = '26 metric outputs were refused'
    await view.toggle({ type: 'Collapsible', label })
    const texts = inGroup(view, 'Text', label).map((each) => each.text)
    assert.deepEqual(
      texts.filter((text) => text.startsWith('orchon-recorder-synthetic-metrics/')),
      Array.from({ length: 20 }, (_, at) => `orchon-recorder-synthetic-metrics/node-${String(at)}`)
    )
    assert.equal(texts.at(-1), "and 6 more in Archon's console")
    clean(view)
  })

  test('with no records the group still shows over the empty table, and with no refusals there is none', async () => {
    const empty = { ...reportWith(), rows: [] }
    const view = await mountMetrics(empty, 'details')
    assert.ok(view.find(GROUP))
    await view.unmount()
    panel = undefined
    const none = await mountMetrics(reportWith({ refused: [] }), 'details')
    assert.equal(none.findAll({ type: 'Collapsible' }).length, 0)
    clean(none)
  })
})
