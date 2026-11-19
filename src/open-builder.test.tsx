// The frame seam for Open workflow in builder in run detail: src/panel.tsx mounted on a scripted
// worker, open on a run. These tests cover the button, the reason it is off, and the request it sends.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected, searching } from '../scripts/connection-samples.ts'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { RunDetailAnswer, RunDetailRequest } from './run-detail-view'
import type { BuilderOpenAnswer, BuilderOpenRequest } from './wide-tabs-view'

const OPEN_BUILDER = { type: 'Button', text: 'Open workflow in builder' }

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

type Script = { builderOff?: string; codebaseId?: string; open?: (request: BuilderOpenRequest) => BuilderOpenAnswer }

async function openOn(script: Script = { codebaseId: 'cb-web' }): Promise<TestPanel> {
  const connection = connected
  const base = answeringRun((request) => busyRuns(10, request), () => ({ kind: 'ready', detail: sampleDetail(1) }), connection)
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'run.read': (request: RunDetailRequest): RunDetailAnswer => ({
          connection,
          run: { kind: 'ready', detail: sampleDetail(Number(request.runId.slice(4))) },
          ...(script.builderOff === undefined ? {} : { builderOff: script.builderOff }),
          ...(script.codebaseId === undefined ? {} : { codebaseId: script.codebaseId })
        }),
        'builder.open': script.open ?? (() => ({ opened: true }))
      }
    }),
    persisted: { workspace: { section: 'runs', openRun: 'run-1' } }
  })
  return panel
}

const sent = (view: TestPanel, name: string): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input: unknown }).input)

describe('Open workflow in builder in run detail', () => {
  test("opens the run's workflow in its project", async () => {
    const view = await openOn()
    assert.equal(view.find(OPEN_BUILDER)?.disabled, false)
    await view.press(OPEN_BUILDER)
    assert.deepEqual(sent(view, 'builder.open'), [{ name: 'workflow-1', codebaseId: 'cb-web' }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  })

  test('for a run with no project, opens it with none', async () => {
    const view = await openOn({})
    await view.press(OPEN_BUILDER)
    assert.deepEqual(sent(view, 'builder.open'), [{ name: 'workflow-1', codebaseId: null }])
  })

  test('is disabled with the reason the worker gives', async () => {
    const reason = 'No workspace is focused in Orca. Wide tabs open in a workspace on this computer.'
    const view = await openOn({ builderOff: reason, codebaseId: 'cb-web' })
    assert.equal(view.find(OPEN_BUILDER)?.disabled, true)
    assert.ok(view.find({ type: 'Text', text: reason }))
  })

  test('says why when the worker could not open the tab', async () => {
    const reason = 'Archon has no workflow named workflow-1 here.'
    const view = await openOn({ codebaseId: 'cb-web', open: () => ({ opened: false, reason }) })
    await view.press(OPEN_BUILDER)
    assert.ok(view.find({ type: 'Text', text: reason }))
  })

  test('is disabled under the Searching banner', async () => {
    const view = await openOn()
    await view.post('connection.changed', { ...searching, since: connected.since + 1_000 })
    assert.equal(view.find(OPEN_BUILDER)?.disabled, true)
  })
})
