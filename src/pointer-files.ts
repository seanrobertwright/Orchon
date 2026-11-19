// Pointer files (#33, "The panel shell"): the files the worker writes into `.orchon/` at the root
// of the focused local workspace so Orca opens a wide tab on them. This module is pure logic:
// their names, their content and which of the folder's files a sweep deletes. The writes go
// through the disk module, in `wide-tabs.ts`.

/** The folder at the workspace root that holds the pointer files and nothing else of the plugin's. */
export const POINTER_FOLDER = '.orchon'
/** What the folder's `.gitignore` holds, so nothing in it shows in Git. */
export const GITIGNORE_TEXT = '*\n'
export const RUN_SUFFIX = '.orchonrun'
export const FLOW_SUFFIX = '.orchonflow'

/** A sweep deletes the plugin's own pointer files older than this. */
export const POINTER_AGE_CAP_MS = 7 * 24 * 60 * 60 * 1000
/** A sweep keeps at most this many of the plugin's own pointer files, the newest. */
export const POINTER_COUNT_CAP = 20

/** The most characters of the workflow name a file name keeps. */
const NAME_PART_CAP = 60
/** How many characters of the run id a file name keeps. */
const RUN_ID_PART = 8

/** Text cut down to safe characters: letters and digits of ASCII, `_` and `-`, with no dash at either end. */
function clean(text: string, fallback: string): string {
  const safe = text
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return safe === '' ? fallback : safe
}

/** `<workflow>-<first 8 characters of the run id>.orchonrun`, each part cleaned first. */
export function runPointerName(workflow: string, runId: string): string {
  const name = clean(workflow, 'workflow').slice(0, NAME_PART_CAP).replace(/-+$/, '')
  const run = clean(clean(runId, 'run').slice(0, RUN_ID_PART), 'run')
  return `${name}-${run}${RUN_SUFFIX}`
}

/** A run graph pointer file's content: the run's identity, since the tab never learns its file's name. */
export function runPointerText(runId: string): string {
  return `${JSON.stringify({ orchon: 'run-graph', runId })}\n`
}

/** A name the plugin writes: safe characters and one of its two suffixes. */
const OWN_POINTER = /^[A-Za-z0-9_-]+\.(?:orchonrun|orchonflow)$/

/** One entry of the folder, as the disk module lists it. */
export type FolderEntry = { name: string; modifiedMs: number; file: boolean }

/**
 * The names a sweep deletes: the plugin's own pointer files older than 7 days, then all but the
 * newest 20 of the rest. `keep` is never deleted, and counts towards the 20. Anything that is not
 * one of the plugin's own pointer files is never named.
 */
export function sweepPlan(entries: readonly FolderEntry[], now: number, keep?: string): string[] {
  const own = entries.filter((entry) => entry.file && OWN_POINTER.test(entry.name))
  const doomed = new Set<string>()
  for (const entry of own) if (entry.name !== keep && now - entry.modifiedMs > POINTER_AGE_CAP_MS) doomed.add(entry.name)
  const left = own
    .filter((entry) => !doomed.has(entry.name))
    .sort((a, b) => (a.name === keep ? -1 : b.name === keep ? 1 : b.modifiedMs - a.modifiedMs))
  for (const entry of left.slice(POINTER_COUNT_CAP)) doomed.add(entry.name)
  return own.filter((entry) => doomed.has(entry.name)).map((entry) => entry.name)
}
