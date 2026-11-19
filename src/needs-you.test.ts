// The worker's request protocol seam: the snapshot of runs that need you. The worker is mounted
// on a scripted Archon that replays the recorded attention answers of every supported release,
// and these tests assert the calls made to Archon, the status bar item and what a frame is told.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  recorded,
  RELEASES,
  scene,
  type Release,
  type Scene
} from '../scripts/scripted-archon.ts'

const ATTENTION = `${DEFAULT}/api/runs/attention`
const RUNNING = `${DEFAULT}/api/dashboard/runs?limit=1`

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
