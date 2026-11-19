// The worker's request protocol seam: the worker mounted on a scripted Archon, which replays the
// recorded run detail answers. These tests cover run detail's request: what the worker asks
// Archon, and the trimmed view model it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, recorded, RELEASES, scene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import type { RunDetailAnswer, RunDetailRequest } from './run-detail-view'

const RUN_PATH = `${DEFAULT}/api/workflows/runs/`
const CODEBASES = `${DEFAULT}/api/codebases`

/** A scene connected to the default address, with health answering as `release`. */
function connectedScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  return stage
}

async function readDetail(stage: Scene, input: RunDetailRequest): Promise<RunDetailAnswer> {
  const { worker } = await stage.mount()
  return (await worker.request('run.read', input)) as RunDetailAnswer
}

/** The run each release's run-detail recording holds, read off the fixtures by hand. */
const RECORDED: Record<Release, { id: string; started: number; ended: number; durationMs: number }> = {
  '0.12.1': {
    id: '7c28e1a1-6432-4c9d-89d6-874cfaf81f89',
    started: Date.UTC(2026, 10, 19, 1, 1, 15),
    ended: Date.UTC(2026, 10, 19, 1, 1, 18),
    durationMs: 207
  },
  '0.13.2': {
    id: '542b1888-311b-4b65-b005-8b78e33a7c79',
    started: Date.UTC(2026, 10, 19, 1, 3, 14),
    ended: Date.UTC(2026, 10, 19, 1, 3, 16),
    durationMs: 257
  },
  '0.14.0': {
    id: '68b479b2-217a-4e84-b86d-ecb9faf394e6',
    started: Date.UTC(2026, 10, 19, 1, 5, 13),
    ended: Date.UTC(2026, 10, 19, 1, 5, 16),
    durationMs: 507
  }
}

describe('the run detail request', () => {
  for (const release of RELEASES) {
    test(`reads the recorded run of ${release} into the trimmed view model`, async () => {
      const stage = connectedScene(release)
      const run = RECORDED[release]
      stage.archon.answer(`${RUN_PATH}${run.id}`, recorded(release, 'run-detail'))
      stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
      const answer = await readDetail(stage, { runId: run.id, open: true })
      assert.equal(answer.connection.kind, 'connected')
      assert.deepEqual(answer.run, {
        kind: 'ready',
        detail: {
          id: run.id,
          workflow: 'orchon-recorder-echo',
          status: 'completed',
          startedAt: run.started,
          endedAt: run.ended,
          costUsd: null,
          project: 'orchon-recorder/throwaway-project',
          workingPath: '<project-path>',
          message: 'Recording a launch for Orchon: one shell step.',
          messageCut: false,
          steps: [
            { id: 'write', name: 'write', kind: 'exec', state: 'completed', loop: null, starts: 1, durationMs: run.durationMs, reached: true }
          ],
          stepCount: 1,
          unreadableSteps: 0,
          waiting: null
        }
      })
    })
  }
})
