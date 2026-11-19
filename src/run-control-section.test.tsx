// The frame seam for run control: src/panel.tsx mounted on a scripted worker that answers the runs
// table, run detail and run control. These tests cover the waiting callouts with nothing to answer,
// the action row each state offers, its inline confirmations, and what the panel shows and asks
// for once a write returns.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected, searching } from '../scripts/connection-samples.ts'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { RunControlOutcome, RunControlRequest } from './run-control-view'
import type { RunDetail, RunDetailRequest, RunDetailView } from './run-detail-view'
import type { RunsRequest, RunsView } from './runs-view'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const busy = (request: RunsRequest): RunsView => busyRuns(40, request)

/** A run-control answer the scripted worker gives: an outcome, or a promise the test settles. */
type Control = (request: RunControlRequest) => RunControlOutcome | Promise<RunControlOutcome>

/** Mounts the panel on run-1, answered by `detail` for every read. */
async function openOn(detail: (request: RunDetailRequest) => RunDetailView, control?: Control): Promise<TestPanel> {
  const base = answeringRun(busy, detail)
  const requests = {
    ...base.requests,
    'run.control': async (request: RunControlRequest) => ({ connection: connected, outcome: await (control ?? (() => ({ kind: 'done', message: '' }) as const))(request) })
  }
  panel = await mount(panelModule, { host: mockHost({ requests }), persisted: { workspace: { section: 'runs', openRun: 'run-1' } } })
  return panel
}

const runOf = (change: Partial<RunDetail>) => (): RunDetailView => ({ kind: 'ready', detail: sampleDetail(1, { id: 'run-1', ...change }) })

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

describe('the waiting callouts with nothing to answer', () => {
  test('waiting on sub-runs says how many and that each is answered in its own run', async () => {
    const children = [{ id: 'run-7', workflow: 'child-flow', status: 'paused' as const }]
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'children', children, more: 2 } }))
    assert.ok(view.find({ type: 'Text', text: 'Waiting on 3 sub-runs. Answer each one in its own run.' }))
    clean(view)
  })

  test('waiting on one sub-run says so in the singular', async () => {
    const children = [{ id: 'run-7', workflow: 'child-flow', status: 'paused' as const }]
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'children', children, more: 0 } }))
    assert.ok(view.find({ type: 'Text', text: 'Waiting on 1 sub-run. Answer it in its own run.' }))
  })

  test('a usage-limit pause says Archon tries again by itself, with the time relative', async () => {
    const at = Date.UTC(2026, 10, 18, 13, 0, 0)
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'usage-limit', resumeAt: at } }))
    const sentence = view.find({ type: 'Text', text: /^Paused on a provider usage limit\. Archon tries again by itself/ })
    assert.ok(sentence)
    assert.equal(view.find({ type: 'RelativeTime' })?.props.at, at)
    clean(view)
  })

  test('a usage-limit time that did not parse drops the time and keeps the sentence', async () => {
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'usage-limit', resumeAt: null } }))
    assert.ok(view.find({ type: 'Text', text: 'Paused on a provider usage limit. Archon tries again by itself.' }))
    assert.equal(view.find({ type: 'RelativeTime' }), null)
  })

  test("an unreadable run is a warning with Archon's detail as plain text and a pointer to Archon's console", async () => {
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'unreadable', detail: '**malformed** gate' } }))
    const callout = view.find({ type: 'Callout' })
    assert.equal(callout?.props.tone, 'warning')
    assert.ok(view.find({ type: 'Text', text: '**malformed** gate' }))
    assert.ok(view.find({ type: 'Text', text: "Orchon cannot read what this run waits for. Open Archon's console to look at it." }))
    assert.equal(view.findAll({ type: 'Markdown' }).length, 0)
  })

  test('stalled tool calls are a warning naming each tool and for how long it has not returned, then how many more', async () => {
    const calls = [
      { name: 'Bash', title: 'Running the tests', stalledForMs: 300_000 },
      { name: 'Read', title: null, stalledForMs: 75_000 }
    ]
    const view = await openOn(runOf({ status: 'running', waiting: { kind: 'stalled', calls, more: 4 } }))
    assert.equal(view.find({ type: 'Callout' })?.props.tone, 'warning')
    assert.ok(view.find({ type: 'Text', text: '6 tool calls have not returned.' }))
    const rows = view.findAll({ type: 'ListItem' }).map((row) => [row.label, row.props.description])
    assert.deepEqual(rows, [
      ['Bash: Running the tests', 'No answer for 5m'],
      ['Read', 'No answer for 1m 15s']
    ])
    assert.ok(view.find({ type: 'Text', text: 'and 4 more' }))
  })

  test('a kind this version does not know says so and points to Archon\'s console', async () => {
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'unknown' } }))
    assert.ok(view.find({ type: 'Text', text: "This run is waiting in a way this version of Orchon does not know. Open Archon's console to look at it." }))
  })
})

/** The buttons of the action row and its confirmations, by their text, in the order drawn. */
const WRITE_TEXTS = ['Cancel', 'Abandon', 'Resume', 'Try now', 'Keep running', 'Stop run', 'Keep run', 'Abandon run']
const actionButtons = (view: TestPanel): string[] =>
  view
    .findAll({ type: 'Button' })
    .map((button) => button.text)
    .filter((text) => WRITE_TEXTS.includes(text) || text.endsWith('…'))

/** Every run-control request the panel sent, in order. */
const controls = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'run.control')
    .map((params) => (params as { input: unknown }).input)

const reads = (view: TestPanel): number =>
  view.host.callsOf('plugin.request').filter((params) => (params as { name: string }).name === 'run.read').length

describe('the action row offers what each state allows', () => {
  test('a running run offers Cancel only', async () => {
    const view = await openOn(runOf({ status: 'running' }))
    assert.deepEqual(actionButtons(view), ['Cancel'])
    clean(view)
  })

  test('a running run whose owner is unreachable offers Cancel and Abandon', async () => {
    const view = await openOn(runOf({ status: 'running', ownerUnreachable: true }))
    assert.deepEqual(actionButtons(view), ['Cancel', 'Abandon'])
  })

  test('a running run with stalled tool calls offers Cancel', async () => {
    const view = await openOn(runOf({ status: 'running', waiting: { kind: 'stalled', calls: [], more: 0 } }))
    assert.deepEqual(actionButtons(view), ['Cancel'])
  })

  test('a usage-limit pause offers Try now and Abandon', async () => {
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'usage-limit', resumeAt: null } }))
    assert.deepEqual(actionButtons(view), ['Try now', 'Abandon'])
  })

  test('a failed run offers Resume and Abandon', async () => {
    const view = await openOn(runOf({ status: 'failed' }))
    assert.deepEqual(actionButtons(view), ['Resume', 'Abandon'])
  })

  test('queued, completed and cancelled runs, and pauses with nothing to answer, offer nothing', async () => {
    const changes: Partial<RunDetail>[] = [
      { status: 'pending' },
      { status: 'completed' },
      { status: 'cancelled' },
      { status: 'paused', waiting: { kind: 'children', children: [], more: 1 } },
      { status: 'paused', waiting: { kind: 'unreadable', detail: '' } },
      { status: 'paused', waiting: { kind: 'time', until: null } },
      { status: 'paused', waiting: { kind: 'event', event: 'e', until: null } },
      { status: 'paused', waiting: { kind: 'unknown' } }
    ]
    for (const change of changes) {
      const view = await openOn(runOf(change))
      assert.deepEqual(actionButtons(view), [], JSON.stringify(change))
      await view.unmount()
      panel = undefined
    }
  })

  test('the preview under the runs table stays read-only', async () => {
    const base = answeringRun(busy, runOf({ status: 'running' }))
    panel = await mount(panelModule, { host: mockHost({ requests: base.requests }) })
    await panel.selectRows({ type: 'Table', label: 'Runs' }, ['run-0'])
    assert.ok(panel.find({ type: 'Button', text: 'Open run' }))
    assert.deepEqual(actionButtons(panel), [])
  })
})

describe('confirming Cancel and Abandon inline', () => {
  test('Cancel asks first, with the safe button first, and Keep running sends nothing', async () => {
    const view = await openOn(runOf({ status: 'running' }))
    await view.press({ type: 'Button', text: 'Cancel' })
    assert.ok(view.find({ type: 'Text', text: 'Stop this run? It cannot be resumed afterwards.' }))
    assert.deepEqual(actionButtons(view), ['Keep running', 'Stop run'])
    await view.press({ type: 'Button', text: 'Keep running' })
    assert.deepEqual(actionButtons(view), ['Cancel'])
    assert.deepEqual(controls(view), [])
    clean(view)
  })

  test('Stop run sends the cancel once', async () => {
    const view = await openOn(runOf({ status: 'running' }))
    await view.press({ type: 'Button', text: 'Cancel' })
    await view.press({ type: 'Button', text: 'Stop run' })
    assert.deepEqual(controls(view), [{ runId: 'run-1', action: 'cancel' }])
  })

  test('Abandon asks first with its own sentence, and Abandon run sends it', async () => {
    const view = await openOn(runOf({ status: 'failed' }))
    await view.press({ type: 'Button', text: 'Abandon' })
    assert.ok(view.find({ type: 'Text', text: 'Abandon this run? Its sub-runs are cancelled and its worktrees are released.' }))
    assert.deepEqual(actionButtons(view), ['Keep run', 'Abandon run'])
    assert.deepEqual(controls(view), [])
    await view.press({ type: 'Button', text: 'Abandon run' })
    assert.deepEqual(controls(view), [{ runId: 'run-1', action: 'abandon' }])
  })

  test('Resume and Try now send at once, with no confirmation', async () => {
    const failed = await openOn(runOf({ status: 'failed' }))
    await failed.press({ type: 'Button', text: 'Resume' })
    assert.deepEqual(controls(failed), [{ runId: 'run-1', action: 'resume' }])
    await failed.unmount()
    const limited = await openOn(runOf({ status: 'paused', waiting: { kind: 'usage-limit', resumeAt: null } }))
    await limited.press({ type: 'Button', text: 'Try now' })
    assert.deepEqual(controls(limited), [{ runId: 'run-1', action: 'resume' }])
  })

  test("the confirmation closes by itself when the run's status changes", async () => {
    let status: RunDetail['status'] = 'running'
    const view = await openOn(() => ({ kind: 'ready', detail: sampleDetail(1, { id: 'run-1', status }) }))
    await view.press({ type: 'Button', text: 'Cancel' })
    status = 'failed'
    // A hint naming the run reads it again once run detail's 1 second gap allows.
    await view.post('runs.changed', { types: ['workflow_status'], runs: ['run-1'] })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await view.settled()
    assert.equal(view.find({ type: 'Text', text: 'Stop this run? It cannot be resumed afterwards.' }), null)
    assert.deepEqual(actionButtons(view), ['Resume', 'Abandon'])
  })
})

/** Lets the panel draw what a press set off, without waiting for a request still held. */
const drawn = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** A run-control answer the test settles by hand. */
function heldControl(): { control: Control; settle(outcome: RunControlOutcome): void } {
  let release: ((outcome: RunControlOutcome) => void) | undefined
  return {
    control: () =>
      new Promise<RunControlOutcome>((resolve) => {
        release = resolve
      }),
    settle: (outcome) => release?.(outcome)
  }
}

describe('one write per run at a time', () => {
  test('while a write is in flight the pressed button reads Cancelling… and every write control is off', async () => {
    const held = heldControl()
    const view = await openOn(runOf({ status: 'running', ownerUnreachable: true }), held.control)
    await view.press({ type: 'Button', text: 'Cancel' })
    const pressing = view.press({ type: 'Button', text: 'Stop run' })
    await drawn()
    assert.deepEqual(actionButtons(view), ['Keep running', 'Cancelling…'])
    for (const text of ['Keep running', 'Cancelling…']) assert.equal(view.find({ type: 'Button', text })?.props.disabled, true, text)
    held.settle({ kind: 'done', message: 'Cancelled workflow: workflow-1' })
    await pressing
    assert.deepEqual(controls(view), [{ runId: 'run-1', action: 'cancel' }])
    assert.deepEqual(actionButtons(view), ['Cancel', 'Abandon'])
    assert.equal(view.find({ type: 'Button', text: 'Cancel' })?.props.disabled ?? false, false)
  })

  test('Resume reads Resuming… and Abandon beside it is off until the answer comes', async () => {
    const held = heldControl()
    const view = await openOn(runOf({ status: 'failed' }), held.control)
    const pressing = view.press({ type: 'Button', text: 'Resume' })
    await drawn()
    assert.deepEqual(actionButtons(view), ['Resuming…', 'Abandon'])
    assert.equal(view.find({ type: 'Button', text: 'Abandon' })?.props.disabled, true)
    assert.equal(view.find({ type: 'Button', text: 'Resuming…' })?.props.disabled, true)
    assert.equal(controls(view).length, 1)
    held.settle({ kind: 'done', message: '' })
    await pressing
  })

  test('Try now reads Trying now… while in flight', async () => {
    const held = heldControl()
    const view = await openOn(runOf({ status: 'paused', waiting: { kind: 'usage-limit', resumeAt: null } }), held.control)
    const pressing = view.press({ type: 'Button', text: 'Try now' })
    await drawn()
    assert.deepEqual(actionButtons(view), ['Trying now…', 'Abandon'])
    held.settle({ kind: 'done', message: '' })
    await pressing
  })

  test('every write control is off while Searching, and the run stays under the banner', async () => {
    const view = await openOn(runOf({ status: 'failed' }))
    await view.post('connection.changed', { ...searching, since: connected.since + 1 })
    assert.deepEqual(actionButtons(view), ['Resume', 'Abandon'])
    for (const text of ['Resume', 'Abandon']) assert.equal(view.find({ type: 'Button', text })?.props.disabled, true, text)
  })

  test('when a write returns, run detail is read again at once', async () => {
    const view = await openOn(runOf({ status: 'failed' }))
    const before = reads(view)
    await view.press({ type: 'Button', text: 'Resume' })
    assert.equal(reads(view), before + 1)
  })
})

describe('what the panel shows once a write returns', () => {
  async function outcomeOf(outcome: RunControlOutcome, change: Partial<RunDetail> = { status: 'failed' }): Promise<TestPanel> {
    const view = await openOn(runOf(change), () => outcome)
    await view.press({ type: 'Button', text: 'Resume' })
    return view
  }

  test("Archon's message is shown as plain text", async () => {
    const view = await outcomeOf({ kind: 'done', message: 'Resuming **workflow**: workflow-1' })
    assert.ok(view.find({ type: 'Text', text: 'Resuming **workflow**: workflow-1' }))
    assert.equal(view.findAll({ type: 'Markdown' }).length, 0)
    clean(view)
  })

  test("a refusal is Archon's text in a danger callout", async () => {
    const view = await outcomeOf({ kind: 'refused', status: 400, message: "Cannot resume workflow in 'running' status" })
    assert.ok(view.findAll({ type: 'Callout' }).some((found) => found.props.tone === 'danger'))
    assert.ok(view.find({ type: 'Text', text: "Cannot resume workflow in 'running' status" }))
  })

  test('a refusal naming a sub-run offers Open sub-run, which opens it', async () => {
    const view = await outcomeOf({ kind: 'refused', status: 409, message: 'Run is paused waiting on sub-run run-7.', childRunId: 'run-7' })
    await view.press({ type: 'Button', text: 'Open sub-run' })
    const opened = view.host
      .callsOf('plugin.request')
      .filter((params) => (params as { name: string }).name === 'run.read')
      .map((params) => (params as { input: unknown }).input)
    assert.deepEqual(opened.at(-1), { runId: 'run-7', open: true })
  })

  test('Cancel refused with a 409 reveals Abandon', async () => {
    const view = await openOn(runOf({ status: 'running' }), () => ({ kind: 'refused', status: 409, message: 'The owner did not answer.' }))
    await view.press({ type: 'Button', text: 'Cancel' })
    await view.press({ type: 'Button', text: 'Stop run' })
    assert.deepEqual(actionButtons(view), ['Cancel', 'Abandon'])
    assert.ok(view.find({ type: 'Text', text: 'The owner did not answer.' }))
  })

  test('Cancel refused with a 400 does not reveal Abandon', async () => {
    const view = await openOn(runOf({ status: 'running' }), () => ({ kind: 'refused', status: 400, message: 'No.' }))
    await view.press({ type: 'Button', text: 'Cancel' })
    await view.press({ type: 'Button', text: 'Stop run' })
    assert.deepEqual(actionButtons(view), ['Cancel'])
  })

  test('a 404 says the run no longer exists, with Back to runs', async () => {
    let removed = false
    const view = await openOn(
      () => (removed ? { kind: 'gone' } : { kind: 'ready', detail: sampleDetail(1, { id: 'run-1', status: 'failed' }) }),
      () => {
        removed = true
        return { kind: 'gone' }
      }
    )
    await view.press({ type: 'Button', text: 'Resume' })
    assert.ok(view.find({ type: 'Text', text: 'This run no longer exists.' }))
    await view.press({ type: 'Button', text: 'Back to runs' })
    assert.ok(view.find({ type: 'Table', label: 'Runs' }))
  })

  test("a 500 says Archon could not do that, with Archon's text when there is some", async () => {
    const withText = await outcomeOf({ kind: 'failed', message: 'Database is locked' })
    assert.ok(withText.find({ type: 'Text', text: 'Archon could not do that.' }))
    assert.ok(withText.find({ type: 'Text', text: 'Database is locked' }))
    await withText.unmount()
    const without = await outcomeOf({ kind: 'failed', message: null })
    assert.ok(without.find({ type: 'Text', text: 'Archon could not do that.' }))
  })

  test('a timeout says the action may still have happened, and nothing is sent again', async () => {
    const view = await outcomeOf({ kind: 'timeout' })
    assert.ok(view.find({ type: 'Text', text: 'Archon did not answer in 30 seconds. The action may still have happened.' }))
    assert.equal(controls(view).length, 1)
  })

  test('the outcome goes when the person leaves the run', async () => {
    const view = await outcomeOf({ kind: 'done', message: 'Resuming workflow: workflow-1' })
    await view.press({ type: 'Button', text: 'Runs' })
    await view.activateRow({ type: 'Table', label: 'Runs' }, 'run-1')
    assert.equal(view.find({ type: 'Text', text: 'Resuming workflow: workflow-1' }), null)
  })
})
