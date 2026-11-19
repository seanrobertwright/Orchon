// The worker's request protocol seam: desktop notifications. The worker is mounted on a scripted
// Archon that replays the recorded attention answers, and these tests assert the
// `notifications.show` calls Orca is sent and the calls made to Archon.
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

describe('a run that newly needs you', () => {
  for (const release of RELEASES) {
    test(`${release}: a recorded gate that opens after the first read notifies once, with the workflow name and the project`, async () => {
      const stage = connectedTo(release)
      const mounted = await stage.mount()
      await stage.clock.advance(1_000)
      stage.archon.answer(ATTENTION, recorded(release, 'attention-gate'))
      await stage.clock.advance(SNAPSHOT_SAFETY_MS)
      assert.deepEqual(mounted.host.callsOf('notifications.show'), [])
      await stage.clock.advance(5_000)
      assert.deepEqual(mounted.host.callsOf('notifications.show'), [
        { title: 'orchon-recorder-gate', body: 'Waiting for your decision · orchon-recorder/throwaway-project' }
      ])
      await stage.clock.advance(3 * SNAPSHOT_SAFETY_MS)
      assert.equal(mounted.host.callsOf('notifications.show').length, 1)
    })
  }
})
