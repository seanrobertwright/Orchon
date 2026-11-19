// The frame seam for Artifacts in run detail: src/panel.tsx mounted on a scripted worker that
// answers the runs table, run detail and a run's artifacts. These tests cover what Artifacts
// draws and which requests it sends.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected } from '../scripts/connection-samples.ts'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import type { ArtifactFile, ArtifactRequest, ArtifactsRequest, ArtifactsView, ArtifactView } from './artifacts-view'
import * as panelModule from './panel'
import type { RunDetailView } from './run-detail-view'
import type { RunsRequest, RunsView } from './runs-view'

const TABLE = { type: 'Table', label: 'Runs' }
const SHOW = { type: 'Select', label: 'Show' }
const TREE = { type: 'Tree', label: 'Artifacts' }
const FILTER = { type: 'Input', label: 'Filter artifacts by name' }

/** When the sample files were last changed: 10:30 UTC on 18 November 2026. */
const MODIFIED = Date.UTC(2026, 10, 18, 10, 30, 0)

const file = (path: string, size = 2_048): ArtifactFile => ({ path, name: path.slice(path.lastIndexOf('/') + 1), size, modifiedAt: MODIFIED })

/** The top level of a run: a large folder, a small one, then two files. */
const TOP: ArtifactsView = {
  kind: 'folder',
  folder: '',
  entries: [
    { kind: 'folder', path: 'logs', name: 'logs', files: 8_900 },
    { kind: 'folder', path: 'review', name: 'review', files: 1 },
    { kind: 'file', ...file('plan.md', 52) },
    { kind: 'file', ...file('summary.txt', 1_536) }
  ],
  notShown: 0,
  total: 8_903,
  unreadable: 0
}

/** The large folder: its first 200 files and the 8,700 not shown. */
const LOGS: ArtifactsView = {
  kind: 'folder',
  folder: 'logs',
  entries: Array.from({ length: 200 }, (_, index) => ({ kind: 'file' as const, ...file(`logs/step-${String(index).padStart(4, '0')}.jsonl`) })),
  notShown: 8_700,
  total: 8_903,
  unreadable: 0
}

type Script = {
  list?: (request: ArtifactsRequest) => ArtifactsView
  read?: (request: ArtifactRequest) => ArtifactView
}

function defaultList(request: ArtifactsRequest): ArtifactsView {
  if (request.filter !== undefined) return { kind: 'matches', filter: request.filter, files: [file('review/summary.txt'), file('summary.txt', 1_536)], matches: 2, notShown: 0, total: 8_903, unreadable: 0 }
  return request.folder === 'logs' ? LOGS : TOP
}

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

async function openRun(script: Script = {}): Promise<TestPanel> {
  const detail = (): RunDetailView => ({ kind: 'ready', detail: sampleDetail(1) })
  const base = answeringRun((request: RunsRequest): RunsView => busyRuns(10, request), detail)
  const list = script.list ?? defaultList
  const readFile = script.read ?? ((request: ArtifactRequest): ArtifactView => ({ kind: 'ready', file: file(request.path), content: { kind: 'text', blocks: ['text\n'] } }))
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...base.requests,
        'artifacts.read': (request: ArtifactsRequest) => ({ connection: connected, artifacts: list(request) }),
        'artifact.read': (request: ArtifactRequest) => ({ connection: connected, artifact: readFile(request) })
      }
    })
  })
  await panel.activateRow(TABLE, 'run-1')
  return panel
}

function requests(view: TestPanel, name: string): unknown[] {
  return view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === name)
    .map((params) => (params as { input: unknown }).input)
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/** The labels and descriptions of a tree's items, a child indented under its parent. */
function rows(view: TestPanel, target = TREE): string[] {
  const tree = view.find(target)
  const items = (tree?.props.items ?? []) as { label: string; description?: string; children?: unknown[]; hasChildren?: boolean }[]
  const out: string[] = []
  const walk = (level: typeof items, depth: number): void => {
    for (const item of level) {
      out.push(`${'  '.repeat(depth)}${item.label}${item.description === undefined ? '' : ` · ${item.description}`}`)
      walk((item.children ?? []) as typeof items, depth + 1)
    }
  }
  walk(items, 0)
  return out
}

describe('opening Artifacts', () => {
  test('asks for the list only when Artifacts is chosen, and draws folders with their file count, then files with their size', async () => {
    const view = await openRun()
    assert.deepEqual(requests(view, 'artifacts.read'), [])
    await view.select(SHOW, 'artifacts')
    assert.deepEqual(requests(view, 'artifacts.read'), [{ runId: 'run-1', open: true }])
    assert.deepEqual(rows(view), ['logs · 8,900 files', 'review · 1 file', 'plan.md · 52 bytes', 'summary.txt · 1.5 KiB'])
    assert.ok(view.find(FILTER))
    clean(view)
  })
})
