// The worker's request protocol seam for Open graph: the worker mounted on a scripted Archon, a
// scripted disk and a stand-in Orca host. These tests cover when a wide tab may open, the pointer
// files the worker writes into `.orchon/`, the sweep, and what a failed write turns off.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, scene, type Scene } from '../scripts/scripted-archon.ts'
import type { RunDetailAnswer } from './run-detail-view'
import type { GraphOpenAnswer } from './wide-tabs'

const RUN_ID = '7c28e1a1-6432-4c9d-89d6-874cfaf81f89'
const RUN_URL = `${DEFAULT}/api/workflows/runs/${RUN_ID}`
const ROOT = 'C:/Projects/web'
const FOLDER = `${ROOT}/.orchon`
const POINTER = `${FOLDER}/orchon-recorder-echo-7c28e1a1.orchonrun`
const DAY = 24 * 60 * 60 * 1000

type Row = { id: string; kind: 'worktree' | 'folder'; name: string; projectId: string | null; path: string; branch: string | null; hostId: string | null }
const local: Row = { id: 'ws-web', kind: 'folder', name: 'web', projectId: null, path: ROOT, branch: null, hostId: 'local' }
const ssh: Row = { id: 'ws-ssh', kind: 'folder', name: 'far', projectId: null, path: '/srv/far', branch: null, hostId: 'ssh:far' }

function orcaWith(focused: string | null, rows: Row[] = [local, ssh]): MockHostOptions {
  return {
    results: {
      'workspace.readContext': focused === null ? null : { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] },
      'workspace.list': { workspaces: rows, truncated: false },
      'editor.open': { opened: true }
    }
  }
}

/** A connected scene whose Archon answers the recorded run of the floor. */
function runScene(run: ReturnType<typeof recorded> = recorded('0.12.1', 'run-detail')): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health())
  stage.archon.answer(RUN_URL, run)
  return stage
}

/** The recorded run with some fields of `run` changed. */
function changedRun(change: Record<string, unknown>): ReturnType<typeof recorded> {
  const answer = recorded('0.12.1', 'run-detail')
  if (answer.kind !== 'json') throw new Error('The recorded run is not JSON.')
  const value = answer.value as { run: Record<string, unknown> }
  return json({ ...value, run: { ...value.run, ...change } })
}

const open = async (stage: Scene, focused: string | null = 'ws-web') => {
  const mounted = await stage.mount(orcaWith(focused))
  const answer = (await mounted.worker.request('graph.open', { runId: RUN_ID })) as GraphOpenAnswer
  return { ...mounted, answer }
}

describe('Open graph', () => {
  test("writes the .gitignore and the run's pointer file into .orchon/, then opens it in the focused workspace", async () => {
    const stage = runScene()
    const { worker, host, answer } = await open(stage)
    assert.deepEqual(answer, { opened: true })
    assert.equal(stage.disk.files.get(`${FOLDER}/.gitignore`), '*\n')
    assert.deepEqual(JSON.parse(stage.disk.files.get(POINTER) ?? ''), { orchon: 'run-graph', runId: RUN_ID })
    assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: '.orchon/orchon-recorder-echo-7c28e1a1.orchonrun' }])
    // Every write is inside .orchon/.
    for (const write of stage.disk.writes) assert.ok(write.split(' ')[1]?.startsWith(FOLDER), write)
    await worker.deactivate()
  })

  test('opening the run again opens the same file, so Orca lands on its tab; another run gets its own', async () => {
    const stage = runScene()
    const other = '9ab0c1d2-0000-4000-8000-000000000000'
    stage.archon.answer(`${DEFAULT}/api/workflows/runs/${other}`, changedRun({ id: other }))
    const { worker, host } = await open(stage)
    await worker.request('graph.open', { runId: RUN_ID })
    await worker.request('graph.open', { runId: other })
    assert.deepEqual(
      host.callsOf('editor.open').map((call) => (call as { path: string }).path),
      ['.orchon/orchon-recorder-echo-7c28e1a1.orchonrun', '.orchon/orchon-recorder-echo-7c28e1a1.orchonrun', '.orchon/orchon-recorder-echo-9ab0c1d2.orchonrun']
    )
    await worker.deactivate()
  })

  test('is refused, with the reason and nothing written, when no workspace is focused', async () => {
    const stage = runScene()
    const { worker, host, answer } = await open(stage, null)
    assert.deepEqual(answer, { opened: false, reason: 'No workspace is focused in Orca. Wide tabs open in a workspace on this computer.' })
    assert.deepEqual(stage.disk.writes, [])
    assert.deepEqual(host.callsOf('editor.open'), [])
    await worker.deactivate()
  })

  test('is refused in a remote workspace', async () => {
    const stage = runScene()
    const { worker, answer } = await open(stage, 'ws-ssh')
    assert.deepEqual(answer, { opened: false, reason: 'This workspace is on another host. Orchon works with the Archon on this computer.' })
    assert.deepEqual(stage.disk.writes, [])
    await worker.deactivate()
  })

  test('is refused for a run with no project', async () => {
    const stage = runScene(changedRun({ codebase_id: null }))
    const { worker, answer } = await open(stage)
    assert.deepEqual(answer, { opened: false, reason: 'This run has no Archon project, so it has no graph.' })
    assert.deepEqual(stage.disk.writes, [])
    await worker.deactivate()
  })

  test('refuses a run id that is not text of 1 to 200 characters', async () => {
    const { worker } = await runScene().mount(orcaWith('ws-web'))
    for (const runId of ['', 7, 'x'.repeat(201)]) {
      await assert.rejects(worker.request('graph.open', { runId } as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await worker.deactivate()
  })
})

describe('the sweep of .orchon/', () => {
  /** A folder holding `count` old run pointer files, the Nth newest `N` days old, and two files of someone else. */
  function seeded(stage: Scene, ages: number[]): void {
    stage.disk.folders.add(FOLDER)
    stage.disk.files.set(`${FOLDER}/.gitignore`, '*\n')
    stage.disk.files.set(`${FOLDER}/notes.txt`, 'mine')
    stage.disk.modified.set(`${FOLDER}/notes.txt`, stage.clock.now() - 90 * DAY)
    stage.disk.files.set(`${FOLDER}/old.orchonrun.bak`, 'mine')
    stage.disk.modified.set(`${FOLDER}/old.orchonrun.bak`, stage.clock.now() - 90 * DAY)
    ages.forEach((age, index) => {
      const path = `${FOLDER}/flow-${String(index).padStart(8, '0')}.orchonrun`
      stage.disk.files.set(path, '{}')
      stage.disk.modified.set(path, stage.clock.now() - age * DAY)
    })
  }
  const pointerFiles = (stage: Scene): string[] =>
    [...stage.disk.files.keys()].filter((path) => path.endsWith('.orchonrun') || path.endsWith('.orchonflow')).sort()

  test('on start, deletes its own pointer files older than 7 days in the focused workspace, and nothing else', async () => {
    const stage = runScene()
    seeded(stage, [1, 8, 30])
    const { worker } = await stage.mount(orcaWith('ws-web'))
    assert.deepEqual(pointerFiles(stage), [`${FOLDER}/flow-00000000.orchonrun`])
    assert.equal(stage.disk.files.get(`${FOLDER}/notes.txt`), 'mine')
    assert.equal(stage.disk.files.get(`${FOLDER}/old.orchonrun.bak`), 'mine')
    assert.equal(stage.disk.files.get(`${FOLDER}/.gitignore`), '*\n')
    await worker.deactivate()
  })

  test('on each write, keeps at most the newest 20, the one just written included', async () => {
    const stage = runScene()
    seeded(stage, Array.from({ length: 22 }, (_, index) => index / 10))
    const { worker, answer } = await open(stage)
    assert.deepEqual(answer, { opened: true })
    const left = pointerFiles(stage)
    assert.equal(left.length, 20)
    assert.ok(left.includes(POINTER))
    assert.ok(!left.includes(`${FOLDER}/flow-00000019.orchonrun`))
    assert.ok(left.includes(`${FOLDER}/flow-00000018.orchonrun`))
    assert.equal(stage.disk.files.get(`${FOLDER}/notes.txt`), 'mine')
    await worker.deactivate()
  })
})

describe('a failed write', () => {
  test('turns the wide tabs off for that workspace and says why', async () => {
    const stage = runScene()
    stage.disk.failWrites = true
    const { worker, host, answer } = await open(stage)
    const reason = 'Orchon could not write its tab file into .orchon/ in this workspace, so wide tabs are off here until Orca restarts the plugin.'
    assert.deepEqual(answer, { opened: false, reason })
    stage.disk.failWrites = false
    const again = (await worker.request('graph.open', { runId: RUN_ID })) as GraphOpenAnswer
    assert.deepEqual(again, { opened: false, reason })
    assert.deepEqual(host.callsOf('editor.open'), [])
    await worker.deactivate()
  })
})

describe('run detail says why Open graph is off', () => {
  const graphOff = async (stage: Scene, focused: string | null): Promise<unknown> => {
    const { worker } = await stage.mount(orcaWith(focused))
    const answer = (await worker.request('run.read', { runId: RUN_ID })) as RunDetailAnswer
    await worker.deactivate()
    assert.ok(answer.run.kind === 'ready')
    return Object.hasOwn(answer, 'graphOff') ? answer.graphOff : 'left out'
  }

  test('it is left out when a local workspace is focused and the run has a project', async () => {
    assert.equal(await graphOff(runScene(), 'ws-web'), 'left out')
  })

  test('with no workspace focused, in a remote workspace and for a run with no project', async () => {
    assert.equal(await graphOff(runScene(), null), 'No workspace is focused in Orca. Wide tabs open in a workspace on this computer.')
    assert.equal(await graphOff(runScene(), 'ws-ssh'), 'This workspace is on another host. Orchon works with the Archon on this computer.')
    assert.equal(await graphOff(runScene(changedRun({ codebase_id: null })), 'ws-web'), 'This run has no Archon project, so it has no graph.')
  })

  test('after a failed write in that workspace', async () => {
    const stage = runScene()
    stage.disk.failWrites = true
    const { worker } = await stage.mount(orcaWith('ws-web'))
    await worker.request('graph.open', { runId: RUN_ID })
    const answer = (await worker.request('run.read', { runId: RUN_ID })) as RunDetailAnswer
    assert.ok(answer.run.kind === 'ready')
    assert.match(answer.graphOff ?? '', /^Orchon could not write its tab file/)
    await worker.deactivate()
  })
})
