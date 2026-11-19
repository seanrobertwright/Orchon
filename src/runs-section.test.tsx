// The frame seam for the panel: src/panel.tsx mounted on a scripted worker that is connected and
// answers the runs table. These tests cover what the Runs section draws and which requests it sends.
import { afterEach, assert, describe, hostError, mockHost, mount, test, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { connected, notRunning } from '../scripts/connection-samples.ts'
import { answeringRuns, busyRuns, noRuns, sampleRun } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { RunsRequest, RunsView } from './runs-view'

const TABLE = { type: 'Table', label: 'Runs' }
const FILTER = { type: 'Select', label: 'Status' }
const REFRESH = { type: 'IconButton', label: 'Refresh runs' }

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

async function mountWith(runs: RunsView | ((request: RunsRequest) => RunsView), section?: string): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answeringRuns(runs)),
    ...(section === undefined ? {} : { persisted: { workspace: { section } } })
  })
  return panel
}

/** Every runs request the panel sent, in order. */
function runsRequests(view: TestPanel): unknown[] {
  return view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'runs.read')
    .map((params) => (params as { input: unknown }).input)
}

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

const busy = (request: RunsRequest): RunsView => busyRuns(120, request)

describe('the Runs section', () => {
  test('asks the worker for the newest 25 runs of every status once connected', async () => {
    const view = await mountWith(busy)
    assert.deepEqual(runsRequests(view), [{ status: 'all', rows: 25 }])
    assert.deepEqual(view.rowsOf(TABLE).length, 25)
    clean(view)
  })

  test('shows, top to bottom, the filter row, the table, the count line and the preview', async () => {
    const view = await mountWith(busy)
    await view.selectRows(TABLE, ['run-1'])
    assert.deepEqual(order(view, ['Select', 'IconButton', 'Table', 'Text', 'Card']).filter((type, index, all) => all.indexOf(type) === index), [
      'Select',
      'IconButton',
      'Table',
      'Text',
      'Card'
    ])
    clean(view)
  })

  test('the status select lists every status with its count, in a labelled select', async () => {
    const view = await mountWith(busy)
    const select = view.find(FILTER)
    assert.ok(select)
    assert.deepEqual(select.props.options, [
      { value: 'all', label: 'All (120)' },
      // This answer carries no snapshot of runs that need you, so that option has no count.
      { value: 'needs-you', label: 'Needs you' },
      { value: 'running', label: 'Running (18)' },
      { value: 'paused', label: 'Paused (17)' },
      { value: 'pending', label: 'Queued (17)' },
      { value: 'failed', label: 'Failed (17)' },
      { value: 'completed', label: 'Completed (34)' },
      { value: 'cancelled', label: 'Cancelled (17)' }
    ])
    assert.equal(view.valueOf(FILTER), 'all')
  })

  test('choosing a status asks for that status from the first row again', async () => {
    const view = await mountWith(busy)
    await view.loadMore(TABLE)
    await view.select(FILTER, 'failed')
    assert.deepEqual(runsRequests(view).at(-1), { status: 'failed', rows: 25 })
    assert.equal(view.rowsOf(TABLE).length, 17)
    assert.equal(view.find({ type: 'Text', text: '17 of 17 loaded.' })?.text, '17 of 17 loaded.')
  })

  test('the refresh button has a name and asks again at once', async () => {
    const view = await mountWith(busy)
    await view.press(REFRESH)
    await view.press(REFRESH)
    assert.deepEqual(runsRequests(view), [
      { status: 'all', rows: 25 },
      { status: 'all', rows: 25 },
      { status: 'all', rows: 25 }
    ])
  })

  test('columns appear as the panel widens: Run and Started always, Status from 360 px, Project and Ran for from 480 px', async () => {
    // With no workspace focused the section shows all projects, so the table names each run's project.
    const view = await mountWith(busy)
    assert.deepEqual(view.columnsOf(TABLE, { width: 220 }), ['run', 'started'])
    assert.deepEqual(view.columnsOf(TABLE, { width: 360 }), ['run', 'status', 'started'])
    assert.deepEqual(view.columnsOf(TABLE, { width: 480 }), ['run', 'status', 'started', 'project', 'ranFor'])
  })

  test('a row is the glyph and the workflow name, the status as a glyph and a word, and its times', async () => {
    const view = await mountWith({ ...noRuns, total: 3, counts: { ...noRuns.counts, all: 3 }, rows: [sampleRun(0, 'running'), sampleRun(1, 'failed'), sampleRun(2, 'pending')] })
    const table = view.find(TABLE)
    const rows = table?.props.rows as { key: string; cells: Record<string, unknown> }[]
    assert.deepEqual(rows[0], {
      key: 'run-0',
      cells: {
        run: '● workflow-0',
        status: '● Running',
        started: { type: 'relative', at: sampleRun(0).startedAt, format: 'short' },
        project: 'acme/web',
        ranFor: { type: 'relative', at: sampleRun(0).startedAt, format: 'duration' }
      }
    })
    assert.deepEqual(rows[1]?.cells, {
      run: '✕ workflow-1',
      status: '✕ Failed',
      started: { type: 'relative', at: sampleRun(1).startedAt, format: 'short' },
      project: 'acme/api',
      ranFor: '1m 15s'
    })
    assert.equal(rows[2]?.cells['status'], '○ Queued')
    assert.equal(table?.props.selectionMode, 'single')
  })

  test('selecting a run shows its read-only preview', async () => {
    const view = await mountWith(busy)
    assert.equal(view.findAll({ type: 'Card' }).length, 0)
    await view.selectRows(TABLE, ['run-3'])
    const preview = view.find({ type: 'Card' })
    assert.equal(preview?.props.title, 'workflow-3')
    assert.match(preview?.text ?? '', /Launch message of run 3\./)
    assert.equal(view.find({ type: 'Badge' })?.text, 'Failed')
    const facts = view.find({ type: 'KeyValue' })?.props.items as { label: string; value: unknown }[]
    assert.deepEqual(
      facts.map((item) => [item.label, item.value]),
      [
        ['Project', 'acme/api'],
        ['Worktree', '/home/ada/.archon/worktrees/run-3']
      ]
    )
    assert.ok(view.find({ type: 'RelativeTime' }))
    assert.equal(view.findAll({ type: 'Button' }).filter((button) => button.text === 'Open run').length, 1)
    clean(view)
  })

  test('loads 25 more rows as the person nears the end, in one request for rows 0 to N', async () => {
    const view = await mountWith(busy)
    assert.equal(view.find(TABLE)?.props.hasMore, true)
    await view.loadMore(TABLE)
    assert.deepEqual(runsRequests(view).at(-1), { status: 'all', rows: 50 })
    assert.equal(view.rowsOf(TABLE).length, 50)
    assert.ok(view.find({ type: 'Text', text: '50 of 120 loaded.' }))
  })

  test('stops at 500 rows, with a line pointing to the filter or the console', async () => {
    const view = await mountWith((request) => busyRuns(700, request))
    for (let step = 0; step < 19; step += 1) await view.loadMore(TABLE)
    assert.deepEqual(runsRequests(view).at(-1), { status: 'all', rows: 500 })
    assert.equal(view.rowsOf(TABLE).length, 500)
    assert.equal(view.find(TABLE)?.props.hasMore, false)
    assert.ok(
      view.find({
        type: 'Text',
        text: "Showing the newest 500 of 700 runs. Choose a status to narrow the list, or open Archon's console for the rest."
      })
    )
  })

  test('says how many runs could not be read', async () => {
    const view = await mountWith((request) => busyRuns(10, request, 3))
    assert.ok(view.find({ type: 'Text', text: '3 runs could not be read and are not shown.' }))
    clean(view)
  })

  test('says so for one run that could not be read', async () => {
    const view = await mountWith((request) => busyRuns(10, request, 1))
    assert.ok(view.find({ type: 'Text', text: '1 run could not be read and is not shown.' }))
  })

  test('with no runs shows "No runs yet"', async () => {
    const view = await mountWith(noRuns)
    assert.equal(view.find({ type: 'EmptyState' })?.label, 'No runs yet')
    assert.equal(view.findAll(TABLE).length, 0)
    clean(view)
  })

  test('"Open in Archon console" opens the runs page of the confirmed base URL in the browser', async () => {
    const view = await mountWith(busy)
    await view.press({ type: 'Link', text: 'Open in Archon console' })
    assert.deepEqual(view.host.callsOf('shell.openExternal'), [{ url: `${connected.baseUrl}/console` }])
    clean(view)
  })

  test('the console link is there with no runs too', async () => {
    const view = await mountWith(noRuns)
    await view.press({ type: 'Link', text: 'Open in Archon console' })
    assert.deepEqual(view.host.callsOf('shell.openExternal'), [{ url: `${connected.baseUrl}/console` }])
  })

  test('a failed read with nothing loaded shows the error in place of the table, with Try again', async () => {
    let fail = true
    const view = await mountWith((request) =>
      fail ? { kind: 'failed', message: 'Archon answered with an error (500).' } : busyRuns(5, request)
    )
    assert.equal(view.findAll(TABLE).length, 0)
    assert.ok(view.find({ type: 'Callout', text: /Archon answered with an error \(500\)\./ }))
    fail = false
    await view.press({ type: 'Button', text: 'Try again' })
    assert.equal(view.rowsOf(TABLE).length, 5)
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
  })

  test('a failed read keeps the rows on screen under one warning line', async () => {
    let fail = false
    const view = await mountWith((request) =>
      fail ? { kind: 'failed', message: 'Archon did not answer within 10 seconds.' } : busyRuns(5, request)
    )
    fail = true
    await view.press(REFRESH)
    assert.equal(view.rowsOf(TABLE).length, 5)
    const warning = view.find({ type: 'Callout' })
    assert.equal(warning?.props.tone, 'warning')
    assert.match(warning?.text ?? '', /^Archon did not answer within 10 seconds\. Last good answer at \S+/)
    assert.ok(view.find({ type: 'Button', text: 'Try again' }))
  })

  test('a worker that does not answer keeps what is loaded', async () => {
    let fail = false
    panel = await mount(panelModule, {
      host: mockHost({
        requests: {
          ...answeringRuns(busy).requests,
          'runs.read': (request: RunsRequest) => {
            if (fail) throw hostError('unavailable')
            return { connection: connected, runs: busy(request) }
          }
        }
      })
    })
    fail = true
    await panel.press(REFRESH)
    assert.equal(panel.rowsOf(TABLE).length, 25)
    assert.match(panel.find({ type: 'Callout' })?.text ?? '', /Orchon's background process is not answering\./)
  })

  test('reopens on Runs and asks again when the person comes back to it', async () => {
    const view = await mountWith(busy)
    await view.select({ label: 'Orchon sections' }, 'chat')
    await view.select({ label: 'Orchon sections' }, 'runs')
    assert.equal(runsRequests(view).length, 2)
    assert.equal(view.persisted.workspace.section, 'runs')
  })

  test('asks nothing while not connected, and reads the runs once connected', async () => {
    panel = await mount(panelModule, { host: mockHost(answeringRuns(busy, notRunning)) })
    assert.deepEqual(runsRequests(panel), [])
    assert.match(panel.find({ type: 'EmptyState' })?.label ?? '', /^Archon is not running\./)
    await panel.post('connection.changed', { ...connected, since: notRunning.since + 1 })
    assert.deepEqual(runsRequests(panel), [{ status: 'all', rows: 25 }])
    assert.equal(panel.rowsOf(TABLE).length, 25)
  })

  test('asks nothing while another section is showing', async () => {
    const view = await mountWith(busy, 'settings')
    assert.deepEqual(runsRequests(view), [])
  })
})
