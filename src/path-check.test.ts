// The worker's request protocol seam: the worker mounted on a scripted Archon, clock and disk.
// These tests cover the path check: after health confirms a server, the worker reads its path
// list and decides Supported or Unsupported from the paths alone, never from the version.
import { assert, describe, test } from 'orca/testing'
import {
  CLOCK_START as START,
  DEFAULT_HEALTH,
  health,
  recorded,
  scene,
  type MountedScene
} from '../scripts/scripted-archon.ts'

const DEFAULT = 'http://127.0.0.1:3090'
const DEFAULT_OPENAPI = `${DEFAULT}/api/openapi.json`

const kinds = (mounted: MountedScene): string[] => mounted.posted().map((state) => state.kind)
const urls = (stage: { archon: { calls: { url: string }[] } }): string[] => stage.archon.calls.map((call) => call.url)

describe('the path check', () => {
  test('reads the path list after health and before Connected, and a full list connects', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ storeId: 'store-a' }))
    stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
    const mounted = await stage.mount()
    assert.deepEqual(urls(stage), [DEFAULT_HEALTH, DEFAULT_OPENAPI])
    assert.deepEqual(kinds(mounted), ['searching', 'connected'])
    const state = mounted.latest()
    assert.equal(state.kind, 'connected')
    assert.deepEqual(state.kind === 'connected' && state.features, { metrics: true })
    assert.equal(state.since, START + 2)
  })
})
