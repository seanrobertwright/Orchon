// The frame seam for run control: src/panel.tsx mounted on a scripted worker that answers the runs
// table, run detail and run control. These tests cover the waiting callouts with nothing to answer,
// the action row each state offers, its inline confirmations, and what the panel shows and asks
// for once a write returns.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected } from '../scripts/connection-samples.ts'
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
