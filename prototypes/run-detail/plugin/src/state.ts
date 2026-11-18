// PROTOTYPE. State every variant shares: where the panel is (runs table, run detail or a step
// view) and what it has loaded. Each variant owns only what it draws.
import { atom, plugin, read, set, update } from 'orca'
import type {
  ArtifactBody,
  Focus,
  ArtifactList,
  ItemPreview,
  ItemRow,
  RunDetail,
  RunTab,
  Scenario,
  Split,
  StepView
} from './protocol'
import './protocol'

export type VariantKey = 'A' | 'B' | 'C'
export const VARIANTS: { key: VariantKey; name: string }[] = [
  { key: 'A', name: 'Tables' },
  { key: 'B', name: 'Cards and lists' },
  { key: 'C', name: 'Outline: trees and folds' }
]

// Where the panel is. Persisted, so a check scenario or a reload can start at any level.
export const variant = atom<VariantKey>('proto.variant', 'A', { persist: 'plugin' })
/** The open run, or null for the runs table. */
export const openRun = atom<Scenario | null>('proto.run', null, { persist: 'plugin' })
/** The open step, or null for run detail. */
export const openStep = atom<string | null>('proto.step', null, { persist: 'plugin' })
export const tab = atom<RunTab>('proto.tab', 'steps', { persist: 'plugin' })
export const itemKey = atom<string | null>('proto.item', null, { persist: 'plugin' })
export const artifactPath = atom<string | null>('proto.artifact', null, { persist: 'plugin' })
export const filter = atom('proto.filter', '', { persist: 'plugin' })
export const split = atom<Split>('proto.split', 'lines', { persist: 'plugin' })

/** Capture aid only: which part of a screen is drawn. A person always sees `all`. */
export const focus = atom<Focus>('proto.focus', 'all')

export const section = atom('proto.section', 'runs')
export const pickedRun = atom<Scenario | null>(null)
export const pickedStep = atom<string | null>(null)

export const run = atom<RunDetail | null>(null)
export const stepView = atom<StepView | null>(null)
export const activity = atom<{ rows: ItemRow[]; earlier: number; loading: boolean }>({ rows: [], earlier: 0, loading: false })
export const item = atom<ItemPreview | null>(null)
export const artifacts = atom<(ArtifactList & { loading: boolean }) | null>(null)
export const artifact = atom<ArtifactBody | null>(null)
/** What the last press would have done; the prototype performs nothing. */
export const lastAction = atom('none yet')

let requestId = 0

/** Loads whatever the position atoms point at. A newer call wins over an older answer. */
export async function restore(): Promise<void> {
  const mine = ++requestId
  const scenario = read(openRun)
  if (!scenario) {
    set(run, null)
    return
  }
  const detail = await plugin.request('run.get', { scenario })
  if (mine !== requestId) return
  set(run, detail)

  const step = read(openStep)
  if (step) {
    const [view, page] = await Promise.all([
      plugin.request('step.get', { scenario, step }),
      plugin.request('activity.page', { scenario, step, before: null })
    ])
    if (mine !== requestId) return
    set(stepView, view)
    set(activity, { ...page, loading: false })
    const key = read(itemKey)
    if (key) {
      const preview = await plugin.request('activity.item', { scenario, step, key })
      if (mine !== requestId) return
      set(item, preview)
    } else {
      set(item, null)
    }
    return
  }
  set(stepView, null)
  if (read(tab) === 'artifacts') {
    update(artifacts, (previous) => (previous ? { ...previous, loading: true } : null))
    const list = await plugin.request('artifacts.list', { scenario, filter: read(filter) })
    if (mine !== requestId) return
    set(artifacts, { ...list, loading: false })
    const path = read(artifactPath)
    if (path) {
      const body = await plugin.request('artifact.read', { scenario, path, split: read(split) })
      if (mine !== requestId) return
      set(artifact, body)
    } else {
      set(artifact, null)
    }
  }
}

export function goRuns(): void {
  set(openRun, null)
  set(openStep, null)
  set(run, null)
  void restore()
}

export function goRun(scenario: Scenario): void {
  set(openRun, scenario)
  set(openStep, null)
  set(tab, 'steps')
  set(pickedStep, null)
  set(itemKey, null)
  set(artifactPath, null)
  set(filter, '')
  set(artifacts, null)
  set(run, null)
  void restore()
}

export function goStep(step: string): void {
  set(openStep, step)
  set(itemKey, null)
  set(item, null)
  set(stepView, null)
  set(activity, { rows: [], earlier: 0, loading: true })
  void restore()
}

/** Back from a step view. The step that was open stays selected in the step list. */
export function backToRun(): void {
  set(pickedStep, read(openStep))
  set(openStep, null)
  void restore()
}

export function setTab(next: RunTab): void {
  set(tab, next)
  void restore()
}

export function setFilter(next: string): void {
  set(filter, next)
  set(artifactPath, null)
  void restore()
}

let previewId = 0

/** Selecting a file fetches only that file; the list stays as it is. */
export async function pickArtifact(path: string | null): Promise<void> {
  const mine = ++previewId
  set(artifactPath, path)
  const scenario = read(openRun)
  if (!path || !scenario) {
    set(artifact, null)
    return
  }
  const body = await plugin.request('artifact.read', { scenario, path, split: read(split) })
  if (mine === previewId) set(artifact, body)
}

export function setSplit(next: Split): void {
  set(split, next)
  void pickArtifact(read(artifactPath))
}

/** Selecting an item fetches only that item, at that moment; loaded pages stay as they are. */
export async function pickItem(key: string | null): Promise<void> {
  const mine = ++previewId
  set(itemKey, key)
  const scenario = read(openRun)
  const step = read(openStep)
  if (!key || !scenario || !step) {
    set(item, null)
    return
  }
  const preview = await plugin.request('activity.item', { scenario, step, key })
  if (mine === previewId) set(item, preview)
}

export async function showEarlier(): Promise<void> {
  const current = read(activity)
  const scenario = read(openRun)
  const step = read(openStep)
  const first = current.rows[0]
  if (current.loading || current.earlier === 0 || !scenario || !step || !first) return
  const mine = ++requestId
  set(activity, { ...current, loading: true })
  const page = await plugin.request('activity.page', { scenario, step, before: first.key })
  if (mine !== requestId) return
  set(activity, { rows: [...page.rows, ...current.rows], earlier: page.earlier, loading: false })
}

export function note(action: string): void {
  set(lastAction, action)
}
