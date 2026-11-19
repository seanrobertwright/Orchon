// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded run detail answers, and a stand-in Orca host. These tests cover Re-run: the draft the
// worker builds from the run itself, the notices beside it, and when run detail offers it.
import { assert, describe, test, type MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type MountedScene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import type { LaunchAnswer, LaunchView } from './launch-view'

const CODEBASES = `${DEFAULT}/api/codebases`
const RUN_PATH = `${DEFAULT}/api/workflows/runs/`
const workflowsUrl = (cwd: string): string => `${DEFAULT}/api/workflows?${new URLSearchParams({ cwd }).toString()}`
const RECORDED_CWD = '<project-path>'

/** The recorded project's id and each recording's completed, cancelled and failed runs, read off the fixtures by hand. */
const RECORDED: Record<Release, { project: string; completed: string; failed: string }> = {
  '0.12.1': { project: 'cd8c6f17a56a08ff6e8c24143751f5c4', completed: '7c28e1a1-6432-4c9d-89d6-874cfaf81f89', failed: '7aa79fd0-82a8-4f02-96a1-3bcaf1944649' },
  '0.13.2': { project: '6feec5b110ac5147f1d58ffa49d2790c', completed: '542b1888-311b-4b65-b005-8b78e33a7c79', failed: 'cc369ba0-9500-4ee5-8ec3-76ead586add9' },
  '0.14.0': { project: '4fb57f7e8043f7efd57270977e68c598', completed: '68b479b2-217a-4e84-b86d-ecb9faf394e6', failed: '9441f1e2-b466-440a-b869-65527d5688b9' }
}
const RECORDED_MESSAGE = 'Recording a launch for Orchon: one shell step.'

type Row = { id: string; kind: 'folder'; name: string; projectId: null; path: string; branch: null; hostId: string }
const local: Row = { id: 'ws-local', kind: 'folder', name: 'web', projectId: null, path: 'C:/Projects/web', branch: null, hostId: 'local' }
const sshRow: Row = { id: 'ws-ssh', kind: 'folder', name: 'box', projectId: null, path: '/srv/web', branch: null, hostId: 'ssh:box' }

function orcaWith(focused: string | null): MockHostOptions {
  return {
    storage: {},
    results: {
      'workspace.readContext': focused === null ? null : { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] },
      'workspace.list': { workspaces: [local, sshRow], truncated: false }
    }
  }
}

function rerunScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  stage.archon.answer(workflowsUrl(RECORDED_CWD), recorded(release, 'workflows'))
  stage.archon.answer(`${RUN_PATH}${RECORDED[release].completed}`, recorded(release, 'run-detail'))
  return stage
}

/** The recorded completed run's answer with its `run` changed, as a scripted Archon gives it. */
function changedRun(release: Release, change: (run: Record<string, unknown>) => void): ReturnType<typeof json> {
  const answer = recorded(release, 'run-detail')
  if (answer.kind !== 'json') throw new Error('The recorded run is not JSON.')
  const value = structuredClone(answer.value) as { run: Record<string, unknown> }
  change(value.run)
  return json(value)
}

const ready = (view: LaunchView): Extract<LaunchView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The launcher is ${view.kind}.`)
  return view
}

async function rerun(mounted: MountedScene, runId: string): Promise<LaunchAnswer> {
  return (await mounted.worker.request('launch.rerun', { runId })) as LaunchAnswer
}

describe('Re-run', () => {
  for (const release of RELEASES) {
    test(`fills the launcher with the recorded run's project, workflow and message of ${release}, and launches nothing`, async () => {
      const stage = rerunScene(release)
      const mounted = await stage.mount(orcaWith('ws-local'))
      const view = ready((await rerun(mounted, RECORDED[release].completed)).launch)
      assert.equal(view.codebaseId, RECORDED[release].project)
      assert.equal(view.workflow, 'orchon-recorder-echo')
      assert.equal(view.message, RECORDED_MESSAGE)
      assert.equal(view.starting, undefined)
      assert.deepEqual(view.rerunNotes ?? [], [])
      assert.equal(stage.archon.calls.filter((call) => call.method !== 'GET').length, 0)
      // The draft stays: the next read of the section shows it.
      const again = ready(((await mounted.worker.request('launch.read', {})) as LaunchAnswer).launch)
      assert.equal(again.message, RECORDED_MESSAGE)
      assert.equal(again.workflow, 'orchon-recorder-echo')
      await mounted.worker.deactivate()
    })
  }

  test('fills the inputs the workflow still declares from metadata.inputs, lists the dropped names, and fills no model binding', async () => {
    const stage = rerunScene()
    const id = RECORDED['0.12.1'].completed
    stage.archon.answer(
      `${RUN_PATH}${id}`,
      changedRun('0.12.1', (run) => {
        run['workflow_name'] = 'orchon-recorder-inputs'
        const metadata = run['metadata'] as Record<string, unknown>
        // The recorded launch of an undeclared input carries `metadata.inputs` in this shape.
        metadata['inputs'] = { item: 'the item', not_declared: 'x', gone_too: 'y' }
      })
    )
    const mounted = await stage.mount(orcaWith('ws-local'))
    const answer = await rerun(mounted, id)
    const view = ready(answer.launch)
    assert.equal(view.workflow, 'orchon-recorder-inputs')
    assert.deepEqual(view.inputs, [{ name: 'item', value: 'the item' }])
    assert.deepEqual(view.rerunNotes, ['Not filled, because the workflow no longer declares them: not_declared, gone_too.'])
    // The recorded run has model bindings in its metadata; none reach the launcher.
    assert.ok(!JSON.stringify(answer).includes('model_bindings'))
    assert.deepEqual(Object.keys(view).sort(), ['codebaseId', 'description', 'inputs', 'kind', 'message', 'posting', 'projects', 'rerunNotes', 'workflow', 'workflows'])
    // Choosing another workflow drops the inputs filled for this one.
    const edited = ready(((await mounted.worker.request('launch.edit', { workflow: 'orchon-recorder-echo' })) as LaunchAnswer).launch)
    assert.equal(edited.inputs, undefined)
    await mounted.worker.deactivate()
  })

  test('opens with the message filled, no workflow chosen and a notice naming the workflow when it is gone', async () => {
    const stage = rerunScene()
    const id = RECORDED['0.12.1'].completed
    stage.archon.answer(
      `${RUN_PATH}${id}`,
      changedRun('0.12.1', (run) => {
        run['workflow_name'] = 'a-removed-workflow'
        ;(run['metadata'] as Record<string, unknown>)['inputs'] = { item: 'x' }
      })
    )
    const mounted = await stage.mount(orcaWith('ws-local'))
    const view = ready((await rerun(mounted, id)).launch)
    assert.equal(view.codebaseId, RECORDED['0.12.1'].project)
    assert.equal(view.workflow, null)
    assert.equal(view.message, RECORDED_MESSAGE)
    assert.equal(view.inputs, undefined)
    assert.deepEqual(view.rerunNotes, ['The workflow a-removed-workflow is no longer listed for this project, so no workflow is chosen. Choose one.'])
    await mounted.worker.deactivate()
  })

  test('cuts a message over 16,000 characters to fit, with a notice', async () => {
    const stage = rerunScene()
    const id = RECORDED['0.12.1'].completed
    const long = `${'a'.repeat(15_999)}bcd`
    stage.archon.answer(
      `${RUN_PATH}${id}`,
      changedRun('0.12.1', (run) => {
        run['user_message'] = long
      })
    )
    const mounted = await stage.mount(orcaWith('ws-local'))
    const view = ready((await rerun(mounted, id)).launch)
    assert.equal(view.message, `${'a'.repeat(15_999)}b`)
    assert.deepEqual(view.rerunNotes, ["The run's message is longer than 16,000 characters, so it was cut to fit."])
    await mounted.worker.deactivate()
  })

  test('is refused, with the draft unchanged, for a failed run, a run with no project, a project Archon no longer lists and a remote workspace', async () => {
    const release: Release = '0.12.1'
    const id = RECORDED[release].completed
    const cases: { name: string; focused: string; answer: ReturnType<typeof json>; runId: string; refusal: string }[] = [
      { name: 'failed', focused: 'ws-local', answer: recorded(release, 'run-failed', 8) as ReturnType<typeof json>, runId: RECORDED[release].failed, refusal: 'Re-run is offered on completed and cancelled runs only.' },
      { name: 'no project', focused: 'ws-local', answer: changedRun(release, (run) => (run['codebase_id'] = null)), runId: id, refusal: 'This run has no Archon project, so it cannot be run again here.' },
      { name: 'not listed', focused: 'ws-local', answer: changedRun(release, (run) => (run['codebase_id'] = 'not-a-listed-project')), runId: id, refusal: 'Archon no longer lists that project. Choose another.' },
      { name: 'remote', focused: 'ws-ssh', answer: recorded(release, 'run-detail') as ReturnType<typeof json>, runId: id, refusal: 'This workspace is on another host. Orchon works with the Archon on this computer.' }
    ]
    for (const entry of cases) {
      const stage = rerunScene(release)
      stage.archon.answer(`${RUN_PATH}${entry.runId}`, entry.answer)
      const mounted = await stage.mount(orcaWith(entry.focused))
      await assert.rejects(rerun(mounted, entry.runId), (error: unknown) => error instanceof Error && error.message === entry.refusal)
      if (entry.focused === 'ws-local') {
        const view = ready(((await mounted.worker.request('launch.read', {})) as LaunchAnswer).launch)
        assert.equal(view.message, '', entry.name)
        assert.equal(view.codebaseId, null, entry.name)
      }
      assert.equal(stage.archon.calls.filter((call) => call.method !== 'GET').length, 0, entry.name)
      await mounted.worker.deactivate()
    }
  })

  test('refuses a request that is not one run id', async () => {
    const mounted = await rerunScene().mount(orcaWith('ws-local'))
    for (const input of [undefined, {}, { runId: '' }, { runId: 'x'.repeat(201) }, { runId: 'x', draft: { message: 'mine' } }]) {
      await assert.rejects(mounted.worker.request('launch.rerun', input as never))
    }
    await mounted.worker.deactivate()
  })
})
