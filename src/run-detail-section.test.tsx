// The frame seam for run detail: src/panel.tsx mounted on a scripted worker that answers the runs
// table and run detail. These tests cover what run detail draws and which requests it sends.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { RunDetailRequest, RunDetailView } from './run-detail-view'
import type { RunsRequest, RunsView } from './runs-view'

const TABLE = { type: 'Table', label: 'Runs' }
const BACK = { type: 'Button', text: 'Runs' }

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const busy = (request: RunsRequest): RunsView => busyRuns(40, request)
const readyDetail = (request: RunDetailRequest): RunDetailView => ({ kind: 'ready', detail: sampleDetail(Number(request.runId.slice(4))) })

async function mountWith(detail: (request: RunDetailRequest) => RunDetailView = readyDetail, persisted?: Record<string, unknown>): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answeringRun(busy, detail)),
    ...(persisted === undefined ? {} : { persisted: { workspace: persisted } })
  })
  return panel
}

/** Every request of one name the panel sent, in order. */
function requests(view: TestPanel, name: string): unknown[] {
  return view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
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

describe('opening a run', () => {
  test('Enter on a row replaces the table with run detail, which asks for the run as just opened', async () => {
    const view = await mountWith()
    await view.activateRow(TABLE, 'run-1')
    assert.equal(view.find(TABLE), null)
    assert.deepEqual(requests(view, 'run.read'), [{ runId: 'run-1', open: true }])
    assert.ok(view.find(BACK))
    assert.ok(view.find({ type: 'Text', text: 'workflow-1' }))
    assert.equal(view.find({ type: 'Badge' })?.text, 'Paused')
    clean(view)
  })

  test('Open run in the preview opens the selected run', async () => {
    const view = await mountWith()
    await view.selectRows(TABLE, ['run-3'])
    await view.press({ type: 'Button', text: 'Open run' })
    assert.equal(view.find(TABLE), null)
    assert.deepEqual(requests(view, 'run.read'), [{ runId: 'run-3', open: true }])
    assert.ok(view.find({ type: 'Text', text: 'workflow-3' }))
  })

  test('the back control returns to the table and reads it again', async () => {
    const view = await mountWith()
    await view.activateRow(TABLE, 'run-1')
    const before = requests(view, 'runs.read').length
    await view.press(BACK)
    assert.ok(view.find(TABLE))
    assert.equal(requests(view, 'runs.read').length, before + 1)
    assert.equal(view.find({ type: 'Text', text: 'workflow-1' }), null)
    clean(view)
  })

  test('the panel reopens on the run last shown, asking for it as just opened', async () => {
    const view = await mountWith(readyDetail, { section: 'runs', openRun: 'run-2' })
    assert.equal(view.find(TABLE), null)
    assert.deepEqual(requests(view, 'run.read'), [{ runId: 'run-2', open: true }])
    assert.deepEqual(requests(view, 'runs.read'), [])
    assert.ok(view.find({ type: 'Text', text: 'workflow-2' }))
  })
})

const openOn = async (detail: (request: RunDetailRequest) => RunDetailView = readyDetail): Promise<TestPanel> =>
  mountWith(detail, { section: 'runs', openRun: 'run-1' })

const FACTS = { type: 'Collapsible', label: 'Run facts' }
const MESSAGE = { type: 'Collapsible', label: 'Launch message' }
const SHOW = { type: 'Select', label: 'Show' }

describe('run detail, top to bottom', () => {
  test('the header row, the Run facts and Launch message folds, then the Steps and Artifacts select and the tree', async () => {
    const view = await openOn()
    assert.deepEqual(
      order(view, ['Button', 'Badge', 'Collapsible', 'Select', 'Tree']).filter((type, index, all) => all.indexOf(type) === index),
      ['Button', 'Badge', 'Collapsible', 'Select', 'Tree']
    )
    const folds = view.findAll({ type: 'Collapsible' }).map((fold) => fold.props.title)
    assert.deepEqual(folds, ['Run facts', 'Launch message'])
    clean(view)
  })

  test('Run facts is shut and summarised by duration, cost and project', async () => {
    const ended = (): RunDetailView => ({ kind: 'ready', detail: sampleDetail(4, { id: 'run-1' }) })
    const view = await openOn(ended)
    const fold = view.find(FACTS)
    assert.equal(fold?.props.open ?? fold?.props.defaultOpen ?? false, false)
    assert.equal(fold?.props.description, '1m 15s · $0.42 · acme/web')
  })

  test('a run with no cost or project says so in the summary, and a live run leaves the duration out', async () => {
    const view = await openOn(() => ({ kind: 'ready', detail: sampleDetail(1, { costUsd: null, project: null }) }))
    assert.equal(view.find(FACTS)?.props.description, 'No cost reported · No project')
  })

  test('Launch message is shut, plain text, and says when it was cut at 2,000 characters', async () => {
    const message = 'm'.repeat(2_000)
    const view = await openOn(() => ({ kind: 'ready', detail: sampleDetail(1, { message, messageCut: true }) }))
    const fold = view.find(MESSAGE)
    assert.equal(fold?.props.open ?? fold?.props.defaultOpen ?? false, false)
    await view.toggle(MESSAGE)
    assert.ok(view.find({ type: 'Text', text: message }))
    assert.ok(view.find({ type: 'Text', text: 'The launch message is cut at 2,000 characters.' }))
    assert.equal(view.findAll({ type: 'Markdown' }).length, 0)
  })

  test('the select offers Steps with their count and Artifacts, Steps first', async () => {
    const view = await openOn()
    assert.deepEqual(view.find(SHOW)?.props.options, [
      { value: 'steps', label: 'Steps (6)' },
      { value: 'artifacts', label: 'Artifacts' }
    ])
    assert.equal(view.valueOf(SHOW), 'steps')
  })
})

