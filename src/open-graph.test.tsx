// The frame seam for Open graph: src/panel.tsx mounted on a scripted worker, open on a run. These
// tests cover the button, the reason it is off, and the request it sends.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected, searching } from '../scripts/connection-samples.ts'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { RunDetailAnswer, RunDetailRequest } from './run-detail-view'
import type { GraphOpenAnswer, GraphOpenRequest } from './wide-tabs-view'

const OPEN_GRAPH = { type: 'Button', text: 'Open graph' }

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

type Script = { graphOff?: string; open?: (request: GraphOpenRequest) => GraphOpenAnswer }

async function openOn(script: Script = {}): Promise<TestPanel> {
  const connection = connected
  const base = answeringRun((request) => busyRuns(10, request), () => ({ kind: 'ready', detail: sampleDetail(1) }), connection)
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'run.read': (request: RunDetailRequest): RunDetailAnswer => ({
          connection,
          run: { kind: 'ready', detail: sampleDetail(Number(request.runId.slice(4))) },
          ...(script.graphOff === undefined ? {} : { graphOff: script.graphOff })
        }),
        'graph.open': script.open ?? (() => ({ opened: true }))
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

describe('Open graph in run detail', () => {
  test('sits under the folds and opens the run in a wide tab', async () => {
    const view = await openOn()
    const button = view.find(OPEN_GRAPH)
    assert.equal(button?.disabled, false)
    await view.press(OPEN_GRAPH)
    assert.deepEqual(sent(view, 'graph.open'), [{ runId: 'run-1' }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  })

  test('is disabled with the reason the worker gives', async () => {
    const reason = 'No workspace is focused in Orca. Wide tabs open in a workspace on this computer.'
    const view = await openOn({ graphOff: reason })
    assert.equal(view.find(OPEN_GRAPH)?.disabled, true)
    assert.ok(view.find({ type: 'Text', text: reason }))
  })

  test('says why when the worker could not open the tab', async () => {
    const reason = 'Orchon could not write its tab file into .orchon/ in this workspace, so wide tabs are off here until Orca restarts the plugin.'
    const view = await openOn({ open: () => ({ opened: false, reason }) })
    await view.press(OPEN_GRAPH)
    assert.ok(view.find({ type: 'Text', text: reason }))
  })

  test('is disabled under the Searching banner', async () => {
    const view = await openOn()
    await view.post('connection.changed', { ...searching, since: connected.since + 1_000 })
    assert.equal(view.find(OPEN_GRAPH)?.disabled, true)
  })
})
