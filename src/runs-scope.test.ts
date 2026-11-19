// The worker's request protocol seam: the runs table's request under the project scope. Under
// "This project" a frame sends the project's id and the worker filters Archon's runs by it; a
// run whose worktree Orca lists carries that workspace, so the preview can offer Open in Orca.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, scene, type Scene, urls } from '../scripts/scripted-archon.ts'
import type { RunsAnswer } from './runs-view'

const RUNS = `${DEFAULT}/api/dashboard/runs`

function connectedScene(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health())
  return stage
}

/** The recorded run of the floor, as Archon sent it. */
function recordedRun(): Record<string, unknown> {
  const answer = recorded('0.12.1', 'dashboard-runs')
  if (answer.kind !== 'json') throw new Error('The recorded dashboard runs are not JSON.')
  const [run] = (answer.value as { runs: Record<string, unknown>[] }).runs
  if (run === undefined) throw new Error('The recorded dashboard runs hold no run.')
  return run
}

const COUNTS = { all: 2, running: 0, paused: 0, pending: 0, completed: 2, failed: 0, cancelled: 0 }

const withWorkspaces = (workspaces: unknown[]): MockHostOptions => ({ results: { 'workspace.list': { workspaces, truncated: false } } })

describe('the runs table under the project scope', () => {
  test("sends the project's id as codebaseId, beside the status filter", async () => {
    const stage = connectedScene()
    const url = `${RUNS}?status=failed&codebaseId=cd8c6f17a56a08ff6e8c24143751f5c4&limit=50&offset=0`
    stage.archon.answer(url, recorded('0.12.1', 'dashboard-runs-empty'))
    const { worker } = await stage.mount()
    const answer = (await worker.request('runs.read', { status: 'failed', rows: 25, codebaseId: 'cd8c6f17a56a08ff6e8c24143751f5c4' })) as RunsAnswer
    assert.equal(answer.runs.kind, 'ready')
    assert.deepEqual(
      urls(stage).filter((called) => called.startsWith(RUNS)),
      [url]
    )
    await worker.deactivate()
  })

  test('refuses a codebaseId that is not text of 1 to 200 characters', async () => {
    const { worker } = await connectedScene().mount()
    for (const codebaseId of ['', 7, null, 'x'.repeat(201)]) {
      await assert.rejects(
        worker.request('runs.read', { status: 'all', rows: 25, codebaseId } as never),
        (error: unknown) => (error as { code?: string }).code === 'invalid_params'
      )
    }
    await worker.deactivate()
  })

  test("a run whose working_path a workspace.list row names, after normalising, carries that row's workspace", async () => {
    const stage = connectedScene()
    const run = recordedRun()
    stage.archon.answer(
      `${RUNS}?limit=50&offset=0`,
      json({
        runs: [
          { ...run, id: 'shown', working_path: 'C:\\Users\\ada\\.archon\\workspaces\\acme\\web\\worktrees\\archon\\task-1' },
          { ...run, id: 'hidden', working_path: 'C:\\Users\\ada\\.archon\\workspaces\\acme\\web\\worktrees\\archon\\task-2' }
        ],
        total: 2,
        counts: COUNTS
      })
    )
    const { worker } = await stage.mount(
      withWorkspaces([
        { id: 'ws-task-1', kind: 'worktree', name: 'task-1', projectId: 'p', path: 'c:/users/ada/.archon/workspaces/acme/web/worktrees/archon/task-1/', branch: 'x', hostId: 'local' }
      ])
    )
    const answer = (await worker.request('runs.read', { status: 'all', rows: 25 })) as RunsAnswer
    assert.ok(answer.runs.kind === 'ready')
    const [shown, hidden] = answer.runs.rows
    assert.equal(shown?.workspaceId, 'ws-task-1')
    assert.ok(hidden !== undefined && !Object.hasOwn(hidden, 'workspaceId'))
    // No check is made that a worktree folder exists: the closed disk list of #32 has none.
    assert.ok(!stage.disk.asked.some((path) => path.includes('worktrees')))
    await worker.deactivate()
  })

  test('when Orca does not list its workspaces, the runs are still answered without one', async () => {
    const stage = connectedScene()
    stage.archon.answer(`${RUNS}?limit=50&offset=0`, recorded('0.12.1', 'dashboard-runs'))
    const { worker } = await stage.mount()
    const answer = (await worker.request('runs.read', { status: 'all', rows: 25 })) as RunsAnswer
    assert.ok(answer.runs.kind === 'ready')
    assert.equal(answer.runs.rows.length, 1)
    assert.ok(!Object.hasOwn(answer.runs.rows[0] ?? {}, 'workspaceId'))
    await worker.deactivate()
  })
})
