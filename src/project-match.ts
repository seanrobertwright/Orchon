// The project matcher (#6, part 2, amended by #9): pure logic that resolves one Orca project to
// one Archon project. The first step with exactly one hit wins: a saved link whose project
// Archon still lists, then path, then Git remote. No host, no network.
import { isSameOrInside, normaliseRemote } from './workspaces'

/** A codebase registered with Archon, trimmed to what matching and the panel use. */
export type ArchonProject = {
  id: string
  /** As Archon names it, usually `owner/repo`. */
  name: string
  /** The main checkout folder, exactly as Archon spells it. */
  defaultCwd: string
  repositoryUrl: string | null
}

export type MatchInput = {
  /** Every project Archon lists now. */
  projects: readonly ArchonProject[]
  /** The id of the project saved as this Orca project's link, or null. */
  link: string | null
  /** The Orca project's folder and the focused workspace's folder. */
  folders: readonly string[]
  /** The `origin` URL of the project's repository, or null. */
  remote: string | null
}

export type Match =
  | { kind: 'matched'; project: ArchonProject; by: 'link' | 'path' | 'remote' }
  /** No step had exactly one hit: `several` when a step had more than one. */
  | { kind: 'unmatched'; reason: 'none' | 'several' }

export function matchProject(input: MatchInput): Match {
  let several = false
  const step = (hits: readonly ArchonProject[], by: 'link' | 'path' | 'remote'): Match | null => {
    const [only] = hits
    if (hits.length === 1 && only !== undefined) return { kind: 'matched', project: only, by }
    if (hits.length > 1) several = true
    return null
  }
  // A link counts only while Archon still lists its project; one it does not is skipped, not deleted.
  const linked = input.link === null ? [] : input.projects.filter((project) => project.id === input.link)
  const remote = input.remote === null ? null : normaliseRemote(input.remote)
  return (
    step(linked, 'link') ??
    step(
      input.projects.filter((project) => input.folders.some((folder) => isSameOrInside(folder, project.defaultCwd))),
      'path'
    ) ??
    step(
      remote === null
        ? []
        : input.projects.filter((project) => project.repositoryUrl !== null && normaliseRemote(project.repositoryUrl) === remote),
      'remote'
    ) ?? { kind: 'unmatched', reason: several ? 'several' : 'none' }
  )
}
