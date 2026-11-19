// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, and a stand-in Orca host that answers the workspace methods. These tests
// cover the Launch section: the form's lists, Start and its refusals, the posts Archon is sent,
// and how the worker finds the run a launch started.
import { assert, describe, test, type MockHostOptions } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  health,
  HANG,
  json,
  openStream,
  recorded,
  recordedRequest,
  RELEASES,
  scene,
  type MountedScene,
  type Release,
  type Scene,
  type Scripted
} from '../scripts/scripted-archon.ts'
import { field } from '../scripts/shape.ts'
import { readRepoText } from '../scripts/repo-files.ts'
import type { LaunchAnswer, LaunchView, NoticesAnswer } from './launch-view'

const CODEBASES = `${DEFAULT}/api/codebases`
const CONVERSATIONS = `${DEFAULT}/api/conversations`
const STREAM = `${DEFAULT}/api/stream/__dashboard__`

/** The id of the one project each release's recording holds. Read off the fixtures by hand. */
const RECORDED_ID: Record<Release, string> = {
  '0.12.1': 'cd8c6f17a56a08ff6e8c24143751f5c4',
  '0.13.2': '6feec5b110ac5147f1d58ffa49d2790c',
  '0.14.0': '4fb57f7e8043f7efd57270977e68c598'
}
const RECORDED_NAME = 'orchon-recorder/throwaway-project'
/** The recorded project's folder as the recordings scrubbed it. */
const RECORDED_CWD = '<project-path>'
const ECHO = 'orchon-recorder-echo'

const workflowsUrl = (cwd: string): string => `${DEFAULT}/api/workflows?${new URLSearchParams({ cwd }).toString()}`
const runsUrl = (id: string): string => `${DEFAULT}/api/dashboard/runs?codebaseId=${id}&limit=50&offset=0`

type Row = { id: string; kind: 'worktree' | 'folder'; name: string; projectId: string | null; path: string; branch: string | null; hostId: string | null }
const local: Row = { id: 'ws-local', kind: 'folder', name: 'web', projectId: null, path: 'C:/Projects/web', branch: null, hostId: 'local' }
const sshRow: Row = { id: 'ws-ssh', kind: 'folder', name: 'box', projectId: null, path: '/srv/web', branch: null, hostId: 'ssh:box' }

/** The host with one focused workspace. */
function orcaWith(focused: string | null, storage: MockHostOptions['storage'] = {}): MockHostOptions {
  return {
    storage,
    results: {
      'workspace.readContext': focused === null ? null : { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] },
      'workspace.list': { workspaces: [local, sshRow], truncated: false }
    }
  }
}

/** One recorded scenario's log. */
function logOf(release: Release, scenario: string): Record<string, unknown>[] {
  return field(JSON.parse(readRepoText(`fixtures/${release}/${scenario}.json`)), 'log') as Record<string, unknown>[]
}

/** The index in a recorded log of the first HTTP exchange with this method and path. */
function exchange(release: Release, scenario: string, method: string, path: string | RegExp): number {
  const index = logOf(release, scenario).findIndex(
    (entry) => entry['kind'] === 'http' && entry['method'] === method && (typeof path === 'string' ? entry['path'] === path : path.test(String(entry['path'])))
  )
  if (index < 0) throw new Error(`fixtures/${release}/${scenario}.json has no ${method} ${String(path)}.`)
  return index
}

/** A connected scene listing the recorded project and its recorded workflows. */
function launchScene(release: Release = '0.12.1', storeId?: string): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health(storeId === undefined ? { version: release } : { version: release, storeId }))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  stage.archon.answer(workflowsUrl(RECORDED_CWD), recorded(release, 'workflows'))
  return stage
}

const ready = (view: LaunchView): Extract<LaunchView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The launcher is ${view.kind}.`)
  return view
}

async function read(mounted: MountedScene, input: Record<string, unknown> = {}): Promise<LaunchAnswer> {
  return (await mounted.worker.request('launch.read', input)) as LaunchAnswer
}

describe('the launch form', () => {
  for (const release of RELEASES) {
    test(`lists the recorded project and its workflows of ${release}, read from its default_cwd, with no node definitions`, async () => {
      const stage = launchScene(release)
      const mounted = await stage.mount(orcaWith('ws-local'))
      const answer = await read(mounted, { project: RECORDED_ID[release], reload: true })
      const view = ready(answer.launch)
      assert.deepEqual(view.projects, { rows: [{ id: RECORDED_ID[release], name: RECORDED_NAME }], more: 0, unreadable: 0 })
      assert.equal(view.codebaseId, RECORDED_ID[release])
      assert.ok(stage.archon.calls.some((call) => call.url === workflowsUrl(RECORDED_CWD)))
      if (view.workflows.kind !== 'ready') throw new Error(view.workflows.kind)
      const echo = view.workflows.rows.find((row) => row.name === ECHO)
      assert.ok(echo)
      assert.equal(echo.source, 'project')
      assert.deepEqual(Object.keys(echo).sort(), ['description', 'name', 'recommended', 'source'])
      // The recordings recommend nothing, so the rows are by name.
      const names = view.workflows.rows.map((row) => row.name)
      assert.deepEqual(names, [...names].sort())
      assert.equal(view.workflows.total, view.workflows.rows.length)
      assert.ok(!JSON.stringify(answer).includes('"nodes"'))
      // Nothing was launched, so nothing is chosen and nothing is posted.
      assert.equal(view.workflow, null)
      assert.equal(stage.archon.calls.filter((call) => call.method !== 'GET').length, 0)
      await mounted.worker.deactivate()
    })
  }
})

/** The recorded launch's three answers: the conversation, the run post and the project's runs. */
function replayAccepted(stage: Scene, release: Release): { conversationId: string; runId: string } {
  const created = exchange(release, 'launch-accepted', 'POST', '/api/conversations')
  const run = exchange(release, 'launch-accepted', 'POST', `/api/workflows/${ECHO}/run`)
  stage.archon.answer(CONVERSATIONS, recorded(release, 'launch-accepted', created))
  stage.archon.answer(`${DEFAULT}/api/workflows/${ECHO}/run`, recorded(release, 'launch-accepted', run))
  const body = recordedRequest(release, 'launch-accepted', run)
  const conversationId = String(field(body, 'conversationId'))
  const runs = recorded(release, 'dashboard-runs', 2)
  const runId = String(field((field(runs.kind === 'json' ? runs.value : null, 'runs') as unknown[])[0], 'id'))
  return { conversationId, runId }
}

const recordedMessage = (release: Release): string =>
  String(field(recordedRequest(release, 'launch-accepted', exchange(release, 'launch-accepted', 'POST', `/api/workflows/${ECHO}/run`)), 'message'))

/** Every write the worker sent, as method, path and body. */
const writes = (stage: Scene): { method: string; path: string; body: unknown }[] =>
  stage.archon.calls
    .filter((call) => call.method !== 'GET')
    .map((call) => ({ method: call.method, path: new URL(call.url).pathname, body: call.body === undefined ? null : (JSON.parse(call.body) as unknown) }))

async function start(mounted: MountedScene, release: Release, message = recordedMessage(release)): Promise<LaunchAnswer> {
  await read(mounted, { project: RECORDED_ID[release], reload: true })
  return (await mounted.worker.request('launch.start', { codebaseId: RECORDED_ID[release], workflow: ECHO, message })) as LaunchAnswer
}

describe('an accepted launch, replayed from the recordings', () => {
  for (const release of RELEASES) {
    test(`${release}: creates a conversation, posts the run once with the recorded body, and finds the run by its conversation`, async () => {
      const stage = launchScene(release, 'store-1')
      const { conversationId, runId } = replayAccepted(stage, release)
      const mounted = await stage.mount(orcaWith('ws-local'))
      const answer = await start(mounted, release)
      // The bodies are the recorded ones, key for key.
      assert.equal(ready(answer.launch).error, undefined)
      assert.deepEqual(writes(stage), [
        { method: 'POST', path: '/api/conversations', body: recordedRequest(release, 'launch-accepted', exchange(release, 'launch-accepted', 'POST', '/api/conversations')) },
        { method: 'POST', path: `/api/workflows/${ECHO}/run`, body: { conversationId, message: recordedMessage(release) } }
      ])
      const view = ready(answer.launch)
      assert.deepEqual(view.starting, { launchId: view.starting?.launchId ?? '', workflow: ECHO, project: RECORDED_NAME, state: 'started', late: false })
      assert.equal(view.message, '')
      assert.deepEqual(mounted.host.data().storage['launch-conversations'], { 'store-1': [conversationId] })
      assert.deepEqual(mounted.host.data().storage['launch-last-workflow'], { 'store-1': { [RECORDED_ID[release]]: ECHO } })
      // Nothing is found until the project's runs list the launch: 2 seconds later they do.
      stage.archon.answer(runsUrl(RECORDED_ID[release]), recorded(release, 'dashboard-runs', 2))
      await stage.clock.advance(2_000)
      const found = ready((await read(mounted)).launch)
      assert.equal(found.starting?.state, 'found')
      assert.equal(found.starting?.runId, runId)
      assert.ok(mounted.worker.posts.some((post) => post.event === 'launch.changed'))
      // Found, it looks no more.
      const looks = stage.archon.calls.filter((call) => call.url === runsUrl(RECORDED_ID[release])).length
      await stage.clock.advance(60_000)
      assert.equal(stage.archon.calls.filter((call) => call.url === runsUrl(RECORDED_ID[release])).length, looks)
      await mounted.worker.deactivate()
    })
  }

  test('the workflow last launched in a project is its default next time', async () => {
    const stage = launchScene('0.12.1')
    const mounted = await stage.mount(orcaWith('ws-local', { 'launch-last-workflow': { [DEFAULT]: { [RECORDED_ID['0.12.1']]: ECHO } } }))
    assert.equal(ready((await read(mounted, { project: RECORDED_ID['0.12.1'] })).launch).workflow, ECHO)
    await mounted.worker.deactivate()
  })
})
