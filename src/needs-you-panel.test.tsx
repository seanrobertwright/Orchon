// The frame seam for the runs that need you: src/panel.tsx mounted on a scripted worker that is
// connected and answers the runs table with the snapshot's callout. These tests cover the
// "runs need you" callout, the "Needs you" filter, the preview's question and the press of
// "Orchon: Show runs", and which requests the panel sends.
import { mock } from 'node:test'
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { answeringRuns, connected } from '../scripts/connection-samples.ts'
import { busyRuns, sampleRun } from '../scripts/runs-samples.ts'
import type { ShowRuns } from './hint-view'
import * as panelModule from './panel'
import type { NeedsYouView, RunRow, RunsRequest, RunsView } from './runs-view'

const TABLE = { type: 'Table', label: 'Runs' }
const FILTER = { type: 'Select', label: 'Status' }

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

/** The Nth sample run waiting at a gate with its own question. */
const waitingRun = (index: number): RunRow => ({
  ...sampleRun(index, 'paused'),
  waiting: { kind: 'gate', question: `Approve the plan of run ${String(index)}?` }
})

/** The callout's view of `total` waiting runs and `unreadable` that could not be read: the first ten rows, as the worker sends them. */
function needing(total: number, unreadable = 0): NeedsYouView {
  const rows = Array.from({ length: Math.min(total, 10) }, (_, index) => waitingRun(index))
  return { kind: 'ready', total, rows, unreadable }
}

/** A busy table of 40 runs, with `needsYou` beside it, and the snapshot's rows for the "Needs you" filter. */
function withNeedsYou(needsYou: NeedsYouView) {
  return (request: RunsRequest): RunsView => {
    const busy = busyRuns(40, request.status === 'needs-you' ? { ...request, status: 'all' } : request)
    if (busy.kind !== 'ready') return busy
    if (request.status === 'needs-you') {
      const rows = needsYou.kind === 'ready' ? needsYou.rows : []
      return { ...busy, total: rows.length, rows, needsYou }
    }
    return { ...busy, needsYou }
  }
}

type Extra = { showRuns?: ShowRuns }

async function mountWith(needsYou: NeedsYouView, options: { section?: string; extra?: Extra; applied?: number } = {}): Promise<TestPanel> {
  const answers = answeringRuns(withNeedsYou(needsYou))
  const workspace: Record<string, unknown> = {}
  if (options.section !== undefined) workspace['section'] = options.section
  if (options.applied !== undefined) workspace['showRunsApplied'] = options.applied
  panel = await mount(panelModule, {
    host: mockHost({ requests: { ...answers.requests, 'connection.read': { connection: connected, ...options.extra } } }),
    persisted: { workspace }
  })
  return panel
}

/** Every runs request the panel sent, in order. */
const runsRequests = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'runs.read')
    .map((params) => (params as { input: unknown }).input)

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/** The types of the drawn elements, in the order a person reads them, keeping only `wanted`. */
function order(view: TestPanel, wanted: readonly string[]): string[] {
  const seen: string[] = []
  const walk = (node: TreeSnapshot | string | null): void => {
    if (node === null || typeof node === 'string') return
    if (wanted.includes(node.type)) seen.push(node.type)
    for (const child of node.children ?? []) walk(child)
  }
  walk(view.tree())
  return seen
}

const callout = (view: TestPanel) => view.find({ type: 'Callout', text: /need(s)? you/ })

describe('the "runs need you" callout', () => {
  test('reads "N runs need you" above the table, a row per run with its workflow, question and project', async () => {
    const view = await mountWith(needing(2))
    const box = callout(view)
    assert.ok(box)
    assert.equal(box.props['title'], '2 runs need you')
    assert.match(box.text, /workflow-0/)
    assert.match(box.text, /Approve the plan of run 0\?/)
    assert.match(box.text, /workflow-1/)
    // No workspace is focused, so the panel shows "All projects" and each row names its project.
    assert.match(box.text, /acme\/web/)
    assert.match(box.text, /acme\/api/)
    // The callout sits between the filter row and the table.
    assert.deepEqual(order(view, ['Select', 'Callout', 'Table']), ['Select', 'Callout', 'Table'])
    clean(view)
  })

  test('one run reads "1 run needs you"', async () => {
    const view = await mountWith(needing(1))
    assert.equal(callout(view)?.props['title'], '1 run needs you')
  })

  test('the question is on one line', async () => {
    const view = await mountWith(needing(1))
    const question = view.find({ type: 'Text', text: 'Approve the plan of run 0?' })
    assert.equal(question?.props['truncate'], true)
  })

  test('is hidden when nothing needs you, and when the count is unavailable', async () => {
    const none = await mountWith(needing(0))
    assert.equal(callout(none), null)
    await none.unmount()
    const unavailable = await mountWith({ kind: 'unavailable' })
    assert.equal(callout(unavailable), null)
  })

  test('says how many waiting runs could not be read, even when no other run needs you', async () => {
    const some = await mountWith(needing(2, 1))
    assert.match(callout(some)?.text ?? '', /1 waiting run could not be read and is not shown\./)
    await panel?.unmount()
    const none = await mountWith(needing(0, 3))
    const box = none.find({ type: 'Callout', text: /could not be read/ })
    assert.equal(box?.props['title'], 'Waiting runs could not be read')
    assert.match(box?.text ?? '', /3 waiting runs could not be read and are not shown\./)
  })

  test('an unreadable run reads "Needs a look in Archon\'s console"', async () => {
    const view = await mountWith({ kind: 'ready', total: 1, rows: [{ ...sampleRun(3, 'paused'), waiting: { kind: 'unreadable' } }], unreadable: 0 })
    assert.match(callout(view)?.text ?? '', /workflow-3/)
    assert.match(callout(view)?.text ?? '', /Needs a look in Archon's console/)
  })

  test('a row opens the run', async () => {
    const view = await mountWith(needing(2))
    await view.press({ type: 'Link', text: 'workflow-1' })
    const reads = view.host
      .callsOf('plugin.request')
      .filter((params) => (params as { name: string }).name === 'run.read')
      .map((params) => (params as { input: unknown }).input)
    assert.equal((reads.at(-1) as { runId?: string } | undefined)?.runId, 'run-1')
  })

  test('shows at most 10 rows, then "and N more", which sets the filter to "Needs you" and hides the callout', async () => {
    const view = await mountWith(needing(14))
    const box = callout(view)
    assert.equal(box?.props['title'], '14 runs need you')
    assert.match(box?.text ?? '', /workflow-9/)
    assert.equal(view.findAll({ type: 'Text', text: /^Approve the plan of run/ }).length, 10)
    await view.press({ type: 'Link', text: 'and 4 more' })
    assert.equal(view.valueOf(FILTER), 'needs-you')
    assert.deepEqual(runsRequests(view).at(-1), { status: 'needs-you', rows: 25 })
    assert.equal(callout(view), null)
    clean(view)
  })
})

describe('the "Needs you" filter', () => {
  test('is the second option, with its count from the snapshot', async () => {
    const view = await mountWith(needing(3))
    const options = view.find(FILTER)?.props['options'] as { value: string; label: string }[]
    assert.deepEqual(options.slice(0, 3), [
      { value: 'all', label: 'All (40)' },
      { value: 'needs-you', label: 'Needs you (3)' },
      { value: 'running', label: 'Running (6)' }
    ])
  })

  test('has no count when the snapshot is unavailable', async () => {
    const view = await mountWith({ kind: 'unavailable' })
    const options = view.find(FILTER)?.props['options'] as { value: string; label: string }[]
    assert.deepEqual(options[1], { value: 'needs-you', label: 'Needs you' })
  })

  test('lists the runs that need you, and its preview shows the question', async () => {
    const view = await mountWith(needing(3))
    await view.select(FILTER, 'needs-you')
    assert.deepEqual(view.rowsOf(TABLE), ['run-0', 'run-1', 'run-2'])
    await view.selectRows(TABLE, ['run-1'])
    const preview = view.find({ type: 'Card', label: 'workflow-1' })
    assert.match(preview?.text ?? '', /Approve the plan of run 1\?/)
    clean(view)
  })
})

describe('a press of "Orchon: Show runs"', () => {
  test('an open panel switches to Runs and sets the "Needs you" filter when runs need you', async () => {
    const view = await mountWith(needing(2), { section: 'settings' })
    await view.post('show-runs', { at: 1_000, needsYou: true })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'runs')
    assert.equal(view.valueOf(FILTER), 'needs-you')
    clean(view)
  })

  test('keeps the filter when nothing needs you', async () => {
    const view = await mountWith(needing(0), { section: 'settings' })
    await view.post('show-runs', { at: 1_000, needsYou: false })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'runs')
    assert.equal(view.valueOf(FILTER), 'all')
  })

  test('a panel that mounts while the worker remembers the press applies it once', async () => {
    const view = await mountWith(needing(2), { section: 'metrics', extra: { showRuns: { at: 5_000, needsYou: true } } })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'runs')
    assert.equal(view.valueOf(FILTER), 'needs-you')
    assert.equal(view.persisted.workspace['showRunsApplied'], 5_000)
    await view.unmount()
    // Mounted again within the minute, the same press is not applied a second time.
    const again = await mountWith(needing(2), { section: 'metrics', extra: { showRuns: { at: 5_000, needsYou: true } }, applied: 5_000 })
    assert.equal(again.valueOf({ type: 'Tabs' }), 'metrics')
  })
})

describe('a change in the snapshot', () => {
  test('reads the table again, no sooner than 2 seconds after the last read, so the callout follows the snapshot', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 18, 12) })
    try {
      const view = await mountWith(needing(1))
      assert.equal(runsRequests(view).length, 1)
      await view.post('needs-you.changed', null)
      assert.equal(runsRequests(view).length, 1)
      mock.timers.tick(2_000)
      await view.settled()
      assert.equal(runsRequests(view).length, 2)
      await view.unmount()
      panel = undefined
    } finally {
      mock.timers.reset()
    }
  })
})
