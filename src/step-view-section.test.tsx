// The frame seam for the step view: src/panel.tsx mounted on a scripted worker that answers the
// runs table, run detail and the step view's requests. These tests cover what the step view draws
// and which requests it sends.
import { mock } from 'node:test'
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected } from '../scripts/connection-samples.ts'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { RunDetailRequest, RunDetailView } from './run-detail-view'
import type { RunsRequest, RunsView } from './runs-view'
import type { ActivityRow, ActivityView, ItemRequest, ItemView, StepAnswer, StepFacts, StepRequest, StepView } from './step-view'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const busy = (request: RunsRequest): RunsView => busyRuns(40, request)
const readyDetail = (request: RunDetailRequest): RunDetailView => ({ kind: 'ready', detail: sampleDetail(Number(request.runId.slice(4))) })

/** The sample run's steps in run detail's order, inner steps included. */
const ORDER = sampleDetail(1).steps

/** A step's facts as the worker would answer them for the sample run. */
function sampleFacts(stepId: string, change: Partial<StepFacts> = {}): StepFacts {
  const index = ORDER.findIndex((step) => step.id === stepId)
  const step = ORDER[index]
  if (step === undefined) throw new Error(`The sample run has no step ${stepId}.`)
  return {
    id: step.id,
    name: step.name,
    kind: step.kind,
    state: step.state,
    runStatus: 'running',
    loop: step.loop,
    starts: step.starts,
    reached: step.reached,
    position: index + 1,
    count: ORDER.length,
    previous: ORDER[index - 1]?.id ?? null,
    next: ORDER[index + 1]?.id ?? null,
    startedAt: null,
    endedAt: null,
    durationMs: step.durationMs,
    costUsd: null,
    tokens: null,
    model: null,
    provider: null,
    turns: null,
    stopReason: null,
    error: null,
    skip: null,
    ...change
  }
}

const row = (key: string, label: string, detail = 'Agent text'): ActivityRow => ({ key, kind: 'text', label, detail, at: null })

const sampleActivity: ActivityView = {
  kind: 'ready',
  attempts: [{ key: 'attempt:a1', number: 1, rows: [row('a1:text:4', 'Files listed'), { ...row('a1:tool:t1', 'Glob', 'Completed'), kind: 'tool' }] }],
  loaded: 2,
  total: 2,
  earlier: 0,
  pastCap: 0,
  hidden: 2,
  unreadable: 0,
  live: false
}

type StepScript = { step?: (request: StepRequest) => StepView; item?: (request: ItemRequest) => ItemView }

const readyStep = (request: StepRequest): StepView => ({ kind: 'ready', facts: sampleFacts(request.stepId), output: null, activity: sampleActivity })

async function mountOn(script: StepScript = {}, persisted: Record<string, unknown> = { section: 'runs', openRun: 'run-1' }): Promise<TestPanel> {
  const base = answeringRun(busy, readyDetail)
  const connection = connected
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'step.read': (request: StepRequest): StepAnswer => ({ connection, step: (script.step ?? readyStep)(request) }),
        'step.item': (request: ItemRequest) => ({ connection, item: script.item?.(request) ?? { kind: 'not-found' } }),
        'step.close': () => null
      }
    }),
    persisted: { workspace: persisted }
  })
  return panel
}

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

const STEPS = { type: 'Tree', label: 'Steps' }
const OPEN_STEP = { type: 'Button', text: 'Open step' }

describe('opening a step', () => {
  test('Open step on the selected step opens the step view through its own request', async () => {
    const view = await mountOn()
    await view.selectItem(STEPS, 'step:plan')
    await view.press(OPEN_STEP)
    assert.equal(view.find(STEPS), null)
    assert.deepEqual(requests(view, 'step.read'), [{ runId: 'run-1', stepId: 'plan' }])
    assert.ok(view.find({ type: 'Text', text: 'plan' }))
    clean(view)
  })

  test('Enter on a step row opens it, inner steps too', async () => {
    const view = await mountOn()
    await view.activateItem(STEPS, 'step:implement.build')
    assert.deepEqual(requests(view, 'step.read'), [{ runId: 'run-1', stepId: 'implement.build' }])
    assert.ok(view.find({ type: 'Text', text: 'build' }))
    clean(view)
  })
})

const opened = (stepId: string): Record<string, unknown> => ({ section: 'runs', openRun: 'run-1', openStep: stepId })
const PREVIOUS = { type: 'Button', text: 'Previous' }
const NEXT = { type: 'Button', text: 'Next' }
const BACK = { type: 'Button', text: 'Run' }
const ACTIVITY = { type: 'Tree', label: 'Activity' }

describe('the header row', () => {
  test('Previous and Next walk the step list in order, inner steps included, and are off at the ends', async () => {
    const view = await mountOn({}, opened('plan'))
    assert.equal(view.find(PREVIOUS)?.props.disabled, true)
    assert.equal(view.find(NEXT)?.props.disabled, false)
    await view.press(NEXT)
    await view.press(NEXT)
    assert.deepEqual(requests(view, 'step.read'), [
      { runId: 'run-1', stepId: 'plan' },
      { runId: 'run-1', stepId: 'implement' },
      { runId: 'run-1', stepId: 'implement.build' }
    ])
    assert.ok(view.find({ type: 'Text', text: 'build' }))
    // The step left is no longer polled.
    assert.deepEqual(requests(view, 'step.close'), [
      { runId: 'run-1', stepId: 'plan' },
      { runId: 'run-1', stepId: 'implement' }
    ])
    await view.press(PREVIOUS)
    assert.ok(view.find({ type: 'Text', text: 'implement' }))
    clean(view)
  })

  test('Next is off on the last step', async () => {
    const view = await mountOn({}, opened('ship'))
    assert.equal(view.find(NEXT)?.props.disabled, true)
    assert.equal(view.find(PREVIOUS)?.props.disabled, false)
  })

  test('going back shows run detail with the step selected, and tells the worker the view closed', async () => {
    const view = await mountOn({}, opened('implement.test'))
    await view.press(BACK)
    assert.ok(view.find(STEPS))
    assert.equal(view.find(STEPS)?.props.selected, 'step:implement.test')
    assert.ok(view.find(OPEN_STEP))
    assert.deepEqual(requests(view, 'step.close'), [{ runId: 'run-1', stepId: 'implement.test' }])
    clean(view)
  })

  test('closing the panel tells the worker the view closed', async () => {
    const view = await mountOn({}, opened('plan'))
    const host = view.host
    await view.unmount()
    panel = undefined
    assert.deepEqual(
      host
        .callsOf('plugin.request')
        .filter((params) => (params as { name: string }).name === 'step.close')
        .map((params) => (params as { input: unknown }).input),
      [{ runId: 'run-1', stepId: 'plan' }]
    )
  })
})

describe('below the header', () => {
  test('the name and badge, the position line, then Facts and Output shut and Activity open', async () => {
    const view = await mountOn({}, opened('implement.build'))
    assert.ok(view.find({ type: 'Text', text: 'build' }))
    assert.equal(view.find({ type: 'Badge' })?.text, 'Completed')
    assert.ok(view.find({ type: 'Text', text: 'Step 3 of 6 · inner step of implement · ran 3 times' }))
    const folds = view.findAll({ type: 'Collapsible' }).map((fold) => [fold.props.title, fold.props.open])
    assert.deepEqual(folds, [
      ['Facts', false],
      ['Output', false],
      ['Activity', true]
    ])
    clean(view)
  })

  test("a failed step's error is in a danger callout; a skipped step says why and its condition", async () => {
    const view = await mountOn(
      {
        step: (request) => ({
          kind: 'ready',
          facts:
            request.stepId === 'plan'
              ? sampleFacts('plan', { state: 'failed', error: "Bash node 'plan' failed [exit 1]" })
              : sampleFacts(request.stepId, { state: 'skipped', skip: { reason: 'when_condition', condition: "$plan.output == 'yes'" } }),
          output: null,
          activity: sampleActivity
        })
      },
      opened('plan')
    )
    const callout = view.find({ type: 'Callout' })
    assert.equal(callout?.props.tone, 'danger')
    assert.ok(view.find({ type: 'Text', text: "Bash node 'plan' failed [exit 1]" }))
    await view.press(NEXT)
    assert.ok(view.find({ type: 'Text', text: 'Skipped because its condition was false.' }))
    assert.ok(view.find({ type: 'Text', text: "Condition: $plan.output == 'yes'" }))
    clean(view)
  })

  test('the output is plain text in its blocks, with a line when the rest is not shown', async () => {
    const markdown = '# Not a heading\n\n**not bold**\n'
    const view = await mountOn({
      step: (request) => ({ kind: 'ready', facts: sampleFacts(request.stepId), output: { blocks: [markdown, 'second block'], notShown: 1_234 }, activity: sampleActivity })
    }, opened('plan'))
    await view.toggle({ type: 'Collapsible', label: 'Output' })
    assert.ok(view.find({ type: 'Text', text: markdown }))
    assert.ok(view.find({ type: 'Text', text: 'second block' }))
    assert.equal(view.find({ type: 'Markdown' }), null)
    assert.ok(view.find({ type: 'Text', text: 'The output is cut at 256 KiB: the last 1,234 characters are not shown.' }))
    clean(view)
  })
})

describe('the activity', () => {
  /** `total` text items in two attempts, the newest `loaded` on the page. */
  function paged(loaded: number, total: number): ActivityView {
    const rows = Array.from({ length: loaded }, (_, index) => row(`a2:text:${String(total - index)}`, `Item ${String(total - index)}`))
    return {
      kind: 'ready',
      attempts: [
        { key: 'attempt:a2', number: 2, rows: rows.slice(0, 10) },
        { key: 'attempt:a1', number: 1, rows: rows.slice(10) }
      ],
      loaded,
      total,
      earlier: total - loaded,
      pastCap: 0,
      hidden: 7,
      unreadable: 1,
      live: true
    }
  }

  test('is a tree with a branch per attempt, newest first, a loaded count, and Show earlier asks for one page more', async () => {
    const view = await mountOn({
      step: (request) => ({ kind: 'ready', facts: sampleFacts(request.stepId), output: null, activity: paged(Math.min(120, (request.pages ?? 1) * 50), 120) })
    }, opened('plan'))
    const tree = view.find(ACTIVITY)
    const items = tree?.props.items as { key: string; label: string; children: unknown[] }[]
    assert.deepEqual(items.map((item) => [item.key, item.label, item.children.length]), [
      ['attempt:a2', 'Attempt 2', 10],
      ['attempt:a1', 'Attempt 1', 40]
    ])
    assert.deepEqual(view.expandedOf(ACTIVITY), ['attempt:a2', 'attempt:a1'])
    assert.ok(view.find({ type: 'Text', text: '50 of 120 items loaded.' }))
    assert.ok(view.find({ type: 'Text', text: '7 events are not listed: hooks that did not fail, state updates and kinds Orchon does not list.' }))
    assert.ok(view.find({ type: 'Text', text: '1 event could not be read and is not listed.' }))
    assert.ok(view.find({ type: 'Text', text: 'The step is running: new activity is read every 3 seconds.' }))
    await view.press({ type: 'Button', text: 'Show earlier (70 more)' })
    assert.deepEqual(requests(view, 'step.read').at(-1), { runId: 'run-1', stepId: 'plan', pages: 2 })
    assert.ok(view.find({ type: 'Text', text: '100 of 120 items loaded.' }))
    clean(view)
  })

  test("past 32 MiB the notice stands in place of the list", async () => {
    const view = await mountOn({ step: (request) => ({ kind: 'ready', facts: sampleFacts(request.stepId), output: null, activity: { kind: 'too-large' } }) }, opened('plan'))
    assert.equal(view.find(ACTIVITY), null)
    assert.ok(view.find({ type: 'Text', text: "This step's activity is larger than 32 MiB, so Orchon does not show it. Open Archon's console to look at it." }))
  })

  test('selecting a tool call asks the worker for it then and shows its input and output under the tree, with both cut lines', async () => {
    const view = await mountOn({
      item: (request) =>
        request.key === 'a1:tool:t1'
          ? {
              kind: 'tool',
              name: 'Bash',
              title: 'ls',
              state: 'completed',
              input: { text: '{"command":"ls"}', cut: false },
              output: { text: '**README.md**', cut: true },
              outputTruncated: true,
              exitCode: 0
            }
          : { kind: 'text', text: { text: 'Files listed', cut: false } }
    }, opened('plan'))
    await view.selectItem(ACTIVITY, 'a1:tool:t1')
    assert.deepEqual(requests(view, 'step.item'), [{ runId: 'run-1', stepId: 'plan', key: 'a1:tool:t1' }])
    assert.ok(view.find({ type: 'Text', text: 'Bash: ls' }))
    assert.ok(view.find({ type: 'Text', text: '{"command":"ls"}' }))
    assert.ok(view.find({ type: 'Text', text: '**README.md**' }))
    assert.equal(view.find({ type: 'Markdown' }), null)
    assert.equal(view.findAll({ type: 'Text', text: 'The text is cut at 16 KiB.' }).length, 1)
    assert.ok(view.find({ type: 'Text', text: 'Archon stored only part of this output.' }))
    await view.selectItem(ACTIVITY, 'a1:text:4')
    assert.ok(view.find({ type: 'Text', text: 'Files listed' }))
    assert.equal(requests(view, 'step.item').length, 2)
    clean(view)
  })

  test("the worker's hint for the open step reads it again once the gap allows; a hint for another step does not", async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 18, 12) })
    try {
      const view = await mountOn({}, opened('plan'))
      const before = requests(view, 'step.read').length
      await view.post('step.changed', { runId: 'run-1', stepId: 'review' })
      mock.timers.tick(1_000)
      await view.settled()
      assert.equal(requests(view, 'step.read').length, before)
      await view.post('step.changed', { runId: 'run-1', stepId: 'plan' })
      mock.timers.tick(1_000)
      await view.settled()
      assert.equal(requests(view, 'step.read').length, before + 1)
      // A run hint that names the run reads the open step again too.
      await view.post('runs.changed', { types: ['dag_node'], runs: ['run-1'] })
      mock.timers.tick(1_000)
      await view.settled()
      assert.equal(requests(view, 'step.read').length, before + 2)
      await view.unmount()
      panel = undefined
    } finally {
      mock.timers.reset()
    }
  })
})
