// The frame seam for the panel: src/panel.tsx mounted on a scripted worker. These tests cover
// what live updates change in the panel: the refetch a hint starts, the line and the short
// timer while live updates are off, and what a return to Connected does. The frame's timers
// are Node's mocked ones, moved by hand.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { connected } from '../scripts/connection-samples.ts'
import { answeringRuns, busyRuns } from '../scripts/runs-samples.ts'
import type { Connected } from './connection-view'
import * as panelModule from './panel'
import type { RunsRequest, RunsView } from './runs-view'

let panel: TestPanel | undefined
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 18, 12) })
})
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

const busy = (request: RunsRequest): RunsView => busyRuns(120, request)

async function mountConnected(state: Connected = connected): Promise<TestPanel> {
  panel = await mount(panelModule, { host: mockHost(answeringRuns(busy, state)) })
  return panel
}

/** How many runs requests the panel has sent. */
const runsReads = (view: TestPanel): number =>
  view.host.callsOf('plugin.request').filter((params) => (params as { name: string }).name === 'runs.read').length

/** The drawn elements a person reads, in order: tabs, texts with their words, and controls. */
function drawnInOrder(view: TestPanel): string[] {
  const seen: string[] = []
  const walk = (node: TreeSnapshot | string | null): void => {
    if (node === null || typeof node === 'string') return
    if (node.type === 'Text') {
      seen.push(`Text ${(node.children ?? []).filter((child) => typeof child === 'string').join('')}`)
    } else if (['Tabs', 'Select', 'IconButton', 'Table'].includes(node.type)) {
      seen.push(node.type)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(view.tree())
  return seen
}

/** Moves the frame's clock and lets what fell due run. */
async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

describe('live updates in the panel', () => {
  test('the runs table refetches on a workflow_status hint, no sooner than 2 seconds after the last read', async () => {
    const view = await mountConnected()
    assert.equal(runsReads(view), 1)
    await view.post('runs.changed', { types: ['workflow_status'], runs: ['run-1'] })
    assert.equal(runsReads(view), 1)
    await advance(view, 2_000)
    assert.equal(runsReads(view), 2)
  })

  test('a dag_node hint, or a hint while another section shows, reads nothing', async () => {
    const view = await mountConnected()
    await view.post('runs.changed', { types: ['dag_node'], runs: ['run-1'] })
    await advance(view, 5_000)
    assert.equal(runsReads(view), 1)
    await view.select({ label: 'Orchon sections' }, 'chat')
    await view.post('runs.changed', { types: ['workflow_status'], runs: 'many' })
    await advance(view, 5_000)
    assert.equal(runsReads(view), 1)
  })

  test('while live, says nothing about it and refetches every 30 seconds', async () => {
    const view = await mountConnected()
    assert.equal(view.findAll({ text: /Live updates are off/ }).length, 0)
    await advance(view, 29_999)
    assert.equal(runsReads(view), 1)
    await advance(view, 1)
    assert.equal(runsReads(view), 2)
  })

  test('while live updates are off, says so under the section bar and refetches every 5 seconds', async () => {
    const view = await mountConnected({ ...connected, live: false })
    const line = view.find({ type: 'Text', text: 'Live updates are off. Refreshing every 5 seconds.' })
    assert.ok(line)
    // It is the first thing under the section bar, above the filter row, and nothing is disabled.
    assert.deepEqual(drawnInOrder(view).slice(0, 3), [
      'Tabs',
      'Text Live updates are off. Refreshing every 5 seconds.',
      'Select'
    ])
    assert.deepEqual(
      view.findAll({ type: 'IconButton' }).map((button) => [button.label, button.disabled]),
      [['Refresh runs', false]]
    )
    assert.equal(view.find({ type: 'Select', label: 'Status' })?.disabled, false)
    await advance(view, 4_999)
    assert.equal(runsReads(view), 1)
    await advance(view, 1)
    assert.equal(runsReads(view), 2)
    await advance(view, 5_000)
    assert.equal(runsReads(view), 3)
  })

  test('clears its timers when the panel closes: nothing is read after it', async () => {
    const view = await mountConnected({ ...connected, live: false })
    await view.post('runs.changed', { types: ['workflow_status'], runs: ['run-1'] })
    const reads = runsReads(view)
    await view.unmount()
    panel = undefined
    mock.timers.tick(120_000)
    await Promise.resolve()
    assert.equal(runsReads(view), reads)
  })

  test('switches to the short timer when the worker posts that live updates went off, and back', async () => {
    const view = await mountConnected()
    await view.post('connection.changed', { ...connected, since: connected.since + 1, live: false })
    assert.ok(view.find({ type: 'Text', text: 'Live updates are off. Refreshing every 5 seconds.' }))
    const before = runsReads(view)
    await advance(view, 5_000)
    assert.equal(runsReads(view) > before, true)
    await view.post('connection.changed', { ...connected, since: connected.since + 2, live: true })
    assert.equal(view.findAll({ text: /Live updates are off/ }).length, 0)
    await advance(view, 5_000)
    const settledAt = runsReads(view)
    await advance(view, 29_999)
    assert.equal(runsReads(view), settledAt)
  })

  test('a return to Connected refetches what shows; a changed store id first clears what the panel held', async () => {
    let store = 'store-a'
    let total = 120
    panel = await mount(panelModule, {
      host: mockHost({
        requests: {
          ...answeringRuns(busy).requests,
          'connection.read': () => ({ connection: { ...connected, storeId: store } }),
          'runs.read': (request: RunsRequest) => ({ connection: { ...connected, storeId: store }, runs: busyRuns(total, request) })
        }
      })
    })
    const view = panel
    await view.select({ type: 'Select', label: 'Status' }, 'failed')
    await view.selectRows({ type: 'Table', label: 'Runs' }, ['run-3'])
    assert.ok(view.find({ type: 'Card' }))
    const searchingAgain = { kind: 'searching' as const, since: connected.since + 1, settings: connected.settings }
    await view.post('connection.changed', searchingAgain)

    // The same store: the filter and the selection survive, and the table is read again.
    const reads = runsReads(view)
    await view.post('connection.changed', { ...connected, storeId: store, since: connected.since + 2 })
    assert.equal(runsReads(view), reads + 1)
    assert.equal(view.valueOf({ type: 'Select', label: 'Status' }), 'failed')
    assert.ok(view.find({ type: 'Card' }))

    // Another store: what was held is cleared before the table is read again.
    await view.post('connection.changed', { ...searchingAgain, since: connected.since + 3 })
    store = 'store-b'
    total = 0
    await view.post('connection.changed', { ...connected, storeId: store, since: connected.since + 4 })
    assert.equal(runsReads(view), reads + 2)
    assert.equal(view.valueOf({ type: 'Select', label: 'Status' }), 'all')
    assert.equal(view.findAll({ type: 'Card' }).length, 0)
    assert.equal(view.find({ type: 'EmptyState' })?.label, 'No runs yet')
  })
})
