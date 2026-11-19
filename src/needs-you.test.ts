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
import { NEEDS_YOU_UNAVAILABLE, SHOW_RUNS_MEMORY_MS, SNAPSHOT_GAP_MS, SNAPSHOT_SAFETY_MS } from './needs-you'
import type { RunsAnswer, RunsRequest, RunsView } from './runs-view'

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

  test('a run whose attention has no kind cannot be read: the rest still count and the tooltip says one was left out', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, queueOf('0.12.1', [KINDS.gate, { message: 'no kind' }, KINDS.wait]))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    const last = mounted.statusBar().at(-1) as { text: string; tooltip: string }
    assert.equal(last.text, '2 need you')
    assert.match(last.tooltip, /^2 runs need you on Archon 0\.12\.1 at http:\/\/127\.0\.0\.1:3090; 1 waiting run could not be read\.$/)
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

describe('when only the running count cannot be read', () => {
  test('the runs that need you still count, and the tooltip says the running count is unavailable', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(RUNNING, json({ error: 'Failed' }, 500))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    const last = mounted.statusBar().at(-1) as { text: string; tooltip: string }
    assert.equal(last.text, '1 needs you')
    assert.match(last.tooltip, /^1 run needs you on Archon 0\.12\.1 at http:\/\/127\.0\.0\.1:3090; the running count is unavailable\.$/)
  })

  test('with nothing waiting, the item reads "Archon" and the tooltip says the running count is unavailable', async () => {
    const stage = connectedTo('0.12.1', 'attention-empty')
    stage.archon.answer(RUNNING, json({ error: 'Failed' }, 500))
    const mounted = await stage.mount()
    await stage.clock.advance(1_000)
    const last = mounted.statusBar().at(-1) as { text: string; tooltip: string }
    assert.equal(last.text, 'Archon')
    assert.match(last.tooltip, /^The running count is unavailable from Archon 0\.12\.1 at /)
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

describe('the runs table answered from the snapshot', () => {
  const FIRST_PAGE = `${DEFAULT}/api/dashboard/runs?limit=50&offset=0`

  /** The recorded gate run of a release as the snapshot holds it, read off the fixture by hand. */
  const GATE: Record<Release, { id: string; codebaseId: string }> = {
    '0.12.1': { id: 'e7678067-ddb7-44b2-9bec-2d9a049e9c5e', codebaseId: 'cd8c6f17a56a08ff6e8c24143751f5c4' },
    '0.13.2': { id: '122e7550-1d38-43f0-92eb-67ed11e0cd37', codebaseId: '6feec5b110ac5147f1d58ffa49d2790c' },
    '0.14.0': { id: '092f196c-66fc-4beb-9d61-256cb682234e', codebaseId: '4fb57f7e8043f7efd57270977e68c598' }
  }

  async function read(stage: Scene, input: RunsRequest): Promise<RunsView> {
    const mounted = await stage.mount()
    await stage.clock.advance(0)
    return ((await mounted.worker.request('runs.read', input)) as RunsAnswer).runs
  }

  for (const release of RELEASES) {
    test(`${release}: the answer carries the runs that need you, with the gate's question on one line`, async () => {
      const stage = connectedTo(release, 'attention-gate')
      stage.archon.answer(FIRST_PAGE, recorded(release, 'dashboard-runs'))
      const runs = await read(stage, { status: 'all', rows: 25 })
      assert.equal(runs.kind, 'ready')
      if (runs.kind !== 'ready') return
      assert.equal(runs.needsYou?.kind, 'ready')
      if (runs.needsYou?.kind !== 'ready') return
      assert.equal(runs.needsYou.total, 1)
      const [row] = runs.needsYou.rows
      assert.equal(row?.id, GATE[release].id)
      assert.equal(row?.workflow, 'orchon-recorder-gate')
      assert.equal(row?.project, 'orchon-recorder/throwaway-project')
      assert.deepEqual(row?.waiting, { kind: 'gate', question: 'Recorded gate: approve to go on.' })
    })

    test(`${release}: an attention wait carries its question`, async () => {
      const stage = connectedTo(release, 'attention-wait')
      stage.archon.answer(FIRST_PAGE, recorded(release, 'dashboard-runs'))
      const runs = await read(stage, { status: 'all', rows: 25 })
      assert.deepEqual(runs.kind === 'ready' && runs.needsYou?.kind === 'ready' ? runs.needsYou.rows[0]?.waiting : null, {
        kind: 'wait',
        question: 'Recorded question: pick one.'
      })
    })

    test(`${release}: the "Needs you" filter lists the snapshot's runs under the project asked for`, async () => {
      const stage = connectedTo(release, 'attention-gate')
      const { codebaseId, id } = GATE[release]
      stage.archon.answer(`${DEFAULT}/api/dashboard/runs?codebaseId=${codebaseId}&limit=50&offset=0`, recorded(release, 'dashboard-runs', 2))
      stage.archon.answer(`${DEFAULT}/api/dashboard/runs?codebaseId=other&limit=50&offset=0`, recorded(release, 'dashboard-runs-empty'))
      const mine = await read(stage, { status: 'needs-you', rows: 25, codebaseId })
      assert.equal(mine.kind === 'ready' ? mine.total : null, 1)
      assert.deepEqual(mine.kind === 'ready' ? mine.rows.map((row) => row.id) : null, [id])
      const mounted = await stage.mount()
      await stage.clock.advance(0)
      const other = ((await mounted.worker.request('runs.read', { status: 'needs-you', rows: 25, codebaseId: 'other' })) as RunsAnswer).runs
      assert.equal(other.kind === 'ready' ? other.total : null, 0)
      assert.deepEqual(other.kind === 'ready' ? other.needsYou : null, { kind: 'ready', total: 0, rows: [], unreadable: 0 })
    })
  }

  test('the callout holds at most 10 rows in Archon\'s order, with the total beside them', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, queueOf('0.12.1', Array.from({ length: 12 }, () => KINDS.gate)))
    stage.archon.answer(FIRST_PAGE, recorded('0.12.1', 'dashboard-runs'))
    const runs = await read(stage, { status: 'all', rows: 25 })
    const needsYou = runs.kind === 'ready' ? runs.needsYou : undefined
    assert.equal(needsYou?.kind === 'ready' ? needsYou.total : null, 12)
    assert.deepEqual(
      needsYou?.kind === 'ready' ? needsYou.rows.map((row) => row.id) : null,
      Array.from({ length: 10 }, (_, index) => `run-${String(index)}`)
    )
  })

  test('an unreadable run says so in place of a question', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, queueOf('0.12.1', [KINDS.unreadable]))
    stage.archon.answer(FIRST_PAGE, recorded('0.12.1', 'dashboard-runs'))
    const runs = await read(stage, { status: 'all', rows: 25 })
    assert.deepEqual(runs.kind === 'ready' && runs.needsYou?.kind === 'ready' ? runs.needsYou.rows[0]?.waiting : null, { kind: 'unreadable' })
  })

  test('a waiting run that cannot be read is counted as not shown, in the callout and the "Needs you" filter', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, queueOf('0.12.1', [KINDS.gate, { message: 'no kind' }, 'not a record']))
    stage.archon.answer(FIRST_PAGE, recorded('0.12.1', 'dashboard-runs'))
    const all = await read(stage, { status: 'all', rows: 25 })
    const needsYou = all.kind === 'ready' ? all.needsYou : undefined
    assert.deepEqual(needsYou?.kind === 'ready' ? [needsYou.total, needsYou.unreadable] : null, [1, 2])
    const mounted = await stage.mount()
    await stage.clock.advance(0)
    const filtered = ((await mounted.worker.request('runs.read', { status: 'needs-you', rows: 25 })) as RunsAnswer).runs
    assert.deepEqual(filtered.kind === 'ready' ? [filtered.total, filtered.rows.length, filtered.unreadable] : null, [1, 1, 2])
  })

  test('a waiting run that cannot be read counts in the scope of its project, or in every scope when its project cannot be read', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    const queue = queueOf('0.12.1', [{ message: 'no kind' }, { message: 'no kind' }])
    if (queue.kind !== 'json') throw new Error('The scripted queue is not JSON.')
    const [mine, unknown] = field(queue.value, 'runs') as Record<string, unknown>[]
    const runs = [{ ...mine, codebase_id: 'mine' }, { ...unknown, codebase_id: 7 }]
    stage.archon.answer(ATTENTION, { ...queue, value: { ...(queue.value as Record<string, unknown>), runs } })
    stage.archon.answer(`${DEFAULT}/api/dashboard/runs?codebaseId=mine&limit=50&offset=0`, recorded('0.12.1', 'dashboard-runs-empty'))
    stage.archon.answer(`${DEFAULT}/api/dashboard/runs?codebaseId=other&limit=50&offset=0`, recorded('0.12.1', 'dashboard-runs-empty'))
    const unreadable = (view: RunsView): number | null => (view.kind === 'ready' && view.needsYou?.kind === 'ready' ? view.needsYou.unreadable : null)
    assert.equal(unreadable(await read(stage, { status: 'all', rows: 25, codebaseId: 'mine' })), 2)
    const mounted = await stage.mount()
    await stage.clock.advance(0)
    const other = ((await mounted.worker.request('runs.read', { status: 'all', rows: 25, codebaseId: 'other' })) as RunsAnswer).runs
    assert.equal(unreadable(other), 1)
  })

  test('a table row of a run that needs you carries its question, for the preview', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    const page = recorded('0.12.1', 'dashboard-runs')
    if (page.kind !== 'json') throw new Error('The recorded runs answer is not JSON.')
    const [run] = field(page.value, 'runs') as Record<string, unknown>[]
    stage.archon.answer(FIRST_PAGE, { ...page, value: { ...(page.value as Record<string, unknown>), runs: [{ ...run, id: GATE['0.12.1'].id }] } })
    const runs = await read(stage, { status: 'all', rows: 25 })
    assert.deepEqual(runs.kind === 'ready' ? runs.rows[0]?.waiting : null, { kind: 'gate', question: 'Recorded gate: approve to go on.' })
  })

  test('when the snapshot is unavailable the answer says so and the filter fails with one sentence', async () => {
    const stage = connectedTo('0.12.1', 'attention-gate')
    stage.archon.answer(ATTENTION, json({ error: 'Failed' }, 500))
    stage.archon.answer(FIRST_PAGE, recorded('0.12.1', 'dashboard-runs'))
    const all = await read(stage, { status: 'all', rows: 25 })
    assert.deepEqual(all.kind === 'ready' ? all.needsYou : null, { kind: 'unavailable' })
    const mounted = await stage.mount()
    await stage.clock.advance(0)
    const filtered = ((await mounted.worker.request('runs.read', { status: 'needs-you', rows: 25 })) as RunsAnswer).runs
    assert.deepEqual(filtered, { kind: 'failed', message: NEEDS_YOU_UNAVAILABLE })
  })
})
