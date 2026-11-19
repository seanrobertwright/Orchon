// The frame seam for Re-run: src/panel.tsx mounted on a scripted worker that answers run detail
// and the Launch requests. These tests cover where Re-run is drawn, what a press sends, and what
// the Launch section then shows.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected } from '../scripts/connection-samples.ts'
import { answeringLaunch, webForm } from '../scripts/launch-samples.ts'
import { sampleDetail } from '../scripts/runs-samples.ts'
import type { LaunchAnswer, LaunchView } from './launch-view'
import * as panelModule from './panel'
import type { RunDetail, RunDetailAnswer } from './run-detail-view'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const SECTION_BAR = { label: 'Orchon sections' }
const RERUN = { type: 'Button', text: 'Re-run' }
const MESSAGE = { type: 'Textarea', label: 'Message' }

/** The form Re-run fills, as the worker answers it. */
const filled: LaunchView = {
  ...webForm,
  workflow: null,
  description: '',
  message: 'Ship the change again.',
  rerunNotes: ['The workflow old-deliver is no longer listed for this project, so no workflow is chosen. Choose one.', 'Not filled, because the workflow no longer declares them: ticket.']
}

/** Mounts the panel on run-1 in run detail, with Re-run offered when `offered` says so. */
async function openOn(change: Partial<RunDetail>, offered: boolean, rerun: () => LaunchView | Promise<LaunchView> = () => filled): Promise<TestPanel> {
  let afterRerun = false
  const base = answeringLaunch({ launch: () => (afterRerun ? filled : webForm) })
  const requests = {
    ...base.requests,
    'run.read': (): RunDetailAnswer => ({
      connection: connected,
      run: { kind: 'ready', detail: sampleDetail(1, { id: 'run-1', ...change }) },
      ...(offered ? { rerun: true as const } : {})
    }),
    'launch.rerun': async (): Promise<LaunchAnswer> => {
      const launch = await rerun()
      afterRerun = true
      return { connection: connected, launch, notices: [] }
    }
  }
  panel = await mount(panelModule, { host: mockHost({ requests }), persisted: { workspace: { section: 'runs', openRun: 'run-1' } } })
  return panel
}

function sent(view: TestPanel, name: string): unknown[] {
  return view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input?: unknown }).input ?? null)
}

describe('Re-run in run detail', () => {
  test('is drawn in the action row when the worker offers it, and not otherwise', async () => {
    const shown = await openOn({ status: 'completed' }, true)
    assert.ok(shown.find(RERUN))
    await shown.unmount()
    panel = undefined
    const hidden = await openOn({ status: 'completed' }, false)
    assert.equal(hidden.find(RERUN), null)
  })

  test('a press sends only the run id, opens the Launch section filled in with its notices, and starts nothing', async () => {
    const view = await openOn({ status: 'cancelled' }, true)
    await view.press(RERUN)
    assert.deepEqual(sent(view, 'launch.rerun'), [{ runId: 'run-1' }])
    assert.equal(view.valueOf(SECTION_BAR), 'launch')
    assert.equal(view.valueOf(MESSAGE), 'Ship the change again.')
    for (const note of filled.kind === 'ready' ? (filled.rerunNotes ?? []) : []) assert.ok(view.find({ type: 'Text', text: note }), note)
    assert.deepEqual(sent(view, 'launch.start'), [])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  })

  test("a refused Re-run stays in run detail and says the worker's reason", async () => {
    const view = await openOn({ status: 'completed' }, true, () => {
      throw Object.assign(new Error('Archon no longer lists that project. Choose another.'), { code: 'invalid_params' })
    })
    await view.press(RERUN)
    assert.equal(view.valueOf(SECTION_BAR), 'runs')
    assert.ok(view.find({ type: 'Text', text: 'Archon no longer lists that project. Choose another.' }))
  })
})
