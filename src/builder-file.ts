// Where a workflow's file is, for Open YAML (#16): a project workflow's path, built from the
// project's folder and the `filename` Archon answers, and the local Orca workspace that holds it.
// Archon's `GET /api/workflows/{name}` (0.12.1) names a project file relative to
// `<folder>/.archon/workflows`, folders included: `sub/<name>.yaml` for a workflow kept in a
// subfolder, `<pack>/<folder>/<file>.yaml` for a packaged one. It is pure logic.
import { localAndWritable, normalisePath } from './workspaces'

/** The folder of a project that Archon reads its workflows from (`getWorkflowFolderSearchPaths`, 0.12.1). */
const WORKFLOWS_FOLDER = '.archon/workflows'

const SEGMENT = /^[^/\\:]+$/

/**
 * The file of a project workflow, with `/` between its parts, or null when the name Archon gave
 * cannot be resolved: empty, absolute, with an empty, `.` or `..` part, or not `.yaml` or `.yml`.
 */
export function workflowFileIn(folder: string, filename: string): string | null {
  const root = folder.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (root === '') return null
  const parts = filename.split(/[/\\]/)
  if (parts.some((part) => !SEGMENT.test(part) || part === '.' || part === '..')) return null
  if (!/\.ya?ml$/i.test(filename)) return null
  return `${root}/${WORKFLOWS_FOLDER}/${parts.join('/')}`
}

/** A workspace row as Open YAML reads it. */
export type YamlWorkspace = { id: string; path: string; hostId: string | null }

/** Where Orca opens the file: a workspace and the path inside it, with `/` between its parts. */
export type YamlTarget = { workspaceId: string; path: string }

/**
 * The innermost local and writable workspace whose folder holds `file`, with the file's path
 * inside it, or null when none does.
 */
export function yamlTarget(file: string, rows: readonly YamlWorkspace[], platform: string): YamlTarget | null {
  const inner = normalisePath(file)
  if (inner === null) return null
  const forward = file.trim().replaceAll('\\', '/')
  let best: { row: YamlWorkspace; length: number } | null = null
  for (const row of rows) {
    if (!localAndWritable(row, platform)) continue
    const outer = normalisePath(row.path)
    if (outer === null) continue
    const prefix = outer.endsWith('/') ? outer : `${outer}/`
    if (!inner.startsWith(prefix) || inner.length === prefix.length) continue
    if (best === null || prefix.length > best.length) best = { row, length: prefix.length }
  }
  if (best === null) return null
  // Normalising changes letter case only, never length, so the prefix's length cuts the path as written.
  return { workspaceId: best.row.id, path: forward.slice(best.length) }
}
