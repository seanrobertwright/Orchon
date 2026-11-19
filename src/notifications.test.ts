// The worker's request protocol seam: desktop notifications. The worker is mounted on a scripted
// Archon that replays the recorded attention answers, and these tests assert the
// `notifications.show` calls Orca is sent and the calls made to Archon.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  json,
  openStream,
  recorded,
  REFUSE,
  RELEASES,
  scene,
  type MountedScene,
  type Release,
  type Scene,
  type Scripted
} from '../scripts/scripted-archon.ts'
import { field } from '../scripts/shape.ts'
import { DASHBOARD_STREAM_PATH } from './live'
import { SNAPSHOT_SAFETY_MS } from './needs-you'

const ATTENTION = `${DEFAULT}/api/runs/attention`
const RUNNING = `${DEFAULT}/api/dashboard/runs?limit=1`

/** A scene connected to a recorded release, with nothing waiting. */
function connectedTo(release: Release): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, recorded(release, 'health'))
  stage.archon.answer(DEFAULT_OPENAPI, recorded(release, 'openapi'))
  stage.archon.answer(ATTENTION, recorded(release, 'attention-empty'))
  stage.archon.answer(RUNNING, recorded(release, 'dashboard-runs-empty', 1))
  return stage
}

/** Every notification Orca was sent, in order. */
const shown = (mounted: MountedScene): unknown[] => mounted.host.callsOf('notifications.show')

/** The title of every notification Orca was sent, in order. */
const titles = (mounted: MountedScene): string[] => shown(mounted).map((call) => (call as { title: string }).title)

/** One frame of Archon's dashboard stream, as it sends it. */
const frame = (fields: Record<string, unknown>): string => `data: ${JSON.stringify(fields)}

`

/** One gate as Archon's queue holds it: on run `id` of `workflow`, at `nodeId`, with pause id `pauseId`. */
function gateRun(base: Record<string, unknown>, id: string, workflow: string, nodeId = 'gate', pauseId = `pause-${id}`): Record<string, unknown> {
  const metadata = { ...(base.metadata as Record<string, unknown>), approval: { nodeId, message: 'Approve?', type: 'approval', pauseId } }
  const attention = { kind: 'awaiting_response', runId: id, respondTo: { runId: id, nodeId }, message: 'Approve?', occurrence: pauseId }
  return { ...base, id, workflow_name: workflow, metadata, attention }
}

/** The recorded gate answer of a release with its runs replaced by what `make` builds from its one run. */
function queue(release: Release, make: (run: Record<string, unknown>) => Record<string, unknown>[]): Scripted {
  const gate = recorded(release, 'attention-gate')
  if (gate.kind !== 'json') throw new Error('The recorded attention answer is not JSON.')
  const [run] = field(gate.value, 'runs') as Record<string, unknown>[]
  if (run === undefined) throw new Error('The recorded attention answer has no run.')
  return { ...gate, value: { ...(gate.value as Record<string, unknown>), runs: make(run) } }
}

/** A queue of gates, one per name: run `run-<name>` of workflow `flow-<name>`. */
const gates = (release: Release, ...names: string[]): Scripted =>
  queue(release, (run) => names.map((name) => gateRun(run, `run-${name}`, `flow-${name}`)))

/** Mounts, lets the first read fill the seen record from `first`, then answers `next` from the next read on. */
async function afterStart(stage: Scene, first: Scripted, next: Scripted, settings?: Record<string, string>): Promise<MountedScene> {
  stage.archon.answer(ATTENTION, first)
  const mounted = await stage.mount(settings === undefined ? {} : { settings })
  await stage.clock.advance(0)
  stage.archon.answer(ATTENTION, next)
  return mounted
}

describe('a run that newly needs you', () => {
  for (const release of RELEASES) {
    test(`${release}: a recorded gate that opens after the first read notifies once, with the workflow name and the project`, async () => {
      const stage = connectedTo(release)
      const mounted = await stage.mount()
      await stage.clock.advance(1_000)
      stage.archon.answer(ATTENTION, recorded(release, 'attention-gate'))
      await stage.clock.advance(SNAPSHOT_SAFETY_MS)
      assert.deepEqual(shown(mounted), [])
      await stage.clock.advance(5_000)
      assert.deepEqual(shown(mounted), [
        { title: 'orchon-recorder-gate', body: 'Waiting for your decision · orchon-recorder/throwaway-project' }
      ])
      await stage.clock.advance(3 * SNAPSHOT_SAFETY_MS)
      assert.equal(shown(mounted).length, 1)
    })

    test(`${release}: a recorded attention wait notifies with its own phrase, and never its question, options or run id`, async () => {
      const stage = connectedTo(release)
      const mounted = await afterStart(stage, recorded(release, 'attention-empty'), recorded(release, 'attention-wait'))
      await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
      assert.deepEqual(shown(mounted), [{ title: 'orchon-recorder-gate', body: 'Waiting for your answer · orchon-recorder/throwaway-project' }])
      const wait = recorded(release, 'attention-wait')
      if (wait.kind !== 'json') throw new Error('The recorded attention answer is not JSON.')
      const [run] = field(wait.value, 'runs') as { id: string }[]
      const text = JSON.stringify(shown(mounted))
      for (const secret of [run?.id ?? '', 'Recorded question', 'The first option', 'The second option', '<archon-home>', '<project-path>']) {
        assert.equal(text.includes(secret), false, `a notification holds ${secret}`)
      }
    })
  }

  test("an unreadable run notifies that it needs a look in Archon's console, and never Archon's detail text", async () => {
    const stage = connectedTo('0.14.0')
    const unreadable = queue('0.14.0', (run) => [
      { ...run, id: 'run-u', attention: { kind: 'unreadable', runId: 'run-u', reason: 'malformed_gate', detail: 'The gate cannot be read.' } }
    ])
    const mounted = await afterStart(stage, gates('0.14.0'), unreadable)
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(shown(mounted), [{ title: 'orchon-recorder-gate', body: "Needs a look in Archon's console · orchon-recorder/throwaway-project" }])
  })

  test('the title is the workflow name cut at 80 characters; a run with no project has the phrase alone', async () => {
    const stage = connectedTo('0.12.1')
    const long = 'w'.repeat(81)
    const mounted = await afterStart(
      stage,
      gates('0.12.1'),
      queue('0.12.1', (run) => [{ ...gateRun(run, 'run-long', long), codebase_name: null }])
    )
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(shown(mounted), [{ title: 'w'.repeat(80), body: 'Waiting for your decision' }])
  })

  test('a project name that is a folder path is left out of the body', async () => {
    const stage = connectedTo('0.12.1')
    const mounted = await afterStart(
      stage,
      gates('0.12.1'),
      queue('0.12.1', (run) => [{ ...gateRun(run, 'run-p', 'flow-p'), codebase_name: 'C:\\Users\\someone\\project' }])
    )
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(shown(mounted), [{ title: 'flow-p', body: 'Waiting for your decision' }])
  })
})

describe('the seen record', () => {
  test('the first read after the worker starts notifies nothing, however much is waiting', async () => {
    const stage = connectedTo('0.12.1')
    stage.archon.answer(ATTENTION, gates('0.12.1', 'a', 'b'))
    const mounted = await stage.mount()
    await stage.clock.advance(5 * SNAPSHOT_SAFETY_MS)
    assert.deepEqual(shown(mounted), [])
  })

  test('a reconnect is not a start: what waited before stays quiet, and what opened during the gap notifies', async () => {
    const stage = connectedTo('0.12.1')
    const mounted = await afterStart(stage, gates('0.12.1', 'a'), gates('0.12.1', 'a'))
    stage.archon.answer(DEFAULT_HEALTH, REFUSE)
    stage.archon.answer(ATTENTION, REFUSE)
    await stage.clock.advance(SNAPSHOT_SAFETY_MS)
    assert.equal(mounted.latest().kind, 'searching')
    stage.archon.answer(DEFAULT_HEALTH, recorded('0.12.1', 'health'))
    stage.archon.answer(ATTENTION, gates('0.12.1', 'a', 'b'))
    await stage.clock.advance(2_000)
    assert.equal(mounted.latest().kind, 'connected')
    await stage.clock.advance(10_000)
    assert.deepEqual(titles(mounted), ['flow-b'])
  })

  test('another store id is a start: its first read fills the record and notifies nothing', async () => {
    const stage = connectedTo('0.12.1')
    const health = recorded('0.12.1', 'health')
    if (health.kind !== 'json') throw new Error('The recorded health answer is not JSON.')
    const mounted = await afterStart(stage, gates('0.12.1', 'a'), gates('0.12.1', 'a'))
    stage.archon.answer(DEFAULT_HEALTH, REFUSE)
    stage.archon.answer(ATTENTION, REFUSE)
    await stage.clock.advance(SNAPSHOT_SAFETY_MS)
    stage.archon.answer(DEFAULT_HEALTH, json({ ...(health.value as Record<string, unknown>), storeId: 'another-store' }))
    stage.archon.answer(ATTENTION, gates('0.12.1', 'a', 'b'))
    await stage.clock.advance(2_000)
    assert.equal(mounted.latest().kind, 'connected')
    await stage.clock.advance(SNAPSHOT_SAFETY_MS)
    assert.deepEqual(shown(mounted), [])
    stage.archon.answer(ATTENTION, gates('0.12.1', 'a', 'b', 'c'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(titles(mounted), ['flow-c'])
  })

  test('holds 1,000 identities and drops the one met longest ago first', async () => {
    const stage = connectedTo('0.12.1')
    const thousand = Array.from({ length: 1_000 }, (_, index) => String(index))
    const mounted = await afterStart(stage, gates('0.12.1', ...thousand), gates('0.12.1', 'new'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(titles(mounted), ['flow-new'])
    // Meeting the thousand and first identity dropped the oldest, "0", and only it.
    stage.archon.answer(ATTENTION, gates('0.12.1', '1', '0'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 10_000)
    assert.deepEqual(titles(mounted), ['flow-new', 'flow-0'])
  })

  test('a loop that pauses again at the same node notifies again', async () => {
    const stage = connectedTo('0.12.1')
    const pausedAt = (pauseId: string): Scripted => queue('0.12.1', (run) => [gateRun(run, 'run-loop', 'flow-loop', 'gate', pauseId)])
    const mounted = await afterStart(stage, pausedAt('first'), pausedAt('first'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 10_000)
    assert.deepEqual(shown(mounted), [])
    stage.archon.answer(ATTENTION, pausedAt('second'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS)
    assert.deepEqual(titles(mounted), ['flow-loop'])
  })

  test('is kept while notifications are off: turning them on notifies nothing that was already waiting', async () => {
    const stage = connectedTo('0.12.1')
    const mounted = await afterStart(stage, gates('0.12.1'), gates('0.12.1', 'a'), { notifications: 'off' })
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 10_000)
    assert.deepEqual(shown(mounted), [])
    await mounted.orca.settings.set('notifications', 'needs-you')
    stage.archon.answer(ATTENTION, gates('0.12.1', 'a', 'b'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(titles(mounted), ['flow-b'])
  })
})

describe('bursts', () => {
  test('up to 3 new events get a notification each, collected for 5 seconds', async () => {
    const stage = connectedTo('0.12.1')
    const mounted = await afterStart(stage, gates('0.12.1'), gates('0.12.1', 'a', 'b', 'c'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 4_999)
    assert.deepEqual(shown(mounted), [])
    await stage.clock.advance(1)
    assert.deepEqual(titles(mounted), ['flow-a', 'flow-b', 'flow-c'])
  })

  test('more than 3 become one notification titled with the count and no body', async () => {
    const stage = connectedTo('0.12.1')
    const mounted = await afterStart(stage, gates('0.12.1'), gates('0.12.1', 'a', 'b', 'c', 'd'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(shown(mounted), [{ title: '4 runs need you' }])
  })

  test('at most one batch goes out every 10 seconds', async () => {
    const stage = connectedTo('0.12.1')
    const stream = openStream()
    stage.archon.answer(`${DEFAULT}${DASHBOARD_STREAM_PATH}`, stream)
    const mounted = await afterStart(stage, gates('0.12.1'), gates('0.12.1', 'a'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS + 5_000)
    assert.deepEqual(titles(mounted), ['flow-a'])
    // Two seconds after that batch a status frame reads a new one: it is collected for 5 seconds,
    // then held until 10 seconds have passed since the last batch.
    stage.archon.answer(ATTENTION, gates('0.12.1', 'a', 'b'))
    await stage.clock.advance(2_000)
    stream.send(frame({ type: 'workflow_status', runId: 'run-b' }))
    await stage.clock.advance(7_999)
    assert.deepEqual(titles(mounted), ['flow-a'])
    await stage.clock.advance(1)
    assert.deepEqual(titles(mounted), ['flow-a', 'flow-b'])
  })
})

describe('the Notifications setting', () => {
  test('off silences every notification', async () => {
    const stage = connectedTo('0.12.1')
    const mounted = await afterStart(stage, gates('0.12.1'), gates('0.12.1', 'a', 'b', 'c', 'd'), { notifications: 'off' })
    await stage.clock.advance(3 * SNAPSHOT_SAFETY_MS)
    assert.deepEqual(shown(mounted), [])
  })
})

describe('run endings', () => {
  /** The recorded failed run of a release: its id and its reads as failed and, after Abandon, as cancelled. */
  function recordedEnding(release: Release): { id: string; failed: Scripted; cancelled: Scripted } {
    const failed = recorded(release, 'run-failed', 8)
    if (failed.kind !== 'json') throw new Error('The recorded run is not JSON.')
    const id = field(field(failed.value, 'run'), 'id')
    if (typeof id !== 'string') throw new Error('The recorded run has no id.')
    return { id, failed, cancelled: recorded(release, 'run-failed', 16) }
  }

  /** A scene with the dashboard stream open and the recorded projects list. */
  function streaming(release: Release): { stage: Scene; send(runId: string, type?: string): void } {
    const stage = connectedTo(release)
    const stream = openStream()
    stage.archon.answer(`${DEFAULT}${DASHBOARD_STREAM_PATH}`, stream)
    stage.archon.answer(`${DEFAULT}/api/codebases`, recorded(release, 'codebases', 1))
    return { stage, send: (runId, type = 'workflow_status') => stream.send(frame({ type, runId })) }
  }

  const runReads = (stage: Scene): string[] =>
    stage.archon.calls.map((call) => call.url).filter((url) => url.startsWith(`${DEFAULT}/api/workflows/runs/`))

  for (const release of RELEASES) {
    test(`${release}: with runs that end opted in, a workflow_status frame reads the one run it names and a recorded failure notifies`, async () => {
      const { stage, send } = streaming(release)
      const ending = recordedEnding(release)
      stage.archon.answer(`${DEFAULT}/api/workflows/runs/${ending.id}`, ending.failed)
      const mounted = await stage.mount({ settings: { notifications: 'needs-you-and-ended' } })
      await stage.clock.advance(0)
      send(ending.id)
      await stage.clock.advance(SNAPSHOT_SAFETY_MS / 2)
      assert.deepEqual(runReads(stage), [`${DEFAULT}/api/workflows/runs/${ending.id}`])
      assert.deepEqual(shown(mounted), [{ title: 'orchon-recorder-fail', body: 'Failed · orchon-recorder/throwaway-project' }])
    })
  }

  test('each run and final status notifies once: the same ending again is quiet, a new final status notifies', async () => {
    const { stage, send } = streaming('0.14.0')
    const ending = recordedEnding('0.14.0')
    stage.archon.answer(`${DEFAULT}/api/workflows/runs/${ending.id}`, ending.failed)
    const mounted = await stage.mount({ settings: { notifications: 'needs-you-and-ended' } })
    await stage.clock.advance(0)
    send(ending.id)
    await stage.clock.advance(15_000)
    send(ending.id)
    await stage.clock.advance(15_000)
    assert.deepEqual(titles(mounted), ['orchon-recorder-fail'])
    stage.archon.answer(`${DEFAULT}/api/workflows/runs/${ending.id}`, ending.cancelled)
    send(ending.id)
    await stage.clock.advance(15_000)
    assert.deepEqual(shown(mounted).at(-1), { title: 'orchon-recorder-fail', body: 'Cancelled · orchon-recorder/throwaway-project' })
  })

  test('a run that has not ended notifies nothing, and a dag_node frame reads no run', async () => {
    const { stage, send } = streaming('0.14.0')
    stage.archon.answer(`${DEFAULT}/api/workflows/runs/run-live`, recorded('0.14.0', 'run-control-running', 36))
    const mounted = await stage.mount({ settings: { notifications: 'needs-you-and-ended' } })
    await stage.clock.advance(0)
    send('run-other', 'dag_node')
    send('run-live')
    await stage.clock.advance(15_000)
    assert.deepEqual(runReads(stage), [`${DEFAULT}/api/workflows/runs/run-live`])
    assert.deepEqual(shown(mounted), [])
  })

  for (const notifications of ['needs-you', 'off']) {
    test(`with "${notifications}", a workflow_status frame reads no run`, async () => {
      const { stage, send } = streaming('0.14.0')
      const ending = recordedEnding('0.14.0')
      stage.archon.answer(`${DEFAULT}/api/workflows/runs/${ending.id}`, ending.failed)
      const mounted = await stage.mount({ settings: { notifications } })
      await stage.clock.advance(0)
      send(ending.id)
      await stage.clock.advance(15_000)
      assert.deepEqual(runReads(stage), [])
      assert.deepEqual(shown(mounted), [])
    })
  }
})
