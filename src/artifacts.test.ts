// The worker's request protocol seam for a run's artifacts: the worker mounted on a scripted
// Archon, which replays the recorded artifact answers. These tests cover what the worker asks
// Archon for the list and for a file, and the trimmed view models it answers a frame with.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type Release, type Scene, urls } from '../scripts/scripted-archon.ts'
import type { ArtifactAnswer, ArtifactRequest, ArtifactsAnswer, ArtifactsRequest, ArtifactsView } from './artifacts-view'

/** The run each release's artifacts recording holds, read off the fixtures by hand. */
const RECORDED: Record<Release, { id: string; modifiedAt: number }> = {
  '0.12.1': { id: '7c28e1a1-6432-4c9d-89d6-874cfaf81f89', modifiedAt: Date.UTC(2026, 10, 19, 1, 1, 18, 431) },
  '0.13.2': { id: '542b1888-311b-4b65-b005-8b78e33a7c79', modifiedAt: Date.UTC(2026, 10, 19, 1, 3, 16, 756) },
  '0.14.0': { id: '68b479b2-217a-4e84-b86d-ecb9faf394e6', modifiedAt: Date.UTC(2026, 10, 19, 1, 5, 16, 136) }
}

const listUrl = (runId: string): string => `${DEFAULT}/api/runs/${runId}/artifacts`
const fileUrl = (runId: string, encodedPath: string): string => `${DEFAULT}/api/artifacts/${runId}/${encodedPath}`

function connectedScene(release: Release = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  return stage
}

async function list(stage: Scene, input: ArtifactsRequest): Promise<ArtifactsAnswer> {
  const { worker } = await stage.mount()
  return (await worker.request('artifacts.read', input)) as ArtifactsAnswer
}

describe('the artifact list', () => {
  for (const release of RELEASES) {
    test(`reads the recorded list of ${release} into its top level`, async () => {
      const stage = connectedScene(release)
      const run = RECORDED[release]
      stage.archon.answer(listUrl(run.id), recorded(release, 'artifacts', 0))
      const answer = await list(stage, { runId: run.id, open: true })
      assert.equal(answer.connection.kind, 'connected')
      assert.deepEqual(answer.artifacts, {
        kind: 'folder',
        folder: '',
        entries: [{ kind: 'folder', path: 'notes', name: 'notes', files: 1 }],
        notShown: 0,
        total: 1,
        unreadable: 0
      } satisfies ArtifactsView)
    })
  }
})

const FLOOR = RECORDED['0.12.1']

/** A list in Archon's shape: the recorded floor entry, repeated with other paths and sizes. */
function listing(files: readonly (string | { path: string; size?: number; modifiedAt?: unknown })[]): unknown {
  const answer = recorded('0.12.1', 'artifacts', 0)
  if (answer.kind !== 'json') throw new Error('The recorded artifact list is not JSON.')
  const template = (answer.value as { files: Record<string, unknown>[] }).files[0]
  return {
    files: files.map((file) => ({ ...template, ...(typeof file === 'string' ? { path: file } : file) }))
  }
}

/**
 * The shape of the charted run of 8,905 files: one folder whose paths sort before everything
 * else holds nearly all of them, and a few files sit at the top level.
 */
function chartedRun(): string[] {
  const paths: string[] = []
  for (let index = 0; index < 8_900; index += 1) paths.push(`.archon-logs/step-${String(index).padStart(5, '0')}.jsonl`)
  paths.push('plan.md', 'report.md', 'review/notes.md', 'review/summary.txt', 'summary.txt')
  return paths
}

describe('a run of thousands of files', () => {
  test('a file at the top level of the 8,905-file run is reached without the filter', async () => {
    const stage = connectedScene()
    stage.archon.answer(listUrl(FLOOR.id), json(listing(chartedRun())))
    const answer = await list(stage, { runId: FLOOR.id, open: true })
    assert.ok(answer.artifacts.kind === 'folder')
    assert.equal(answer.artifacts.total, 8_905)
    assert.deepEqual(
      answer.artifacts.entries.map((entry) => `${entry.kind} ${entry.path}${entry.kind === 'folder' ? ` (${String(entry.files)})` : ''}`),
      ['folder .archon-logs (8900)', 'folder review (2)', 'file plan.md', 'file report.md', 'file summary.txt']
    )
    assert.equal(answer.artifacts.notShown, 0)
  })

  test('a folder answers at most 200 entries and how many are not shown, from the list read once', async () => {
    const stage = connectedScene()
    stage.archon.answer(listUrl(FLOOR.id), json(listing(chartedRun())))
    const { worker } = await stage.mount()
    await worker.request('artifacts.read', { runId: FLOOR.id, open: true })
    const answer = (await worker.request('artifacts.read', { runId: FLOOR.id, folder: '.archon-logs' })) as ArtifactsAnswer
    assert.ok(answer.artifacts.kind === 'folder')
    assert.equal(answer.artifacts.folder, '.archon-logs')
    assert.equal(answer.artifacts.entries.length, 200)
    assert.deepEqual(answer.artifacts.entries[0], {
      kind: 'file',
      path: '.archon-logs/step-00000.jsonl',
      name: 'step-00000.jsonl',
      size: 52,
      modifiedAt: FLOOR.modifiedAt
    })
    assert.equal(answer.artifacts.entries[199]?.path, '.archon-logs/step-00199.jsonl')
    assert.equal(answer.artifacts.notShown, 8_700)
    assert.equal(urls(stage).filter((url) => url === listUrl(FLOOR.id)).length, 1)
  })
})

describe('the name filter', () => {
  test('answers the paths that hold the filter, in any case, by path, at most 200, with the count that match', async () => {
    const stage = connectedScene()
    stage.archon.answer(listUrl(FLOOR.id), json(listing(chartedRun())))
    const { worker } = await stage.mount()
    await worker.request('artifacts.read', { runId: FLOOR.id, open: true })
    const notes = (await worker.request('artifacts.read', { runId: FLOOR.id, filter: 'SUMMARY' })) as ArtifactsAnswer
    assert.ok(notes.artifacts.kind === 'matches')
    assert.deepEqual(
      notes.artifacts.files.map((file) => file.path),
      ['review/summary.txt', 'summary.txt']
    )
    assert.equal(notes.artifacts.matches, 2)
    assert.equal(notes.artifacts.notShown, 0)
    const logs = (await worker.request('artifacts.read', { runId: FLOOR.id, filter: 'step-' })) as ArtifactsAnswer
    assert.ok(logs.artifacts.kind === 'matches')
    assert.equal(logs.artifacts.files.length, 200)
    assert.equal(logs.artifacts.matches, 8_900)
    assert.equal(logs.artifacts.notShown, 8_700)
    assert.equal(logs.artifacts.filter, 'step-')
  })
})

describe('reading the list at the boundary', () => {
  test('drops and counts an entry it cannot read or could not fetch safely, and keeps a time that does not parse as none', async () => {
    const stage = connectedScene()
    stage.archon.answer(
      listUrl(FLOOR.id),
      json(
        listing([
          'kept.md',
          { path: 'odd-time.md', modifiedAt: 'yesterday' },
          { path: 'kept.md' },
          { path: '' },
          { path: 'a//b.md' },
          { path: '../escape.md' },
          { path: 'a/./b.md' },
          { path: 'no-size.md', size: Number.NaN },
          { path: 'negative.md', size: -1 },
          { path: 'fraction.md', size: 1.5 }
        ])
      )
    )
    const answer = await list(stage, { runId: FLOOR.id, open: true })
    assert.deepEqual(answer.artifacts, {
      kind: 'folder',
      folder: '',
      entries: [
        { kind: 'file', path: 'kept.md', name: 'kept.md', size: 52, modifiedAt: FLOOR.modifiedAt },
        { kind: 'file', path: 'odd-time.md', name: 'odd-time.md', size: 52, modifiedAt: null }
      ],
      notShown: 0,
      total: 2,
      unreadable: 8
    } satisfies ArtifactsView)
  })

  for (const release of RELEASES) {
    test(`a run that ${release} does not have is gone`, async () => {
      const stage = connectedScene(release)
      const unknown = 'orchon-recorder-no-such-run'
      // The seventh answer of each recording is the artifact list's, read off the fixtures by hand.
      stage.archon.answer(listUrl(unknown), recorded(release, 'run-unknown', 6))
      const answer = await list(stage, { runId: unknown, open: true })
      assert.deepEqual(answer.artifacts, { kind: 'gone' })
    })
  }

  test('an answer that is not a list is a failed read, and a fresh open reads the list again', async () => {
    const stage = connectedScene()
    let body: unknown = { files: 'none' }
    stage.archon.answer(listUrl(FLOOR.id), () => json(body))
    const { worker } = await stage.mount()
    const failed = (await worker.request('artifacts.read', { runId: FLOOR.id, open: true })) as ArtifactsAnswer
    assert.equal(failed.artifacts.kind, 'failed')
    body = listing(['one.md'])
    const read = (await worker.request('artifacts.read', { runId: FLOOR.id, open: true })) as ArtifactsAnswer
    assert.ok(read.artifacts.kind === 'folder')
    assert.equal(read.artifacts.total, 1)
    body = listing(['one.md', 'two.md'])
    const kept = (await worker.request('artifacts.read', { runId: FLOOR.id })) as ArtifactsAnswer
    assert.ok(kept.artifacts.kind === 'folder')
    assert.equal(kept.artifacts.total, 1)
    const again = (await worker.request('artifacts.read', { runId: FLOOR.id, open: true })) as ArtifactsAnswer
    assert.ok(again.artifacts.kind === 'folder')
    assert.equal(again.artifacts.total, 2)
  })

  test('refuses a request that is not one, and asks Archon nothing', async () => {
    const stage = connectedScene()
    const { worker } = await stage.mount()
    const before = stage.archon.calls.length
    for (const input of [null, {}, { runId: '' }, { runId: 'r', open: 'yes' }, { runId: 'r', folder: '' }, { runId: 'r', filter: 'x'.repeat(201) }, { runId: 'r', other: 1 }]) {
      await assert.rejects(worker.request('artifacts.read', input as never), { code: 'invalid_params' })
    }
    assert.equal(stage.archon.calls.length, before)
  })
})
