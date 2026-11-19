// The frame seam for run detail: src/panel.tsx mounted on a scripted worker that answers the runs
// table and run detail. These tests cover what run detail draws and which requests it sends.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { RunDetail, RunDetailRequest, RunDetailView } from './run-detail-view'
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


const STEPS = { type: 'Tree', label: 'Steps' }

describe('the step tree', () => {
  test('a row is the glyph, the name, the shortest duration and "ran N times"; a loop is an open branch holding its inner steps', async () => {
    const view = await openOn()
    assert.deepEqual(view.find(STEPS)?.props.items, [
      { key: 'step:plan', label: '✓ plan', description: '1m 35s · ran 1 time' },
      {
        key: 'step:implement',
        label: '‖ implement',
        description: 'ran 1 time',
        children: [
          { key: 'step:implement.build', label: '✓ build', description: '12s · ran 3 times' },
          { key: 'step:implement.test', label: '‖ test', description: 'ran 2 times' }
        ]
      },
      {
        key: 'not-reached',
        label: 'Not reached (2)',
        children: [
          { key: 'step:review', label: '○ review' },
          { key: 'step:ship', label: '○ ship' }
        ]
      }
    ])
    assert.deepEqual(view.expandedOf(STEPS), ['step:implement'])
    clean(view)
  })

  test('the Not reached branch opens and shuts as the person says, and a loop shuts too', async () => {
    const view = await openOn()
    await view.expand(STEPS, 'not-reached')
    await view.collapse(STEPS, 'step:implement')
    assert.deepEqual(view.expandedOf(STEPS), ['not-reached'])
  })

  test('the list stops at 500 rows with a line saying how many are not shown', async () => {
    const steps = Array.from({ length: 500 }, (_, index) => ({
      id: `step-${String(index)}`,
      name: `step-${String(index)}`,
      kind: 'bash',
      state: 'completed' as const,
      loop: null,
      starts: 1,
      durationMs: 1_000,
      reached: true
    }))
    const view = await openOn(() => ({ kind: 'ready', detail: sampleDetail(1, { steps, stepCount: 612 }) }))
    assert.equal((view.find(STEPS)?.props.items as unknown[]).length, 500)
    assert.ok(view.find({ type: 'Text', text: 'The list stops at 500 steps: 112 steps are not shown.' }))
    assert.deepEqual(view.find(SHOW)?.props.options, [
      { value: 'steps', label: 'Steps (612)' },
      { value: 'artifacts', label: 'Artifacts' }
    ])
  })

  test('selecting a step shows one line under the tree: its badge, name, kind, its loop and "ran N times"', async () => {
    const view = await openOn()
    await view.selectItem(STEPS, 'step:implement.build')
    const line = view.find({ type: 'Text', text: 'build · bash · inner step of implement · ran 3 times' })
    assert.ok(line)
    assert.equal(view.find({ type: 'Badge', text: 'Completed' })?.text, 'Completed')
    await view.selectItem(STEPS, 'step:plan')
    assert.ok(view.find({ type: 'Text', text: 'plan · prompt · ran 1 time' }))
    assert.equal(view.find({ type: 'Text', text: /inner step of/ }), null)
  })

  test('the Not reached branch is not a step: selecting it shows no line', async () => {
    const view = await openOn()
    await view.selectItem(STEPS, 'not-reached')
    assert.equal(view.findAll({ type: 'Badge' }).length, 1)
  })

  test('Artifacts takes the place of the tree', async () => {
    const view = await openOn()
    await view.select(SHOW, 'artifacts')
    assert.equal(view.find(STEPS), null)
    assert.ok(view.find({ type: 'Input', label: 'Filter artifacts by name' }))
  })

  test('opening another run shows it from the start: folds shut, Steps chosen, nothing selected', async () => {
    const view = await mountWith()
    await view.activateRow(TABLE, 'run-1')
    await view.toggle(FACTS)
    await view.selectItem(STEPS, 'step:plan')
    await view.select(SHOW, 'artifacts')
    await view.press(BACK)
    await view.activateRow(TABLE, 'run-2')
    assert.equal(view.find(FACTS)?.props.open, false)
    assert.equal(view.valueOf(SHOW), 'steps')
    assert.equal(view.findAll({ type: 'Badge' }).length, 1)
  })
})

/** A wait's time, as the panel writes it in the tests' locale. Noon UTC is the same day everywhere. */
const UNTIL = Date.UTC(2026, 10, 19, 12, 0, 0)
const waitingOn = (waiting: RunDetail['waiting']) => (): RunDetailView => ({ kind: 'ready', detail: sampleDetail(1, { waiting }) })

describe('what a run waits for', () => {
  test('a time wait reads "Waiting until" and the time, above the folds', async () => {
    const view = await openOn(waitingOn({ kind: 'time', until: UNTIL }))
    const line = view.find({ type: 'Text', text: /^Waiting until / })
    assert.match(line?.text ?? '', /^Waiting until Nov 19, 2026, \d{2}:\d{2} [AP]M\.$/)
    assert.deepEqual(
      order(view, ['Callout', 'Collapsible']).filter((type, index, all) => all.indexOf(type) === index),
      ['Callout', 'Collapsible']
    )
  })

  test('an event wait names the event and its latest time', async () => {
    const view = await openOn(waitingOn({ kind: 'event', event: 'deploy-done', until: UNTIL }))
    assert.match(
      view.find({ type: 'Text', text: /^Waiting for the event/ })?.text ?? '',
      /^Waiting for the event deploy-done, until Nov 19, 2026, \d{2}:\d{2} [AP]M at the latest\.$/
    )
  })

  test('a time that did not parse is dropped and the sentence kept', async () => {
    const timed = await openOn(waitingOn({ kind: 'time', until: null }))
    assert.ok(timed.find({ type: 'Text', text: 'Waiting until a set time.' }))
    await timed.unmount()
    panel = undefined
    const evented = await openOn(waitingOn({ kind: 'event', event: 'deploy-done', until: null }))
    assert.ok(evented.find({ type: 'Text', text: 'Waiting for the event deploy-done.' }))
  })

  test('a parent waiting on sub-runs lists them, each with its workflow and state, then "and N more"', async () => {
    const children = [
      { id: 'run-7', workflow: 'child-flow', status: 'running' as const },
      { id: 'run-8', workflow: null, status: null }
    ]
    const view = await openOn(waitingOn({ kind: 'children', children, more: 5 }))
    const rows = view.findAll({ type: 'ListItem' })
    assert.deepEqual(
      rows.map((row) => [row.label, row.props.description]),
      [
        ['● child-flow', 'Running'],
        ['run-8', 'State not known']
      ]
    )
    assert.ok(view.find({ type: 'Text', text: 'and 5 more' }))
    clean(view)
  })

  test('a sub-run row opens that run', async () => {
    const children = [{ id: 'run-7', workflow: 'workflow-7', status: 'running' as const }]
    const detail = (request: RunDetailRequest): RunDetailView =>
      request.runId === 'run-1'
        ? { kind: 'ready', detail: sampleDetail(1, { waiting: { kind: 'children', children, more: 0 } }) }
        : readyDetail(request)
    const view = await openOn(detail)
    await view.press({ type: 'ListItem', label: '● workflow-7' })
    assert.deepEqual(requests(view, 'run.read').at(-1), { runId: 'run-7', open: true })
    assert.ok(view.find({ type: 'Text', text: 'workflow-7' }))
  })
})

describe('a run that is gone', () => {
  test('shows "This run no longer exists." with the way back', async () => {
    const view = await openOn(() => ({ kind: 'gone' }))
    assert.ok(view.find({ type: 'Text', text: 'This run no longer exists.' }))
    assert.equal(view.find(STEPS), null)
    await view.press(BACK)
    assert.ok(view.find(TABLE))
    clean(view)
  })
})
