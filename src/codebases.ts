// The validator of `GET /api/codebases`: Archon's registered projects, trimmed to the fields the
// project matcher and the panel read, all present at the floor (Archon 0.12.1). A row that fails
// is dropped and counted; an answer that is not a list is an error.
import type { ArchonProject } from './project-match'
import { isRecord, own } from './records'

export const CODEBASES_PATH = '/api/codebases'

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** One project, or null when it has no id, name or folder, or a remote that is not text. */
export function parseCodebase(value: unknown): ArchonProject | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  const name = own(value, 'name')
  const defaultCwd = own(value, 'default_cwd')
  const remote = own(value, 'repository_url')
  if (!isText(id) || !isText(name) || !isText(defaultCwd)) return null
  if (remote !== undefined && remote !== null && typeof remote !== 'string') return null
  return { id, name, defaultCwd, repositoryUrl: isText(remote) ? remote : null }
}

/** The list, or null when Archon's answer as a whole is not one. */
export function parseCodebases(value: unknown): { projects: ArchonProject[]; unreadable: number } | null {
  if (!Array.isArray(value)) return null
  const projects: ArchonProject[] = []
  for (const row of value as unknown[]) {
    const project = parseCodebase(row)
    if (project !== null) projects.push(project)
  }
  return { projects, unreadable: value.length - projects.length }
}
