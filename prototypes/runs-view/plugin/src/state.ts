// PROTOTYPE. State every variant shares: which fixture, which scope, which filter, one loaded
// page of runs. Each variant owns only what it draws.
import { atom, plugin, read, set, update } from 'orca'
import type { Counts, RunRow, Scenario, Scope, StatusFilter } from './protocol'
import './protocol'

export const PAGE = 25

export type VariantKey = 'A' | 'B' | 'C'
export const VARIANTS: { key: VariantKey; name: string }[] = [
  { key: 'A', name: 'Table' },
  { key: 'B', name: 'Sections of cards' },
  { key: 'C', name: 'Grouped tree with preview' }
]

export const variant = atom<VariantKey>('proto.variant', 'A', { persist: 'plugin' })
export const scenario = atom<Scenario>('proto.scenario', 'matched', { persist: 'plugin' })
export const section = atom('proto.section', 'runs')
export const scope = atom<Scope>('proto.scope', 'project')
export const filter = atom<StatusFilter>('proto.filter', 'all')

export const page = atom<{ rows: RunRow[]; total: number; loading: boolean }>({
  rows: [],
  total: 0,
  loading: true
})
export const meta = atom<{
  counts: Counts | null
  projects: { name: string; count: number }[]
  matchedProject: string | null
}>({ counts: null, projects: [], matchedProject: null })
/** The runs waiting on a person, loaded apart from the page so they never scroll out of it. */
export const attention = atom<RunRow[]>([])
/** The run a variant has selected for its preview (A and C). */
export const picked = atom<RunRow | null>(null)
/** The run whose detail is showing, or null for the list. */
export const openRun = atom<RunRow | null>(null)
/** What the last press would have done; the prototype performs nothing. */
export const lastAction = atom('none yet')

export const afterReload: (() => void)[] = []

let requestId = 0

/** Fetches the first page again, plus the attention runs. A newer call wins over an older answer. */
export async function reload(): Promise<void> {
  const mine = ++requestId
  update(page, (previous) => ({ ...previous, loading: true }))
  const base = { scenario: read(scenario), scope: read(scope) }
  const [first, waiting] = await Promise.all([
    plugin.request('runs.list', { ...base, status: read(filter), offset: 0, limit: PAGE }),
    plugin.request('runs.list', { ...base, status: 'attention', offset: 0, limit: 10 })
  ])
  if (mine !== requestId) return
  set(page, { rows: first.rows, total: first.total, loading: false })
  set(meta, { counts: first.counts, projects: first.projects, matchedProject: first.matchedProject })
  set(attention, waiting.rows)
  for (const callback of afterReload) callback()
}

export async function loadMore(): Promise<void> {
  const current = read(page)
  if (current.loading || current.rows.length >= current.total) return
  const mine = ++requestId
  set(page, { ...current, loading: true })
  const next = await plugin.request('runs.list', {
    scenario: read(scenario),
    scope: read(scope),
    status: read(filter),
    offset: current.rows.length,
    limit: PAGE
  })
  if (mine !== requestId) return
  set(page, { rows: [...current.rows, ...next.rows], total: next.total, loading: false })
}

export function setFilter(next: StatusFilter): void {
  set(filter, next)
  void reload()
}

export function setScope(next: Scope): void {
  set(scope, next)
  void reload()
}

export function setScenario(next: Scenario): void {
  set(scenario, next)
  set(openRun, null)
  void reload()
}

export function note(action: string): void {
  set(lastAction, action)
}
