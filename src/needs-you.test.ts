// The worker's request protocol seam: the snapshot of runs that need you. The worker is mounted
// on a scripted Archon that replays the recorded attention answers of every supported release,
// and these tests assert the calls made to Archon, the status bar item and what a frame is told.
import { assert, describe, test } from 'orca/testing'
import {
  ARCHON_HOME,
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  json,
  openStream,
  recorded,
  REFUSE,
  RELEASES,
  scene,
  type Release,
  type Scene,
  type Scripted
} from '../scripts/scripted-archon.ts'
import { field } from '../scripts/shape.ts'
import { READ_CAP_BYTES } from './client'
import { DASHBOARD_STREAM_PATH } from './live'
import { SHOW_RUNS_MEMORY_MS, SNAPSHOT_GAP_MS, SNAPSHOT_SAFETY_MS } from './needs-you'

const ATTENTION = `${DEFAULT}/api/runs/attention`
const RUNNING = `${DEFAULT}/api/dashboard/runs?limit=1`

/** One frame of Archon's dashboard stream, as it sends it. */
const frame = (fields: Record<string, unknown>): string => `data: ${JSON.stringify(fields)}

`

/** The address of every read of the snapshot, in order. */
const snapshotUrls = (stage: Scene): string[] => stage.archon.snapshots.map((call) => call.url)

/** The text of every `statusBar.update` the worker sent, in order. */
const texts = (updates: unknown[]): string[] => updates.map((update) => (update as { text: string }).text)

/** A scene connected to a recorded release, with Archon's attention answers from `scenario`. */
function connectedTo(release: Release, scenario: 'attention-empty' | 'attention-gate' | 'attention-wait'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, recorded(release, 'health'))
  stage.archon.answer(DEFAULT_OPENAPI, recorded(release, 'openapi'))
  stage.archon.answer(ATTENTION, recorded(release, scenario))
  // The running count, recorded beside each attention answer, or with the empty list.
  stage.archon.answer(RUNNING, scenario === 'attention-empty' ? recorded(release, 'dashboard-runs-empty', 1) : recorded(release, scenario, 3))
  return stage
}

describe('the snapshot of runs that need you', () => {
  for (const release of RELEASES) {
    test(`${release}: a recorded gate is one run that needs you`, async () => {
      const stage = connectedTo(release, 'attention-gate')
      const mounted = await stage.mount()
      await stage.clock.advance(1_000)
      assert.deepEqual(snapshotUrls(stage), [ATTENTION, RUNNING])
      const last = mounted.statusBar().at(-1) as { text: string; icon: string; tone: string; tooltip: string }
      assert.deepEqual({ text: last.text, icon: last.icon, tone: last.tone }, { text: '1 needs you', icon: 'bell', tone: 'warning' })
      assert.match(last.tooltip, /^1 run needs you on Archon /)
    })

    test(`${release}: a recorded attention wait is one run that needs you`, async () => {
      const stage = connectedTo(release, 'attention-wait')
      const mounted = await stage.mount()
      await stage.clock.advance(1_000)
      assert.equal(texts(mounted.statusBar()).at(-1), '1 needs you')
    })

    test(`${release}: the recorded empty queue reads "Archon"`, async () => {
      const stage = connectedTo(release, 'attention-empty')
      const mounted = await stage.mount()
      await stage.clock.advance(1_000)
      assert.equal(texts(mounted.statusBar()).at(-1), 'Archon')
      assert.match((mounted.statusBar().at(-1) as { tooltip: string }).tooltip, /^Connected to Archon /)
    })
  }
})

/** The recorded gate answer of a release with its one run copied once per `attention`, ids made unique. */
function queueOf(release: Release, attentions: unknown[]): Scripted {
  const gate = recorded(release, 'attention-gate')
  if (gate.kind !== 'json') throw new Error('The recorded attention answer is not JSON.')
  const [run] = field(gate.value, 'runs') as Record<string, unknown>[]
  const runs = attentions.map((attention, index) => ({ ...run, id: `run-${String(index)}`, attention }))
  return { ...gate, value: { ...(gate.value as Record<string, unknown>), runs } }
}

/** One of each `attention` kind Archon's queue holds, as `runAttention` in Archon's source shapes them. */
const KINDS = {
  gate: { kind: 'awaiting_response', runId: 'r', respondTo: { runId: 'r', nodeId: 'gate' }, message: 'Approve?', occurrence: 'o-1' },
  wait: { kind: 'attention', runId: 'r', nodeId: 'ask', message: 'Pick one.', occurrence: 'o-2', form: 'message', options: [] },
  unreadable: { kind: 'unreadable', runId: 'r', reason: 'malformed_gate', detail: 'The gate cannot be read.' },
  usageLimit: { kind: 'usage_limit', runId: 'r', nodeId: 'write', resumeAt: '2026-11-18T13:00:00.000Z' },
  child: { kind: 'blocked_on_child', runId: 'r', childRunId: 'c', nodeId: 'write' },
  children: { kind: 'blocked_on_children', runId: 'r', nodeId: 'write', childRunIds: ['c', 'd'] },
  stalled: { kind: 'stalled_tool_calls', runId: 'r', status: 'running', calls: [] },
  failed: { kind: 'terminal', runId: 'r', status: 'failed', at: '2026-11-18T11:00:00.000Z' }
}

describe('which runs need you', () => {
  for (const release of RELEASES) {
    test(`${release}: a gate, an attention wait and an unreadable run count; nothing else does`, async () => {
      const stage = connectedTo(release, 'attention-gate')
      stage.archon.answer(ATTENTION, queueOf(release, [...Object.values(KINDS), null]))
      const mounted = await stage.mount()
      await stage.clock.advance(1_000)
      assert.equal(texts(mounted.statusBar()).at(-1), '3 need you')
    })
  }

  test('a run whose attention has no kind cannot be read, and the rest still count', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, queueOf('0.12.1', [KINDS.gate, { message: 'no kind' }, KINDS.wait]))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    assert.equal(texts(mounted.statusBar()).at(-1), '2 need you')
  })
})

describe('when the waiting runs cannot be read', () => {
  const unavailable = /^The count of runs that need you is unavailable from Archon 0\.12\.1 at /

  test('an answer that fails validation reads "Archon" with the count unavailable', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, json({ items: [] }))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    const last = mounted.statusBar().at(-1) as { text: string; tooltip: string }
    assert.equal(last.text, 'Archon')
    assert.match(last.tooltip, unavailable)
    assert.equal(mounted.latest().kind, 'connected')
  })

  test('an answer too large to read reads "Archon" with the count unavailable', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    const big = new Uint8Array(READ_CAP_BYTES + 1).fill(32)
    stage.archon.answer(ATTENTION, { kind: 'chunks', chunks: [big] })
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    assert.match((mounted.statusBar().at(-1) as { tooltip: string }).tooltip, unavailable)
  })

  test('an error status reads "Archon" with the count unavailable, and the next good read counts again', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, json({ error: 'Failed' }, 500))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    assert.match((mounted.statusBar().at(-1) as { tooltip: string }).tooltip, unavailable)
    stage.archon.answer(ATTENTION, recorded('0.12.1', 'attention-gate'))
    await stage.clock.advance(SNAPSHOT_SAFETY_MS)
    assert.equal(texts(mounted.statusBar()).at(-1), '1 needs you')
  })
})

describe('when the snapshot is read', () => {
  /** How many times the attention queue was read. */
  const reads = (stage: Scene): number => stage.archon.snapshots.filter((call) => call.url === ATTENTION).length

  test('once on connecting, then every 30 seconds with no panel open', async () => {
    const stage = connectedTo('0.14.0', 'attention-empty')
    await stage.mount()
    assert.equal(reads(stage), 1)
    await stage.clock.advance(SNAPSHOT_SAFETY_MS - 1)
    assert.equal(reads(stage), 1)
    await stage.clock.advance(1)
    assert.equal(reads(stage), 2)
    await stage.clock.advance(2 * SNAPSHOT_SAFETY_MS)
    assert.equal(reads(stage), 4)
  })

  test('on a workflow_status frame, at most once every 2 seconds; a dag_node frame reads nothing', async () => {
    const stage = connectedTo('0.14.0', 'attention-empty')
    const stream = openStream()
    stage.archon.answer(`${DEFAULT}${DASHBOARD_STREAM_PATH}`, stream)
    await stage.mount()
    assert.equal(reads(stage), 1)
    stream.send(frame({ type: 'dag_node', runId: 'run-1' }))
    await stage.clock.advance(3_000)
    assert.equal(reads(stage), 1)
    // Five status frames in one second: the hints are folded, and the reads keep their gap.
    for (let index = 0; index < 5; index += 1) {
      stream.send(frame({ type: 'workflow_status', runId: `run-${String(index)}` }))
      await stage.clock.advance(200)
    }
    assert.equal(reads(stage), 2)
    await stage.clock.advance(SNAPSHOT_GAP_MS)
    assert.equal(reads(stage), 3)
    await stage.clock.advance(SNAPSHOT_GAP_MS)
    assert.equal(reads(stage), 3)
  })

  test('on every reconnect', async () => {
    const stage = connectedTo('0.14.0', 'attention-empty')
    const mounted = await stage.mount()
    assert.equal(reads(stage), 1)
    stage.archon.answer(DEFAULT_HEALTH, REFUSE)
    stage.archon.answer(ATTENTION, REFUSE)
    await stage.clock.advance(SNAPSHOT_SAFETY_MS)
    assert.equal(mounted.latest().kind, 'searching')
    const before = reads(stage)
    stage.archon.answer(DEFAULT_HEALTH, recorded('0.14.0', 'health'))
    stage.archon.answer(ATTENTION, recorded('0.14.0', 'attention-empty'))
    await stage.clock.advance(2_000)
    assert.equal(mounted.latest().kind, 'connected')
    assert.equal(reads(stage), before + 1)
  })

  test('stops reading when the worker is deactivated', async () => {
    const stage = connectedTo('0.14.0', 'attention-empty')
    const mounted = await stage.mount()
    await mounted.worker.deactivate()
    await stage.clock.advance(5 * SNAPSHOT_SAFETY_MS)
    assert.equal(reads(stage), 1)
    assert.deepEqual(stage.clock.waiting(), [])
  })
})

describe('the "Orchon: Show runs" command', () => {
  test('returns the status sentence and where to go, and posts a show-runs hint saying runs need you', async () => {
    const stage = connectedTo('0.14.0', 'attention-gate')
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    const sentence = await mounted.worker.command('show-runs')
    assert.match(String(sentence), /^1 run needs you on Archon 0\.14\.0 at http:\/\/127\.0\.0\.1:3090\. Open the Orchon panel in the right sidebar\.$/)
    assert.deepEqual(
      mounted.worker.posts.filter((post) => post.event === 'show-runs').map((post) => post.payload),
      [{ at: stage.clock.now(), needsYou: true }]
    )
    // It never toggles the sidebar, nor calls any command of Orca's.
    assert.deepEqual(mounted.host.callsOf('commands.run'), [])
  })

  test("in a state other than Connected, returns that state's sentence and says nothing needs you", async () => {
    const stage = scene()
    stage.disk.folders.add(ARCHON_HOME)
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    assert.equal(await mounted.worker.command('show-runs'), `Archon is not running at ${DEFAULT}.`)
    assert.deepEqual(
      mounted.worker.posts.filter((post) => post.event === 'show-runs').map((post) => post.payload),
      [{ at: stage.clock.now(), needsYou: false }]
    )
  })

  test('is remembered for 60 seconds: a panel that reads the connection then hears of the press', async () => {
    const stage = connectedTo('0.14.0', 'attention-gate')
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    const before = await mounted.worker.request('connection.read')
    assert.equal(Object.hasOwn(before, 'showRuns'), false)
    await mounted.worker.command('show-runs')
    const pressedAt = stage.clock.now()
    await stage.clock.advance(SHOW_RUNS_MEMORY_MS - 1)
    assert.deepEqual((await mounted.worker.request('connection.read')).showRuns, { at: pressedAt, needsYou: true })
    await stage.clock.advance(1)
    assert.equal(Object.hasOwn(await mounted.worker.request('connection.read'), 'showRuns'), false)
  })
})
