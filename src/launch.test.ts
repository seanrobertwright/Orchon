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
  type Scene
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

describe('a refused launch, replayed from the recordings', () => {
  for (const release of RELEASES) {
    test(`${release}: a 400 shows Archon's words on the form with every value kept, and the conversation it made is deleted`, async () => {
      const stage = launchScene(release)
      const created = exchange(release, 'launch-empty-message', 'POST', '/api/conversations')
      const run = exchange(release, 'launch-empty-message', 'POST', `/api/workflows/${ECHO}/run`)
      const conversationId = String(field(recordedRequest(release, 'launch-empty-message', run), 'conversationId'))
      const deleted = exchange(release, 'launch-empty-message', 'DELETE', `/api/conversations/${conversationId}`)
      stage.archon.answer(CONVERSATIONS, recorded(release, 'launch-empty-message', created))
      stage.archon.answer(`${DEFAULT}/api/workflows/${ECHO}/run`, recorded(release, 'launch-empty-message', run))
      stage.archon.answer(`${CONVERSATIONS}/${conversationId}`, recorded(release, 'launch-empty-message', deleted))
      const words = String(field(field(logOf(release, 'launch-empty-message')[run], 'body'), 'error'))
      const mounted = await stage.mount(orcaWith('ws-local'))
      // The recording's message was empty; the worker sends only one with words, so this one is
      // typed and Archon is scripted to refuse it as it refused the recorded one.
      const message = '  Typed, with spaces kept.  '
      const view = ready((await start(mounted, release, message)).launch)
      assert.equal(view.error, words)
      assert.equal(view.starting, undefined)
      assert.deepEqual([view.codebaseId, view.workflow, view.message], [RECORDED_ID[release], ECHO, message])
      assert.deepEqual(
        writes(stage).map((call) => `${call.method} ${call.path}`),
        ['POST /api/conversations', `POST /api/workflows/${ECHO}/run`, `DELETE /api/conversations/${conversationId}`]
      )
      assert.deepEqual(writes(stage)[1]?.body, { conversationId, message })
      await mounted.worker.deactivate()
    })
  }
})

describe('Start', () => {
  const release: Release = '0.12.1'
  const id = RECORDED_ID[release]
  const press = (mounted: MountedScene, fields: Record<string, unknown> = {}): Promise<LaunchAnswer> =>
    mounted.worker.request('launch.start', { codebaseId: id, workflow: ECHO, message: 'Run it.', ...fields }) as Promise<LaunchAnswer>

  test('a launch call that times out is not sent again, and the Starting view says the worker is looking for the run', async () => {
    const stage = launchScene(release)
    replayAccepted(stage, release)
    stage.archon.answer(`${DEFAULT}/api/workflows/${ECHO}/run`, HANG)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: id, reload: true })
    const pending = press(mounted)
    // A second press while the first is posted is ignored: nothing more is sent.
    await stage.clock.advance(1_000)
    const second = ready((await press(mounted)).launch)
    assert.equal(second.posting, true)
    await stage.clock.advance(30_000)
    const view = ready((await pending).launch)
    assert.equal(view.starting?.state, 'looking')
    await stage.clock.advance(120_000)
    assert.deepEqual(
      writes(stage).map((call) => `${call.method} ${call.path}`),
      ['POST /api/conversations', `POST /api/workflows/${ECHO}/run`]
    )
    await mounted.worker.deactivate()
  })

  test('is refused, with nothing sent, while not Connected, in a remote workspace, or with no workspace focused', async () => {
    const offline = scene()
    const down = await offline.mount(orcaWith('ws-local'))
    assert.equal(ready_or_error(await press(down)), 'not-connected')
    assert.deepEqual(writes(offline), [])
    await down.worker.deactivate()
    for (const [focused, kind] of [['ws-ssh', 'remote'], [null, 'Focus a local workspace in Orca to launch a run.']] as const) {
      const stage = launchScene(release)
      replayAccepted(stage, release)
      const mounted = await stage.mount(orcaWith(focused))
      const answer = await press(mounted)
      assert.equal(answer.launch.kind === 'ready' ? answer.launch.error : answer.launch.kind, kind)
      assert.deepEqual(writes(stage), [])
      await mounted.worker.deactivate()
    }
  })

  test('is refused when Archon no longer lists the project or the workflow is not in its list', async () => {
    const stage = launchScene(release)
    replayAccepted(stage, release)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: id, reload: true })
    assert.equal(ready_or_error(await press(mounted, { codebaseId: 'cb-gone' })), 'Archon no longer lists that project. Choose another.')
    assert.equal(ready_or_error(await press(mounted, { workflow: 'not-a-workflow' })), 'Archon does not list that workflow for this project. Refresh and choose another.')
    assert.equal(ready_or_error(await press(mounted, { message: '   ' })), 'Type a message.')
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })

  test('refuses a message past 16,000 characters, or a key it does not take', async () => {
    const stage = launchScene(release)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await assert.rejects(press(mounted, { message: 'x'.repeat(16_001) }))
    await assert.rejects(press(mounted, { config: { a: 'b' } }))
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })
})

function ready_or_error(answer: LaunchAnswer): string | undefined {
  return answer.launch.kind === 'ready' ? answer.launch.error : answer.launch.kind
}

describe('looking for the run', () => {
  const release: Release = '0.12.1'
  const id = RECORDED_ID[release]
  const looks = (stage: Scene): number => stage.archon.calls.filter((call) => call.url === runsUrl(id)).length
  /** The project's runs before the launch's run is among them: the recorded empty list. */
  const noRunYet = (stage: Scene): void => stage.archon.answer(runsUrl(id), recorded(release, 'dashboard-runs-empty', 0))

  test('every 2 seconds for 30 seconds, then every 10; with no run after 60 seconds it offers "Keep waiting", which looks 60 seconds more', async () => {
    const stage = launchScene(release)
    replayAccepted(stage, release)
    noRunYet(stage)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await start(mounted, release)
    await stage.clock.advance(30_000)
    assert.equal(looks(stage), 15)
    await stage.clock.advance(20_000)
    assert.equal(looks(stage), 17)
    assert.equal(ready((await read(mounted)).launch).starting?.late, false)
    await stage.clock.advance(10_000)
    const late = ready((await read(mounted)).launch).starting
    assert.equal(late?.late, true)
    await stage.clock.advance(60_000)
    assert.equal(looks(stage), 18)
    const kept = ready(((await mounted.worker.request('launch.wait', { launchId: late?.launchId ?? '' })) as LaunchAnswer).launch)
    assert.equal(kept.starting?.late, false)
    await stage.clock.advance(60_000)
    assert.equal(looks(stage), 24)
    assert.equal(ready((await read(mounted)).launch).starting?.late, true)
    await mounted.worker.deactivate()
  })

  test('a launch queued for a free slot waits with no limit', async () => {
    const stage = launchScene(release)
    replayAccepted(stage, release)
    stage.archon.answer(`${DEFAULT}/api/workflows/${ECHO}/run`, json({ accepted: true, status: 'queued-capacity' }))
    noRunYet(stage)
    const mounted = await stage.mount(orcaWith('ws-local'))
    assert.equal(ready((await start(mounted, release)).launch).starting?.state, 'queued')
    await stage.clock.advance(600_000)
    const view = ready((await read(mounted)).launch)
    assert.equal(view.starting?.late, false)
    assert.equal(looks(stage), 15 + 57)
    await mounted.worker.deactivate()
  })

  test('a launch whose call timed out keeps looking with no limit, and never offers "Keep waiting"', async () => {
    const stage = launchScene(release)
    replayAccepted(stage, release)
    stage.archon.answer(`${DEFAULT}/api/workflows/${ECHO}/run`, HANG)
    noRunYet(stage)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: id, reload: true })
    const pending = mounted.worker.request('launch.start', { codebaseId: id, workflow: ECHO, message: 'Run it.' }) as Promise<LaunchAnswer>
    await stage.clock.advance(30_000)
    assert.equal(ready((await pending).launch).starting?.state, 'looking')
    const before = looks(stage)
    await stage.clock.advance(600_000)
    const view = ready((await read(mounted)).launch)
    assert.equal(view.starting?.state, 'looking')
    assert.equal(view.starting?.late, false)
    assert.ok(looks(stage) >= before + 60)
    await mounted.worker.deactivate()
  })

  test('looks on every dashboard hint, and takes the row that names the conversation by its own id alone', async () => {
    const stage = launchScene(release)
    const { runId } = replayAccepted(stage, release)
    const stream = openStream()
    stage.archon.answer(STREAM, stream)
    noRunYet(stage)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await start(mounted, release)
    await stage.clock.advance(500)
    assert.equal(looks(stage), 0)
    // The recorded row, with its platform id taken away: the conversation's own id still names it.
    const page = recorded(release, 'dashboard-runs', 2)
    if (page.kind !== 'json') throw new Error('The recorded runs are not JSON.')
    const row = { ...((field(page.value, 'runs') as Record<string, unknown>[])[0] ?? {}), parent_platform_id: null }
    stage.archon.answer(runsUrl(id), json({ ...(page.value as Record<string, unknown>), runs: [row] }))
    stream.send(`data: ${JSON.stringify({ type: 'workflow_status', runId, workflowName: ECHO, status: 'running', timestamp: 1 })}\n\n`)
    await stage.clock.advance(100)
    assert.equal(looks(stage), 1)
    assert.equal(ready((await read(mounted)).launch).starting?.runId, runId)
    await mounted.worker.deactivate()
  })
})

describe('the callouts and the records', () => {
  const release: Release = '0.12.1'
  const id = RECORDED_ID[release]

  test('a run found after "Launch another" is a notice until dismissed', async () => {
    const stage = launchScene(release)
    const { runId } = replayAccepted(stage, release)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await start(mounted, release)
    const form = ready(((await mounted.worker.request('launch.another')) as LaunchAnswer).launch)
    assert.equal(form.starting, undefined)
    assert.equal(form.workflow, ECHO)
    stage.archon.answer(runsUrl(id), recorded(release, 'dashboard-runs', 2))
    await stage.clock.advance(2_000)
    const notices = (await mounted.worker.request('launch.notices')) as NoticesAnswer
    assert.deepEqual(notices.notices.map((notice) => [notice.workflow, notice.runId]), [[ECHO, runId]])
    assert.equal(notices.looking, 0)
    const after = (await mounted.worker.request('launch.dismiss', { launchId: notices.notices[0]?.launchId ?? '' })) as NoticesAnswer
    assert.deepEqual(after.notices, [])
    await mounted.worker.deactivate()
  })

  test('keeps at most 20 launch records, and the newest 500 conversation ids in plugin storage', async () => {
    const stage = launchScene(release)
    const { conversationId } = replayAccepted(stage, release)
    stage.archon.answer(runsUrl(id), recorded(release, 'dashboard-runs-empty', 0))
    const older = Array.from({ length: 500 }, (_, index) => `web-older-${String(index)}`)
    const mounted = await stage.mount(orcaWith('ws-local', { 'launch-conversations': { [DEFAULT]: older } }))
    await read(mounted, { project: id, reload: true })
    for (let count = 0; count < 21; count += 1) {
      await mounted.worker.request('launch.another')
      await mounted.worker.request('launch.start', { codebaseId: id, workflow: ECHO, message: `Run ${String(count)}.` })
    }
    const looking = (await mounted.worker.request('launch.notices')) as NoticesAnswer
    assert.equal(looking.looking, 20)
    const stored = field(mounted.host.data().storage['launch-conversations'], DEFAULT) as string[]
    assert.equal(stored.length, 500)
    // Every launch here got the one recorded conversation, so it is the newest, once.
    assert.equal(stored[0], conversationId)
    assert.equal(stored[1], 'web-older-0')
    await mounted.worker.deactivate()
  })
})

describe('the workflow list', () => {
  const release: Release = '0.12.1'
  const id = RECORDED_ID[release]

  test('past 32 MiB says it is too large and lists nothing', async () => {
    const stage = launchScene(release)
    const chunk = new Uint8Array(1024 * 1024).fill(32)
    stage.archon.answer(workflowsUrl(RECORDED_CWD), { kind: 'chunks', chunks: Array.from({ length: 33 }, () => chunk) })
    const mounted = await stage.mount(orcaWith('ws-local'))
    const view = ready((await read(mounted, { project: id, reload: true })).launch)
    assert.deepEqual(view.workflows, { kind: 'too-large' })
    assert.equal(view.workflow, null)
    await mounted.worker.deactivate()
  })

  test('is read again on reload only, and filters in the worker', async () => {
    const stage = launchScene(release)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: id, reload: true })
    const reads = (): number => stage.archon.calls.filter((call) => call.url === workflowsUrl(RECORDED_CWD)).length
    const filtered = ready((await read(mounted, { project: id, filter: 'RECORDER' })).launch)
    assert.equal(reads(), 1)
    if (filtered.workflows.kind !== 'ready') throw new Error(filtered.workflows.kind)
    assert.deepEqual(
      filtered.workflows.rows.map((row) => row.name),
      ['orchon-recorder-echo', 'orchon-recorder-fail', 'orchon-recorder-gate', 'orchon-recorder-inputs', 'orchon-recorder-slow']
    )
    assert.equal(filtered.workflows.matching, 5)
    await read(mounted, { project: id, reload: true })
    assert.equal(reads(), 2)
    await mounted.worker.deactivate()
  })

  test('the project select lists the first 200 by name, searched in the worker, and says how many more there are', async () => {
    const stage = launchScene(release)
    const many = Array.from({ length: 250 }, (_, index) => ({ id: `cb-${String(index)}`, name: `p-${String(index).padStart(3, '0')}`, default_cwd: `C:/p/${String(index)}` }))
    stage.archon.answer(CODEBASES, json(many))
    const mounted = await stage.mount(orcaWith('ws-local'))
    const all = ready((await read(mounted, { reload: true })).launch)
    assert.equal(all.projects.rows.length, 200)
    assert.equal(all.projects.more, 50)
    assert.equal(all.projects.rows[0]?.name, 'p-000')
    assert.equal(all.codebaseId, null)
    assert.deepEqual(all.workflows, { kind: 'none' })
    const searched = ready((await read(mounted, { search: 'p-24' })).launch)
    assert.deepEqual(
      searched.projects.rows.map((row) => row.name),
      ['p-240', 'p-241', 'p-242', 'p-243', 'p-244', 'p-245', 'p-246', 'p-247', 'p-248', 'p-249']
    )
    assert.equal(searched.projects.more, 0)
    await mounted.worker.deactivate()
  })
})

describe('declared inputs', () => {
  const release: Release = '0.12.1'
  const id = RECORDED_ID[release]
  const INPUTS = 'orchon-recorder-inputs'

  async function choose(mounted: MountedScene, workflow: string): Promise<Extract<LaunchView, { kind: 'ready' }>> {
    await read(mounted, { project: id, reload: true })
    return ready(((await mounted.worker.request('launch.edit', { workflow })) as LaunchAnswer).launch)
  }

  test('the chosen workflow brings its declared inputs in declared order, with the default as placeholder', async () => {
    const stage = launchScene(release)
    const mounted = await stage.mount(orcaWith('ws-local'))
    assert.deepEqual((await choose(mounted, INPUTS)).inputs, { kind: 'ready', rows: [{ name: 'item', required: true, description: 'Any text.', placeholder: '' }] })
    const queue = (await choose(mounted, 'archon-build-queue')).inputs
    if (queue.kind !== 'ready') throw new Error(queue.kind)
    // Declared order, read off the recorded workflow by hand.
    assert.deepEqual(queue.rows.map((row) => row.name), ['repo_host', 'repo_path', 'order', 'round_limit', 'mode', 'number', 'replay', 'as_of'])
    assert.deepEqual(queue.rows[2], {
      name: 'order',
      required: false,
      description: 'Pickup order, intake\'s format: a JSON array of "<key> <asc|desc>" with keys urgency, importance, size, complexity and created.',
      placeholder: '["urgency desc","importance desc","size asc","created asc"]'
    })
    assert.equal(ready((await read(mounted)).launch).inputs.kind, 'ready')
    await mounted.worker.deactivate()
  })

  test('a default that is not a string shows as its JSON text, and a workflow declaring more than 50 inputs cannot be launched', async () => {
    const stage = launchScene(release)
    const page = recorded(release, 'workflows')
    if (page.kind !== 'json') throw new Error('The recorded workflows are not JSON.')
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`in_${String(index)}`, { default: index }]))
    const rows = (field(page.value, 'workflows') as Record<string, unknown>[]).map((row) => {
      const workflow = field(row, 'workflow') as Record<string, unknown>
      return workflow['name'] === INPUTS ? { ...row, workflow: { ...workflow, inputs: { item: { default: { a: [1] } } } } } : workflow['name'] === ECHO ? { ...row, workflow: { ...workflow, inputs: many } } : row
    })
    stage.archon.answer(workflowsUrl(RECORDED_CWD), json({ ...(page.value as Record<string, unknown>), workflows: rows }))
    const mounted = await stage.mount(orcaWith('ws-local'))
    assert.deepEqual((await choose(mounted, INPUTS)).inputs, { kind: 'ready', rows: [{ name: 'item', required: false, description: '', placeholder: '{"a":[1]}' }] })
    assert.deepEqual((await choose(mounted, ECHO)).inputs, { kind: 'too-many', declared: 51 })
    const refused = ready(((await mounted.worker.request('launch.start', { codebaseId: id, workflow: ECHO, message: 'Go.' })) as LaunchAnswer).launch)
    assert.equal(refused.error, 'This workflow declares 51 inputs, more than the 50 Orchon can fill in. Launch it from Archon.')
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })
})

describe('input values and model bindings', () => {
  const release: Release = '0.12.1'
  const id = RECORDED_ID[release]
  const PLAN = 'archon-plan'
  const press = (mounted: MountedScene, fields: Record<string, unknown>): Promise<LaunchAnswer> =>
    mounted.worker.request('launch.start', { codebaseId: id, workflow: PLAN, message: 'Plan it.', ...fields }) as Promise<LaunchAnswer>
  const edit = async (mounted: MountedScene, change: Record<string, unknown>): Promise<Extract<LaunchView, { kind: 'ready' }>> =>
    ready(((await mounted.worker.request('launch.edit', change)) as LaunchAnswer).launch)

  /** A scene whose launch of archon-plan Archon accepts, as it accepted the recorded launch. */
  function planScene(): Scene {
    const stage = launchScene(release)
    replayAccepted(stage, release)
    stage.archon.answer(`${DEFAULT}/api/workflows/${PLAN}/run`, recorded(release, 'launch-accepted', exchange(release, 'launch-accepted', 'POST', `/api/workflows/${ECHO}/run`)))
    stage.archon.answer(runsUrl(id), recorded(release, 'dashboard-runs-empty', 0))
    return stage
  }

  test('the draft keeps the values and bindings typed, and changing the workflow clears both', async () => {
    const stage = planScene()
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: id, reload: true })
    await edit(mounted, { workflow: PLAN })
    const typed = await edit(mounted, { inputs: { work: 'Ship it' }, bindings: [{ name: 'small', model: 'haiku' }] })
    assert.deepEqual([typed.values, typed.bindings], [{ work: 'Ship it' }, [{ name: 'small', model: 'haiku' }]])
    const changed = await edit(mounted, { workflow: ECHO })
    assert.deepEqual([changed.values, changed.bindings], [{}, []])
    await mounted.worker.deactivate()
  })

  test('Start sends only the filled inputs, as typed, and the bindings as tiers and aliases', async () => {
    const stage = planScene()
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: id, reload: true })
    const answer = await press(mounted, {
      inputs: { work: '  Ship it  ', report: '   ' },
      bindings: [
        { name: 'large', model: 'opus' },
        { name: '@fast', model: 'haiku' }
      ]
    })
    assert.equal(ready(answer.launch).error, undefined)
    const posted = writes(stage).find((call) => call.path === `/api/workflows/${PLAN}/run`)
    assert.deepEqual(posted?.body, {
      conversationId: String(field(recordedRequest(release, 'launch-accepted', exchange(release, 'launch-accepted', 'POST', `/api/workflows/${ECHO}/run`)), 'conversationId')),
      message: 'Plan it.',
      inputs: { work: '  Ship it  ' },
      tiers: { large: 'opus' },
      aliases: { '@fast': 'haiku' }
    })
    await mounted.worker.deactivate()
  })

  test('Start is refused, with nothing sent, for an empty required input, an undeclared input or a binding Archon would refuse', async () => {
    const stage = planScene()
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: id, reload: true })
    const refusal = async (fields: Record<string, unknown>): Promise<string | undefined> => ready((await press(mounted, fields)).launch).error
    assert.equal(
      await refusal({ workflow: 'orchon-recorder-inputs', inputs: { item: '  ' } }),
      'Fill in the required input: item.'
    )
    assert.equal(await refusal({ inputs: { work: 'x', nope: 'y' } }), 'archon-plan does not declare the input nope. Refresh the launcher and try again.')
    assert.equal(await refusal({ bindings: [{ name: 'tiny', model: 'haiku' }] }), 'A binding names a tier (small, medium or large) or an alias starting with @: tiny is neither.')
    assert.equal(await refusal({ bindings: [{ name: 'small', model: '  ' }] }), 'Give the binding small a model.')
    assert.equal(
      await refusal({ bindings: [{ name: 'small', model: 'a' }, { name: 'small', model: 'b' }] }),
      'Each binding names a different tier or alias: small is named twice.'
    )
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })

  test('refuses an input value past 16,000 characters or not text, and more than 10 bindings', async () => {
    const stage = planScene()
    const mounted = await stage.mount(orcaWith('ws-local'))
    await assert.rejects(press(mounted, { inputs: { work: 'x'.repeat(16_001) } }))
    await assert.rejects(press(mounted, { inputs: { work: 3 } }))
    await assert.rejects(press(mounted, { bindings: Array.from({ length: 11 }, (_, index) => ({ name: `@a${String(index)}`, model: 'm' })) }))
    await assert.rejects(mounted.worker.request('launch.edit', { inputs: { work: 'x'.repeat(16_001) } }))
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })
})

/** The raw frames a recorded launch's conversation stream carried under one reader's label, in order. */
function framesOf(release: Release, scenario: string, label: string): string[] {
  return logOf(release, scenario)
    .filter((entry) => entry['kind'] === 'frame' && entry['label'] === label)
    .map((entry) => `${String(entry['raw'])}\n\n`)
}

/** The recorded run row a launch's search found, as a page of the project's runs. */
function foundPage(release: Release, scenario: string): ReturnType<typeof json> {
  const row = logOf(release, scenario).find((entry) => entry['kind'] === 'run-found')?.['run']
  const page = recorded(release, 'dashboard-runs', 2)
  if (row === undefined || page.kind !== 'json') throw new Error(`fixtures/${release}/${scenario}.json found no run.`)
  return json({ ...(page.value as Record<string, unknown>), runs: [row] })
}

/** The recorded workflow list with some declared inputs changed, as a list read before the workflow changed. */
function staleList(release: Release, inputs: Record<string, Record<string, unknown>>): ReturnType<typeof json> {
  const page = recorded(release, 'workflows')
  if (page.kind !== 'json') throw new Error('The recorded workflows are not JSON.')
  const rows = (field(page.value, 'workflows') as Record<string, unknown>[]).map((row) => {
    const workflow = field(row, 'workflow') as Record<string, unknown>
    const name = String(workflow['name'])
    return Object.hasOwn(inputs, name) ? { ...row, workflow: { ...workflow, inputs: inputs[name] } } : row
  })
  return json({ ...(page.value as Record<string, unknown>), workflows: rows })
}

/** Scripts one recorded launch: its conversation, its run post, a held-open conversation stream and an empty runs list. */
function replayLaunch(stage: Scene, release: Release, scenario: string, workflow: string) {
  const created = exchange(release, scenario, 'POST', '/api/conversations')
  const run = exchange(release, scenario, 'POST', `/api/workflows/${workflow}/run`)
  const body = recordedRequest(release, scenario, run) as Record<string, unknown>
  const conversationId = String(body['conversationId'])
  const stream = openStream()
  let streamBeforePost: boolean | undefined
  stage.archon.answer(CONVERSATIONS, recorded(release, scenario, created))
  stage.archon.answer(`${DEFAULT}/api/stream/${conversationId}`, stream)
  stage.archon.answer(`${DEFAULT}/api/workflows/${workflow}/run`, () => {
    streamBeforePost = stage.archon.streams.some((call) => call.url === `${DEFAULT}/api/stream/${conversationId}`)
    return recorded(release, scenario, run)
  })
  stage.archon.answer(runsUrl(RECORDED_ID[release]), recorded(release, 'dashboard-runs-empty', 0))
  return {
    body,
    conversationId,
    stream,
    streamBeforePost: () => streamBeforePost,
    messagesUrl: `${CONVERSATIONS}/${conversationId}/messages?limit=10`,
    /** The recorded saved messages of the conversation. */
    messages: () => recorded(release, scenario, exchange(release, scenario, 'GET', new RegExp(`^/api/conversations/${conversationId}/messages`)))
  }
}

const pressWith = (mounted: MountedScene, release: Release, body: Record<string, unknown>, workflow: string): Promise<LaunchAnswer> =>
  mounted.worker.request('launch.start', {
    codebaseId: RECORDED_ID[release],
    workflow,
    message: String(body['message']),
    ...(body['inputs'] === undefined ? {} : { inputs: body['inputs'] as Record<string, string> })
  }) as Promise<LaunchAnswer>

describe("the launch conversation's stream, replayed from the recordings", () => {
  const INPUTS = 'orchon-recorder-inputs'
  const lookCount = (stage: Scene, release: Release): number => stage.archon.calls.filter((call) => call.url === runsUrl(RECORDED_ID[release])).length

  for (const release of RELEASES) {
    test(`${release}: refused after a 200, the reason is the last text frame before the unlock`, async () => {
      const stage = launchScene(release)
      // The list was read while the workflow still declared the input Archon now refuses.
      stage.archon.answer(workflowsUrl(RECORDED_CWD), staleList(release, { [INPUTS]: { item: { required: true }, not_declared: {} } }))
      const launch = replayLaunch(stage, release, 'launch-undeclared', INPUTS)
      const mounted = await stage.mount(orcaWith('ws-local'))
      await read(mounted, { project: RECORDED_ID[release], reload: true })
      const answer = await pressWith(mounted, release, launch.body, INPUTS)
      assert.equal(launch.streamBeforePost(), true)
      assert.deepEqual(writes(stage)[1]?.body, launch.body)
      assert.equal(ready(answer.launch).starting?.state, 'started')
      for (const frame of framesOf(release, 'launch-undeclared', 'first')) launch.stream.send(frame)
      await stage.clock.advance(100)
      const starting = ready((await read(mounted)).launch).starting
      assert.equal(starting?.state, 'refused')
      assert.equal(starting?.reason, "Cannot run workflow 'orchon-recorder-inputs': it does not declare input 'not_declared'. Declared inputs: item.")
      // Given up: it looks no more and lets go of the stream.
      const looks = lookCount(stage, release)
      await stage.clock.advance(60_000)
      assert.equal(lookCount(stage, release), looks)
      assert.equal(launch.stream.closed, true)
      await mounted.worker.deactivate()
    })

    test(`${release}: accepted, a workflow_dispatch frame starts the search at once, and the stream is let go once the run is found`, async () => {
      const stage = launchScene(release)
      const launch = replayLaunch(stage, release, 'launch-accepted', ECHO)
      const mounted = await stage.mount(orcaWith('ws-local'))
      await read(mounted, { project: RECORDED_ID[release], reload: true })
      await pressWith(mounted, release, launch.body, ECHO)
      assert.equal(launch.streamBeforePost(), true)
      const frames = framesOf(release, 'launch-accepted', 'first')
      const dispatch = frames.findIndex((frame) => frame.includes('"type":"workflow_dispatch"'))
      for (const frame of frames.slice(0, dispatch)) launch.stream.send(frame)
      await stage.clock.advance(100)
      assert.equal(lookCount(stage, release), 0)
      stage.archon.answer(runsUrl(RECORDED_ID[release]), foundPage(release, 'launch-accepted'))
      launch.stream.send(frames[dispatch] ?? '')
      await stage.clock.advance(100)
      assert.equal(lookCount(stage, release), 1)
      assert.equal(ready((await read(mounted)).launch).starting?.state, 'found')
      assert.equal(launch.stream.closed, true)
      await mounted.worker.deactivate()
    })

    test(`${release}: accepted with an input name the workflow does not declare, an unlock after the dispatch is a start`, async () => {
      const stage = launchScene(release)
      stage.archon.answer(workflowsUrl(RECORDED_CWD), staleList(release, { [ECHO]: { not_declared: {} } }))
      const launch = replayLaunch(stage, release, 'launch-undeclared-no-inputs-block', ECHO)
      const mounted = await stage.mount(orcaWith('ws-local'))
      await read(mounted, { project: RECORDED_ID[release], reload: true })
      await pressWith(mounted, release, launch.body, ECHO)
      assert.deepEqual(writes(stage)[1]?.body, launch.body)
      const frames = framesOf(release, 'launch-undeclared-no-inputs-block', 'first')
      const unlock = frames.findIndex((frame) => frame.includes('"locked":false'))
      for (const frame of frames.slice(0, unlock + 1)) launch.stream.send(frame)
      await stage.clock.advance(100)
      assert.equal(ready((await read(mounted)).launch).starting?.state, 'started')
      stage.archon.answer(runsUrl(RECORDED_ID[release]), foundPage(release, 'launch-undeclared-no-inputs-block'))
      await stage.clock.advance(2_000)
      assert.equal(ready((await read(mounted)).launch).starting?.state, 'found')
      await mounted.worker.deactivate()
    })

    test(`${release}: the lost stream is never opened again, and the saved messages tell a start on each miss`, async () => {
      const stage = launchScene(release)
      const launch = replayLaunch(stage, release, 'launch-accepted', ECHO)
      stage.archon.answer(launch.messagesUrl, launch.messages())
      const mounted = await stage.mount(orcaWith('ws-local'))
      await read(mounted, { project: RECORDED_ID[release], reload: true })
      await pressWith(mounted, release, launch.body, ECHO)
      // Archon's console took the stream: the worker's ends with no frame, as recorded.
      launch.stream.send(framesOf(release, 'launch-accepted', 'first')[0] ?? '')
      launch.stream.end()
      await stage.clock.advance(6_000)
      const reads = stage.archon.calls.filter((call) => call.url === launch.messagesUrl).length
      assert.equal(reads, lookCount(stage, release))
      assert.ok(reads >= 3)
      assert.equal(stage.archon.streams.filter((call) => call.url.endsWith(launch.conversationId)).length, 1)
      assert.equal(ready((await read(mounted)).launch).starting?.state, 'started')
      stage.archon.answer(runsUrl(RECORDED_ID[release]), foundPage(release, 'launch-accepted'))
      await stage.clock.advance(2_000)
      assert.equal(ready((await read(mounted)).launch).starting?.state, 'found')
      await mounted.worker.deactivate()
    })

    test(`${release}: with the stream lost, an assistant message seen on two reads in a row is the refusal, its "Starting workflow" line dropped`, async () => {
      const stage = launchScene(release)
      stage.archon.answer(workflowsUrl(RECORDED_CWD), staleList(release, { [INPUTS]: { item: {} } }))
      const launch = replayLaunch(stage, release, 'launch-missing-required', INPUTS)
      stage.archon.answer(launch.messagesUrl, launch.messages())
      const mounted = await stage.mount(orcaWith('ws-local'))
      await read(mounted, { project: RECORDED_ID[release], reload: true })
      await pressWith(mounted, release, launch.body, INPUTS)
      launch.stream.end()
      await stage.clock.advance(2_000)
      assert.equal(ready((await read(mounted)).launch).starting?.state, 'started')
      await stage.clock.advance(2_000)
      const starting = ready((await read(mounted)).launch).starting
      assert.equal(starting?.state, 'refused')
      assert.ok(starting?.reason?.startsWith("This workflow requires input 'item', and none was supplied."), starting?.reason)
      await mounted.worker.deactivate()
    })
  }

  test('an error frame fails the launch with its text, cut at 2,000 characters', async () => {
    const release: Release = '0.14.0'
    const stage = launchScene(release)
    const launch = replayLaunch(stage, release, 'launch-accepted', ECHO)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: RECORDED_ID[release], reload: true })
    await pressWith(mounted, release, launch.body, ECHO)
    const text = `Failed to process message: ${'x'.repeat(2_500)}`
    launch.stream.send(`data: ${JSON.stringify({ type: 'conversation_lock', locked: true })}\n\n`)
    launch.stream.send(`data: ${JSON.stringify({ type: 'error', message: text, classification: 'transient' })}\n\n`)
    launch.stream.send(`data: ${JSON.stringify({ type: 'conversation_lock', locked: false })}\n\n`)
    await stage.clock.advance(100)
    const starting = ready((await read(mounted)).launch).starting
    assert.equal(starting?.state, 'failed')
    assert.equal(starting?.reason, text.slice(0, 2_000))
    await mounted.worker.deactivate()
  })

  test('holds at most 20 launch streams open, and none once the worker stops', async () => {
    const release: Release = '0.12.1'
    const stage = launchScene(release)
    replayAccepted(stage, release)
    let made = 0
    stage.archon.answer(CONVERSATIONS, () => {
      made += 1
      return json({ conversationId: `web-launch-${String(made)}`, id: `db-${String(made)}` })
    })
    const streams: ReturnType<typeof openStream>[] = []
    for (let index = 1; index <= 22; index += 1) {
      const stream = openStream()
      streams.push(stream)
      stage.archon.answer(`${DEFAULT}/api/stream/web-launch-${String(index)}`, stream)
    }
    stage.archon.answer(runsUrl(RECORDED_ID[release]), recorded(release, 'dashboard-runs-empty', 0))
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: RECORDED_ID[release], reload: true })
    for (let count = 0; count < 22; count += 1) {
      await mounted.worker.request('launch.another')
      await mounted.worker.request('launch.start', { codebaseId: RECORDED_ID[release], workflow: ECHO, message: `Run ${String(count)}.` })
      await stage.clock.advance(10)
    }
    assert.equal(streams.filter((stream) => stream.opened && !stream.closed).length, 20)
    await mounted.worker.deactivate()
    await stage.clock.advance(10)
    assert.equal(streams.filter((stream) => stream.opened && !stream.closed).length, 0)
  })
})

describe('Edit and try again', () => {
  test('brings the form back filled in from the launch record, bindings included', async () => {
    const release: Release = '0.13.2'
    const INPUTS = 'orchon-recorder-inputs'
    const stage = launchScene(release)
    stage.archon.answer(workflowsUrl(RECORDED_CWD), staleList(release, { [INPUTS]: { item: { required: true }, not_declared: {} } }))
    const launch = replayLaunch(stage, release, 'launch-undeclared', INPUTS)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: RECORDED_ID[release], reload: true })
    const bindings = [{ name: 'small', model: 'haiku' }]
    const started = ready(
      ((await mounted.worker.request('launch.start', {
        codebaseId: RECORDED_ID[release],
        workflow: INPUTS,
        message: String(launch.body['message']),
        inputs: launch.body['inputs'] as Record<string, string>,
        bindings
      })) as LaunchAnswer).launch
    )
    // The form was emptied for the next launch.
    assert.deepEqual([started.message, started.values, started.bindings], ['', {}, []])
    for (const frame of framesOf(release, 'launch-undeclared', 'first')) launch.stream.send(frame)
    await stage.clock.advance(100)
    const refused = ready((await read(mounted)).launch).starting
    assert.equal(refused?.state, 'refused')
    const form = ready(((await mounted.worker.request('launch.retry', { launchId: refused?.launchId ?? '' })) as LaunchAnswer).launch)
    assert.equal(form.starting, undefined)
    assert.deepEqual(
      [form.codebaseId, form.workflow, form.message, form.values, form.bindings],
      [RECORDED_ID[release], INPUTS, launch.body['message'], launch.body['inputs'], bindings]
    )
    // Nothing is sent again by itself.
    assert.equal(writes(stage).length, 2)
    await assert.rejects(mounted.worker.request('launch.retry', { launchId: 'x'.repeat(65) }))
    await mounted.worker.deactivate()
  })
})

describe('a failed launch while the Launch section is not showing', () => {
  const release: Release = '0.14.0'
  const INPUTS = 'orchon-recorder-inputs'

  /** A launch refused after a 200, with the section hidden (`hide`) or showing when Archon refuses it. */
  async function refuseLaunch(hide: boolean, settings: MockHostOptions['settings'] = {}): Promise<{ stage: Scene; mounted: MountedScene }> {
    const stage = launchScene(release)
    stage.archon.answer(workflowsUrl(RECORDED_CWD), staleList(release, { [INPUTS]: { item: { required: true }, not_declared: {} } }))
    const launch = replayLaunch(stage, release, 'launch-undeclared', INPUTS)
    const mounted = await stage.mount({ ...orcaWith('ws-local'), settings })
    await read(mounted, { project: RECORDED_ID[release], reload: true })
    await pressWith(mounted, release, launch.body, INPUTS)
    if (hide) await mounted.worker.request('launch.hide')
    for (const frame of framesOf(release, 'launch-undeclared', 'first')) launch.stream.send(frame)
    await stage.clock.advance(10_000)
    return { stage, mounted }
  }

  test('raises a desktop notification: the workflow name as title, "Could not start" and the project as body, never Archon\'s text', async () => {
    const { mounted } = await refuseLaunch(true)
    assert.deepEqual(mounted.host.callsOf('notifications.show'), [{ title: INPUTS, body: `Could not start · ${RECORDED_NAME}` }])
    await mounted.worker.deactivate()
  })

  test('raises none while the section shows, or with the setting off', async () => {
    const showing = await refuseLaunch(false)
    assert.deepEqual(showing.mounted.host.callsOf('notifications.show'), [])
    await showing.mounted.worker.deactivate()
    const off = await refuseLaunch(true, { notifications: 'off' })
    assert.deepEqual(off.mounted.host.callsOf('notifications.show'), [])
    await off.mounted.worker.deactivate()
  })

  test('a section that stopped reading for a minute counts as not showing', async () => {
    const stage = launchScene(release)
    stage.archon.answer(workflowsUrl(RECORDED_CWD), staleList(release, { [INPUTS]: { item: { required: true }, not_declared: {} } }))
    const launch = replayLaunch(stage, release, 'launch-undeclared', INPUTS)
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: RECORDED_ID[release], reload: true })
    await pressWith(mounted, release, launch.body, INPUTS)
    // The panel was closed with no word to the worker: its reads stop.
    await stage.clock.advance(60_000)
    for (const frame of framesOf(release, 'launch-undeclared', 'first')) launch.stream.send(frame)
    await stage.clock.advance(10_000)
    assert.equal(mounted.host.callsOf('notifications.show').length, 1)
    await mounted.worker.deactivate()
  })
})

describe('a burst of failed launches', () => {
  test('folds into one notification with the count, as other bursts do', async () => {
    const release: Release = '0.12.1'
    const stage = launchScene(release)
    replayAccepted(stage, release)
    let made = 0
    stage.archon.answer(CONVERSATIONS, () => {
      made += 1
      return json({ conversationId: `web-burst-${String(made)}`, id: `db-${String(made)}` })
    })
    const streams = Array.from({ length: 4 }, (_, index) => {
      const stream = openStream()
      stage.archon.answer(`${DEFAULT}/api/stream/web-burst-${String(index + 1)}`, stream)
      return stream
    })
    stage.archon.answer(runsUrl(RECORDED_ID[release]), recorded(release, 'dashboard-runs-empty', 0))
    const mounted = await stage.mount(orcaWith('ws-local'))
    await read(mounted, { project: RECORDED_ID[release], reload: true })
    for (let count = 0; count < 4; count += 1) {
      await mounted.worker.request('launch.another')
      await mounted.worker.request('launch.start', { codebaseId: RECORDED_ID[release], workflow: ECHO, message: `Run ${String(count)}.` })
    }
    await mounted.worker.request('launch.hide')
    for (const stream of streams) {
      stream.send(`data: ${JSON.stringify({ type: 'conversation_lock', locked: true })}\n\n`)
      stream.send(`data: ${JSON.stringify({ type: 'conversation_lock', locked: false })}\n\n`)
    }
    await stage.clock.advance(10_000)
    assert.deepEqual(mounted.host.callsOf('notifications.show'), [{ title: '4 launches could not start' }])
    await mounted.worker.deactivate()
  })
})
