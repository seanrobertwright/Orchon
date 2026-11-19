// Pure logic of the pointer files (#33, "The panel shell"): their names, their content and which
// of a folder's files a sweep deletes. No disk: the sweep is planned from a listing.
import { assert, describe, test } from 'orca/testing'
import { POINTER_AGE_CAP_MS, POINTER_COUNT_CAP, runPointerName, runPointerText, sweepPlan } from './pointer-files'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)

describe('a run graph pointer file name', () => {
  test('is the workflow, a dash and the first 8 characters of the run id, with the run suffix', () => {
    assert.equal(runPointerName('archon-build-queue', '7c28e1a1-6432-4c9d-89d6-874cfaf81f89'), 'archon-build-queue-7c28e1a1.orchonrun')
  })

  test('cleans the workflow name to safe characters first', () => {
    assert.equal(runPointerName('my flow/../x:y', 'abcdef0123'), 'my-flow-x-y-abcdef01.orchonrun')
    assert.equal(runPointerName('Café «ship»', 'abcdef0123'), 'Caf-ship-abcdef01.orchonrun')
    assert.equal(runPointerName('..', 'abcdef0123'), 'workflow-abcdef01.orchonrun')
  })

  test('caps the workflow part at 60 characters', () => {
    const name = runPointerName('a'.repeat(200), 'abcdef0123')
    assert.equal(name, `${'a'.repeat(60)}-abcdef01.orchonrun`)
  })

  test('cleans the run id part too', () => {
    assert.equal(runPointerName('flow', '../../ab'), 'flow-ab.orchonrun')
    assert.equal(runPointerName('flow', '////'), 'flow-run.orchonrun')
  })
})

describe('a run graph pointer file content', () => {
  test("holds the run's identity as JSON", () => {
    assert.deepEqual(JSON.parse(runPointerText('7c28e1a1-6432')), { orchon: 'run-graph', runId: '7c28e1a1-6432' })
  })
})

describe('the sweep of .orchon/', () => {
  const file = (name: string, ageDays: number) => ({ name, modifiedMs: NOW - ageDays * DAY, file: true })

  test('the caps are 7 days and 20 files', () => {
    assert.equal(POINTER_AGE_CAP_MS, 7 * DAY)
    assert.equal(POINTER_COUNT_CAP, 20)
  })

  test('deletes its own pointer files older than 7 days', () => {
    const plan = sweepPlan([file('a-1.orchonrun', 8), file('b-2.orchonflow', 7.5), file('c-3.orchonrun', 6)], NOW)
    assert.deepEqual(plan.sort(), ['a-1.orchonrun', 'b-2.orchonflow'])
  })

  test('keeps at most the newest 20 of its own pointer files', () => {
    const entries = Array.from({ length: 25 }, (_, index) => file(`run-${String(index)}.orchonrun`, index / 10))
    assert.deepEqual(sweepPlan(entries, NOW), ['run-20.orchonrun', 'run-21.orchonrun', 'run-22.orchonrun', 'run-23.orchonrun', 'run-24.orchonrun'])
  })

  test('never deletes anything else: the .gitignore, other files, folders, or look-alike names', () => {
    const entries = [
      file('.gitignore', 30),
      file('notes.txt', 30),
      file('run.orchonrun.bak', 30),
      file('.orchonrun', 30),
      file('a b.orchonrun', 30),
      { name: 'old.orchonrun', modifiedMs: NOW - 30 * DAY, file: false }
    ]
    assert.deepEqual(sweepPlan(entries, NOW), [])
  })

  test('a file the caller keeps is never deleted, however old', () => {
    // Ages of 0 to 20 days: 7 days exactly is not older than 7 days.
    const entries = Array.from({ length: 21 }, (_, index) => file(`run-${String(index)}.orchonrun`, index))
    assert.deepEqual(sweepPlan(entries, NOW, 'run-20.orchonrun'), Array.from({ length: 12 }, (_, index) => `run-${String(index + 8)}.orchonrun`))
  })
})
