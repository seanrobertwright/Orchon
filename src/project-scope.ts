// The project scope in the worker (#6, #25, amended by #9): it joins Orca's focused workspace to
// `workspace.list` and `project.list`, decides whether it is local and writable, matches its
// Orca project to one Archon project, and answers the frames' scope requests. It reads the
// repository's Git config through the disk module and saves links in the plugin's storage.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import type { Disk } from './disk'
import { matchProject, type ArchonProject } from './project-match'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { isRecord, own, refuseRequest } from './records'
import { CHOICES_CAP, type LinkChoices, type ScopeAnswer, type ScopeView } from './scope-view'
import { localAndWritable, normalisePath, originUrl } from './workspaces'

/** The longest Git config file the worker reads. */
export const GIT_CONFIG_CAP_BYTES = 64 * 1024

/** A `workspace.list` row, trimmed to what the scope and the runs table read. */
export type WorkspaceRow = { id: string; kind: 'worktree' | 'folder'; projectId: string | null; path: string; hostId: string | null }

type OrcaProject = { id: string; kind: 'git' | 'folder'; hostId: string | null; path: string }

/** The focused workspace, once joined to Orca's lists. */
type Focus =
  | { kind: 'none' }
  | { kind: 'remote' }
  | {
      kind: 'local'
      /** What a link is saved under: the Orca project, or the folder when it belongs to none. */
      key: string
      /** The Orca project's folder and the workspace's own. */
      folders: string[]
      /** The main checkout folder of a Git project, whose config holds the remote. */
      repository: string | null
    }

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

function parseRow(value: unknown): WorkspaceRow | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  const kind = own(value, 'kind')
  const path = own(value, 'path')
  const projectId = own(value, 'projectId')
  const hostId = own(value, 'hostId')
  if (!isText(id) || !isText(path) || (kind !== 'worktree' && kind !== 'folder')) return null
  if (hostId !== null && typeof hostId !== 'string') return null
  return { id, kind, path, projectId: isText(projectId) ? projectId : null, hostId }
}

function parseProject(value: unknown): OrcaProject | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  const kind = own(value, 'kind')
  const path = own(value, 'path')
  const hostId = own(value, 'hostId')
  if (!isText(id) || !isText(path) || (kind !== 'git' && kind !== 'folder')) return null
  if (hostId !== null && typeof hostId !== 'string') return null
  return { id, kind, path, hostId }
}

/** The rows of a host list answer that parse. Anything else is an empty list. */
function rowsOf<T>(answer: unknown, key: string, parse: (value: unknown) => T | null): T[] {
  const list = isRecord(answer) ? own(answer, key) : undefined
  if (!Array.isArray(list)) return []
  return (list as unknown[]).map(parse).filter((row): row is T => row !== null)
}

/** What saved links are stored under: the server's store id, or its base URL when it reports none. */
const storeKey = (server: Connected): string => server.storeId ?? server.baseUrl

const LINKS_KEY = 'project-links'

/** The saved links of every store, as plain text maps. Anything else in storage is dropped. */
function parseLinks(value: unknown): Record<string, Record<string, string>> {
  const links: Record<string, Record<string, string>> = {}
  if (!isRecord(value)) return links
  for (const [store, inner] of Object.entries(value)) {
    if (!isRecord(inner)) continue
    const kept: Record<string, string> = {}
    for (const [project, id] of Object.entries(inner)) if (isText(id)) kept[project] = id
    links[store] = kept
  }
  return links
}

function choicesOf(projects: readonly ArchonProject[], unreadable: number): LinkChoices {
  const named = [...projects].sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id))
  return {
    projects: named.slice(0, CHOICES_CAP).map(({ id, name }) => ({ id, name })),
    more: Math.max(0, named.length - CHOICES_CAP),
    unreadable
  }
}

export type ProjectScopePorts = {
  client: Client
  current(): Promise<ConnectionView>
  /** `process.platform` of the worker: the WSL share test runs on Windows only. */
  platform: string
  openDisk(roots: readonly string[]): Disk
}

export type ProjectScope = Disposable & {
  /** Every `workspace.list` row, or none when Orca does not answer. */
  workspaces(): Promise<WorkspaceRow[]>
}

export function startProjectScope(orca: OrcaWorkerApi, ports: ProjectScopePorts): ProjectScope {
  async function workspaces(): Promise<WorkspaceRow[]> {
    try {
      return rowsOf(await orca.host.call('workspace.list'), 'workspaces', parseRow)
    } catch {
      return []
    }
  }

  async function focus(): Promise<Focus> {
    let context: unknown
    try {
      context = await orca.host.call('workspace.readContext')
    } catch {
      return { kind: 'none' }
    }
    const workspaceId = isRecord(context) ? own(context, 'workspaceId') : undefined
    if (context === null || context === undefined) return { kind: 'none' }
    // A focused workspace that names no row is remote (#25).
    if (!isText(workspaceId)) return { kind: 'remote' }
    const row = (await workspaces()).find((entry) => entry.id === workspaceId)
    if (row === undefined || !localAndWritable(row, ports.platform)) return { kind: 'remote' }
    let project: OrcaProject | undefined
    if (row.projectId !== null) {
      let answer: unknown
      try {
        answer = await orca.host.call('project.list')
      } catch {
        answer = null
      }
      project = rowsOf(answer, 'projects', parseProject).find((entry) => entry.id === row.projectId)
    }
    // The project root gets the same test as the workspace (#25).
    if (project !== undefined && !localAndWritable(project, ports.platform)) return { kind: 'remote' }
    return {
      kind: 'local',
      key: project === undefined ? `folder:${normalisePath(row.path) ?? row.path}` : `project:${project.id}`,
      folders: project === undefined ? [row.path] : [project.path, row.path],
      repository: project?.kind === 'git' ? project.path : null
    }
  }

  async function remoteOf(repository: string | null): Promise<string | null> {
    if (repository === null) return null
    const root = repository.replace(/[\\/]+$/, '')
    const file = await ports.openDisk([root]).readText(`${root}/.git/config`, GIT_CONFIG_CAP_BYTES)
    return file.kind === 'text' ? originUrl(file.text) : null
  }

  async function savedLink(server: Connected, key: string): Promise<string | null> {
    let stored: unknown
    try {
      stored = await orca.storage.get(LINKS_KEY)
    } catch {
      return null
    }
    const links = parseLinks(stored)
    const store = storeKey(server)
    const inner = Object.hasOwn(links, store) ? links[store] : undefined
    return inner !== undefined && Object.hasOwn(inner, key) ? (inner[key] ?? null) : null
  }

  async function scope(server: Connected, signal: AbortSignal): Promise<ScopeView> {
    const focused = await focus()
    if (focused.kind === 'none') return { kind: 'no-workspace' }
    // In a remote workspace no matching is done at all, the Git remote included (#9).
    if (focused.kind === 'remote') return { kind: 'remote' }
    const answer = await ports.client.request({ baseUrl: server.baseUrl, path: CODEBASES_PATH, timeout: 'read', signal })
    if (!answer.ok) return { kind: 'failed', message: readFailureText(answer.failure) }
    const listed = parseCodebases(answer.value)
    if (listed === null) return { kind: 'failed', message: unreadableAnswerText(server.version) }
    const choices = choicesOf(listed.projects, listed.unreadable)
    const match = matchProject({
      projects: listed.projects,
      link: await savedLink(server, focused.key),
      folders: focused.folders,
      remote: await remoteOf(focused.repository)
    })
    if (match.kind === 'matched') {
      return { kind: 'matched', project: { id: match.project.id, name: match.project.name }, by: match.by, choices }
    }
    return focused.repository === null ? { kind: 'unmatched', choices } : { kind: 'unmatched', registerFolder: focused.repository, choices }
  }

  async function answer(signal: AbortSignal): Promise<ScopeAnswer> {
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, scope: { kind: 'not-connected' } }
    const view = await scope(connection, signal)
    return { connection: await ports.current(), scope: view }
  }

  const subscriptions: Disposable[] = [
    orca.panels.handle('scope.read', (input, context) => {
      if (input !== undefined && input !== null) refuseRequest('This request takes no input.')
      return answer(context.signal)
    })
  ]

  return {
    workspaces,
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
