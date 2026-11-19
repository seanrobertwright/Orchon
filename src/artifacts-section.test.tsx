// The frame seam for Artifacts in run detail: src/panel.tsx mounted on a scripted worker that
// answers the runs table, run detail and a run's artifacts. These tests cover what Artifacts
// draws and which requests it sends.
import { mock } from 'node:test'
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
const MATCHES = { type: 'Tree', label: 'Matching artifacts' }

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
  read?: (request: ArtifactRequest) => ArtifactView | Promise<ArtifactView>
}

function defaultList(request: ArtifactsRequest): ArtifactsView {
  if (request.filter !== undefined) return { kind: 'matches', filter: request.filter, files: [file('review/summary.txt'), file('summary.txt', 1_536)], matches: 2, notShown: 0, total: 8_903, unreadable: 0 }
  return request.folder === 'logs' ? LOGS : TOP
}

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

/** The frame's timers, Node's mocked ones, moved by hand from here on in the test. */
const handTimers = (): void => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 18, 12) })

async function advance(view: TestPanel, ms: number): Promise<void> {
  mock.timers.tick(ms)
  await view.settled()
}

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
        'artifact.read': async (request: ArtifactRequest) => ({ connection: connected, artifact: await readFile(request) })
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

describe('folders', () => {
  test('a folder asks for its entries when it is opened, and ends with a row saying how many are not shown', async () => {
    const view = await openRun()
    await view.select(SHOW, 'artifacts')
    await view.expand(TREE, 'folder:logs')
    assert.deepEqual(requests(view, 'artifacts.read'), [{ runId: 'run-1', open: true }, { runId: 'run-1', folder: 'logs' }])
    const shown = rows(view)
    assert.equal(shown.length, 4 + 200 + 1)
    assert.equal(shown[1], '  step-0000.jsonl · 2 KiB')
    assert.equal(shown[201], '  8,700 more entries are not shown · Use the filter to find it')
    assert.equal(shown[202], 'review · 1 file')
    // Opened again, the folder is not asked for again.
    await view.collapse(TREE, 'folder:logs')
    await view.expand(TREE, 'folder:logs')
    assert.equal(requests(view, 'artifacts.read').length, 2)
    clean(view)
  })

  test('the top level also ends with a row for what it does not show', async () => {
    const view = await openRun({ list: () => ({ ...TOP, notShown: 1 }) })
    await view.select(SHOW, 'artifacts')
    assert.equal(rows(view).at(-1), '1 more entry is not shown · Use the filter to find it')
  })
})

describe('the name filter', () => {
  test('while it has text, the tree is replaced by the matching paths and a count line, asked for after a pause in typing', async () => {
    handTimers()
    const view = await openRun()
    await view.select(SHOW, 'artifacts')
    await view.type(FILTER, 'sum')
    await advance(view, 299)
    assert.equal(requests(view, 'artifacts.read').length, 1)
    await advance(view, 1)
    assert.deepEqual(requests(view, 'artifacts.read').at(-1), { runId: 'run-1', filter: 'sum' })
    assert.equal(view.find(TREE), null)
    assert.deepEqual(rows(view, MATCHES), ['review/summary.txt · 2 KiB', 'summary.txt · 1.5 KiB'])
    assert.ok(view.find({ type: 'Text', text: '2 files match.' }))
    await view.type(FILTER, '', { replace: true })
    assert.ok(view.find(TREE))
    assert.equal(view.find(MATCHES), null)
    assert.equal(requests(view, 'artifacts.read').length, 2)
    clean(view)
  })

  test('says how many match and how many are not shown when more than 200 match', async () => {
    handTimers()
    const many: ArtifactsView = { kind: 'matches', filter: 'step', files: LOGS.kind === 'folder' ? LOGS.entries.filter((entry) => entry.kind === 'file') : [], matches: 8_900, notShown: 8_700, total: 8_903, unreadable: 0 }
    const view = await openRun({ list: (request) => (request.filter === undefined ? TOP : many) })
    await view.select(SHOW, 'artifacts')
    await view.type(FILTER, 'step')
    await advance(view, 300)
    assert.equal(rows(view, MATCHES).length, 200)
    assert.ok(view.find({ type: 'Text', text: '8,900 files match; 8,700 are not shown. Type more of the name to narrow it.' }))
  })

  test('a timer still waiting is cleared when the panel closes', async () => {
    handTimers()
    const view = await openRun()
    await view.select(SHOW, 'artifacts')
    await view.type(FILTER, 'sum')
    await view.unmount()
    panel = undefined
    mock.timers.tick(1_000)
    assert.equal(requests(view, 'artifacts.read').length, 1)
  })
})

describe('a file', () => {
  const MD = '# Plan\n\nSee [the guide](https://example.com/guide) and [this](javascript:alert(1)).\n'

  test('selecting a Markdown file asks for it and shows its path, size and modified time, then its text unchanged', async () => {
    const view = await openRun({ read: (request) => ({ kind: 'ready', file: file(request.path, 52), content: { kind: 'markdown', blocks: [MD] } }) })
    await view.select(SHOW, 'artifacts')
    await view.selectItem(TREE, 'file:plan.md')
    assert.deepEqual(requests(view, 'artifact.read'), [{ runId: 'run-1', path: 'plan.md' }])
    const facts = view.find({ type: 'KeyValue', label: 'Artifact facts' })?.props.items as { label: string; value: unknown }[]
    assert.deepEqual(
      facts.map((item) => item.label),
      ['Path', 'Size', 'Modified']
    )
    assert.equal(facts[0]?.value, 'plan.md')
    assert.equal(facts[1]?.value, '52 bytes')
    assert.notEqual(facts[2]?.value, 'Not known')
    assert.equal(view.findAll({ type: 'Markdown' }).length, 1)
    assert.equal(view.find({ type: 'Markdown' })?.props.content, MD)
    clean(view)
  })

  test('plain text is drawn block by block as read-only text, each block named', async () => {
    const view = await openRun({ read: (request) => ({ kind: 'ready', file: file(request.path), content: { kind: 'text', blocks: ['one\n', 'two\n'] } }) })
    await view.select(SHOW, 'artifacts')
    await view.selectItem(TREE, 'file:summary.txt')
    const blocks = view.findAll({ type: 'CodeView' })
    assert.deepEqual(
      blocks.map((block) => [block.props.label, block.props.code]),
      [
        ['Contents of summary.txt, part 1 of 2', 'one\n'],
        ['Contents of summary.txt, part 2 of 2', 'two\n']
      ]
    )
    assert.equal(view.find({ type: 'Markdown' }), null)
  })

  for (const [kind, sentence] of [
    ['too-large', 'This file is larger than 256 KiB, so it is not shown here.'],
    ['not-text', 'This file is not text, so it is not shown here.']
  ] as const) {
    test(`a file that is ${kind} shows only its path and size`, async () => {
      const view = await openRun({ read: (request) => ({ kind: 'ready', file: file(request.path, 300_000), content: { kind } }) })
      await view.select(SHOW, 'artifacts')
      await view.selectItem(TREE, 'file:summary.txt')
      const facts = view.find({ type: 'KeyValue', label: 'Artifact facts' })?.props.items as { label: string; value: unknown }[]
      assert.deepEqual(
        facts.map((item) => `${item.label}: ${String(item.value)}`),
        ['Path: summary.txt', 'Size: 293 KiB']
      )
      assert.ok(view.find({ type: 'Text', text: sentence }))
      assert.equal(view.find({ type: 'CodeView' }), null)
      assert.equal(view.find({ type: 'Markdown' }), null)
    })
  }

  test('a file chosen from the matches is asked for the same way', async () => {
    handTimers()
    const view = await openRun()
    await view.select(SHOW, 'artifacts')
    await view.type(FILTER, 'sum')
    await advance(view, 300)
    await view.selectItem(MATCHES, 'file:review/summary.txt')
    assert.deepEqual(requests(view, 'artifact.read'), [{ runId: 'run-1', path: 'review/summary.txt' }])
    assert.ok(view.find({ type: 'CodeView', label: 'Contents of summary.txt' }))
  })

  test('only the answer for the file chosen last is shown, though an earlier one arrives after it', async () => {
    let calls = 0
    const view = await openRun({
      read: async (request) => {
        calls += 1
        // The first file's answer is held back until after the second's.
        if (request.path === 'plan.md') await new Promise((resolve) => setTimeout(resolve, 50))
        return { kind: 'ready', file: file(request.path), content: { kind: 'text', blocks: [`${request.path}\n`] } }
      }
    })
    await view.select(SHOW, 'artifacts')
    const first = view.selectItem(TREE, 'file:plan.md')
    const second = view.selectItem(TREE, 'file:summary.txt')
    await Promise.race([Promise.all([first, second]), new Promise((_, reject) => setTimeout(() => reject(new Error('The selections did not settle.')), 5_000))])
    assert.equal(calls, 2)
    assert.deepEqual(
      view.findAll({ type: 'CodeView' }).map((block) => block.props.code),
      ['summary.txt\n']
    )
  })
})
