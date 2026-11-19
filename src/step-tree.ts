// Run detail's step list as a tree: a row per step with its glyph, name, shortest duration and
// "ran N times"; a loop is a branch holding its inner steps; the steps the run has not reached
// sit in one branch at the end. It is pure logic on the worker's step list, which arrives in
// the tree's order, and is built once per answer, not per render. The panel loads this file, so
// it imports nothing but types and the date helper.
import type { TreeItem } from 'orca'
import { formatDuration } from './dates'
import type { Step } from './run-detail-view'
import type { RunStatus } from './runs-view'

/** The key of the branch that holds the steps not reached. */
export const NOT_REACHED_KEY = 'not-reached'

/** A step's row key. Keys are unique across the tree's levels, and no step's key is the branch's. */
export const stepKey = (id: string): string => `step:${id}`

/** A step's state as a glyph and a word. A running step of a paused run is waiting. */
export function stepWords(step: Step, run: RunStatus): { glyph: string; word: string } {
  switch (step.state) {
    case 'running':
      return run === 'paused' ? { glyph: '‖', word: 'Waiting' } : { glyph: '●', word: 'Running' }
    case 'completed':
      return { glyph: '✓', word: 'Completed' }
    case 'failed':
      return { glyph: '✕', word: 'Failed' }
    case 'skipped':
      return { glyph: '−', word: 'Skipped' }
    case 'pending':
      return { glyph: '○', word: step.reached ? 'Queued' : 'Not reached' }
  }
}

/** "ran N times" for a step that started more than once, or null. */
export const ranTimes = (step: Step): string | null => (step.starts > 1 ? `ran ${String(step.starts)} times` : null)

export type StepTree = {
  items: TreeItem[]
  /** The keys of the branches open by default: every loop. The steps not reached are shut. */
  loops: string[]
  /** Each step by its row key. */
  byKey: Map<string, Step>
}

type Branch = TreeItem & { children: Branch[] }

/** A branch without an empty list of children, so a step that holds none draws as a row. */
function finish(item: Branch): TreeItem {
  const { children, ...row } = item
  return children.length === 0 ? row : { ...row, children: children.map(finish) }
}

/**
 * The tree of a step list given in the tree's order, each loop before its inner steps. An inner
 * step sits under its loop wherever the loop is; a step at the top that the run has not reached
 * goes in the "Not reached" branch with its inner steps.
 */
export function buildStepTree(steps: readonly Step[], run: RunStatus): StepTree {
  const byKey = new Map<string, Step>()
  const rows = new Map<string, Branch>()
  const top: Branch[] = []
  const notReached: Branch[] = []
  /** The ids of the steps inside the "Not reached" branch, at any depth. */
  const inBranch = new Set<string>()
  const loops: string[] = []
  for (const step of steps) {
    const key = stepKey(step.id)
    byKey.set(key, step)
    const duration = step.durationMs === null ? '' : formatDuration(step.durationMs)
    const description = [duration, ranTimes(step) ?? ''].filter((part) => part !== '').join(' · ')
    const row: Branch = { key, label: `${stepWords(step, run).glyph} ${step.name}`, children: [] }
    if (description !== '') row.description = description
    rows.set(step.id, row)
    const loop = step.loop === null ? undefined : rows.get(step.loop)
    if (loop !== undefined) {
      if (loop.children.length === 0) loops.push(loop.key)
      loop.children.push(row)
      if (step.loop !== null && inBranch.has(step.loop)) inBranch.add(step.id)
    } else if (step.reached) {
      top.push(row)
    } else {
      notReached.push(row)
      inBranch.add(step.id)
    }
  }
  const items = top.map(finish)
  if (notReached.length > 0) {
    items.push({ key: NOT_REACHED_KEY, label: `Not reached (${String(inBranch.size)})`, children: notReached.map(finish) })
  }
  return { items, loops, byKey }
}
