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
import { CHOICES_CAP, type LinkChoices, type LinkRequest, type OpenRequest, type RegisterRequest, type ScopeAnswer, type ScopeView } from './scope-view'
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

/** What a refused press says. The remote line is the notice of #33, word for word. */
export const REMOTE_WORKSPACE = 'This workspace is on another host. Orchon works with the Archon on this computer.'
export const NOT_LISTED = 'Archon no longer lists that project. Choose another.'
const NOT_CONNECTED = 'Orchon is not connected to Archon.'
const NO_WORKSPACE = 'No workspace is focused in Orca.'
export const NOT_GIT = 'Only a Git repository can be registered. Link this folder to an Archon project instead.'
export const FOLDER_CHANGED = 'The folder to register has changed. Check it and confirm again.'

type LocalFocus = Extract<Focus, { kind: 'local' }>

type Listed = { projects: ArchonProject[]; unreadable: number }

/**
 * A Link or Register press, run on the focused local workspace once Archon's projects are read.
 * It answers why it changed nothing, or nothing when it did; `reread` reads the projects again.
 */
type Press = (on: { server: Connected; focused: LocalFocus; projects: readonly ArchonProject[]; signal: AbortSignal }) => Promise<{
  refused?: string
  reread?: boolean
}>

/** A frame sends these requests with no input. Anything else is refused. */
function refuseInput(input: unknown): void {
  if (input !== undefined && input !== null) refuseRequest('This request takes no input.')
}

/** Link's input, or a refusal: the id of an Archon project and nothing else. */
export function parseLinkRequest(input: unknown): LinkRequest {
  if (!isRecord(input)) refuseRequest('Link takes the id of an Archon project.')
  const projectId = own(input, 'projectId')
  if (!isText(projectId) || projectId.length > 200) refuseRequest('The project id must be text of 1 to 200 characters.')
  for (const key of Object.keys(input)) if (key !== 'projectId') refuseRequest(`Link does not take ${key}.`)
  return { projectId }
}

/** Register's input, or a refusal: the folder the person confirmed and nothing else. */
export function parseRegisterRequest(input: unknown): RegisterRequest {
  if (!isRecord(input)) refuseRequest('Register takes the folder that was confirmed.')
  const folder = own(input, 'folder')
  if (!isText(folder) || folder.length > 4096) refuseRequest('The folder must be text of 1 to 4096 characters.')
  for (const key of Object.keys(input)) if (key !== 'folder') refuseRequest(`Register does not take ${key}.`)
  return { folder }
}

/** Open in Orca's input, or a refusal: a workspace id and nothing else. */
export function parseOpenRequest(input: unknown): OpenRequest {
  if (!isRecord(input)) refuseRequest('Open in Orca takes a workspace id.')
  const workspaceId = own(input, 'workspaceId')
  if (!isText(workspaceId) || workspaceId.length > 1024) refuseRequest('The workspace id must be text of 1 to 1024 characters.')
  for (const key of Object.keys(input)) if (key !== 'workspaceId') refuseRequest(`Open in Orca does not take ${key}.`)
  return { workspaceId }
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

  async function storedLinks(): Promise<Record<string, Record<string, string>>> {
    try {
      return parseLinks(await orca.storage.get(LINKS_KEY))
    } catch {
      return {}
    }
  }

  async function savedLink(server: Connected, key: string): Promise<string | null> {
    const links = await storedLinks()
    const store = storeKey(server)
    const inner = Object.hasOwn(links, store) ? links[store] : undefined
    return inner !== undefined && Object.hasOwn(inner, key) ? (inner[key] ?? null) : null
  }

  /** Links are written one at a time, each after the one before, so no press loses another's write. */
  let linkWrites: Promise<void> = Promise.resolve()

  /** Sets or, with null, clears the link of one Orca project in one store. Every other link is kept. */
  function writeLink(server: Connected, key: string, projectId: string | null): Promise<void> {
    const write = linkWrites.then(async () => {
      const links = await storedLinks()
      const store = storeKey(server)
      const inner: Record<string, string> = { ...(Object.hasOwn(links, store) ? links[store] : {}) }
      if (projectId === null) delete inner[key]
      else inner[key] = projectId
      if (Object.keys(inner).length === 0) delete links[store]
      else links[store] = inner
      await orca.storage.set(LINKS_KEY, links)
    })
    linkWrites = write.catch(() => {})
    return write
  }

  /** Archon's projects, or the sentence that says why they could not be read. */
  async function readProjects(server: Connected, signal: AbortSignal): Promise<Listed | string> {
    const answer = await ports.client.request({ baseUrl: server.baseUrl, path: CODEBASES_PATH, timeout: 'read', signal })
    if (!answer.ok) return readFailureText(answer.failure)
    return parseCodebases(answer.value) ?? unreadableAnswerText(server.version)
  }

  async function viewOf(server: Connected, focused: LocalFocus, listed: Listed): Promise<ScopeView> {
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

  /**
   * The scope of the focused workspace, after `press` ran when one is given. A press runs only
   * in a local workspace once Archon's projects were read; otherwise it is refused with the
   * reason, and the answer says the scope as it stands.
   */
  async function answer(signal: AbortSignal, press?: Press): Promise<ScopeAnswer> {
    const connection = await ports.current()
    const refusing = (text: string): { refused?: string } => (press === undefined ? {} : { refused: text })
    if (connection.kind !== 'connected') return { connection, scope: { kind: 'not-connected' }, ...refusing(NOT_CONNECTED) }
    const focused = await focus()
    if (focused.kind === 'none') return { connection, scope: { kind: 'no-workspace' }, ...refusing(NO_WORKSPACE) }
    // In a remote workspace no matching is done at all, the Git remote included, and Link and
    // Register are off (#9).
    if (focused.kind === 'remote') return { connection, scope: { kind: 'remote' }, ...refusing(REMOTE_WORKSPACE) }
    let listed = await readProjects(connection, signal)
    let refused: string | undefined
    if (typeof listed === 'string') {
      if (press !== undefined) refused = listed
    } else if (press !== undefined) {
      const outcome = await press({ server: connection, focused, projects: listed.projects, signal })
      refused = outcome.refused
      if (outcome.reread === true) listed = await readProjects(connection, signal)
    }
    const scope: ScopeView = typeof listed === 'string' ? { kind: 'failed', message: listed } : await viewOf(connection, focused, listed)
    return { connection: await ports.current(), scope, ...(refused === undefined ? {} : { refused }) }
  }

  /** Link with an id, or clear the link with null. An id Archon does not list is refused. */
  const link =
    (projectId: string | null): Press =>
    async ({ server, focused, projects }) => {
      if (projectId !== null && !projects.some((project) => project.id === projectId)) return { refused: NOT_LISTED }
      await writeLink(server, focused.key, projectId)
      return {}
    }

  /**
   * Register, once the person confirmed `folder`: it must be exactly the main checkout folder the
   * scope shows, of a Git project. Only then is `POST /api/codebases` sent, with `{ path }` and no
   * other key, and never retried.
   */
  const register =
    (folder: string): Press =>
    async ({ server, focused, signal }) => {
      if (focused.repository === null) return { refused: NOT_GIT }
      if (folder !== focused.repository) return { refused: FOLDER_CHANGED }
      const sent = await ports.client.request({
        baseUrl: server.baseUrl,
        path: CODEBASES_PATH,
        method: 'POST',
        body: { path: focused.repository },
        timeout: 'write',
        signal
      })
      return sent.ok ? { reread: true } : { refused: readFailureText(sent.failure) }
    }

  /** The workspace the last `workspace.changed` named: null for none, undefined before the first. */
  let lastFocused: string | null | undefined

  const subscriptions: Disposable[] = [
    orca.panels.handle('scope.read', (input, context) => {
      refuseInput(input)
      return answer(context.signal)
    }),
    orca.panels.handle('scope.link', (input, context) => answer(context.signal, link(parseLinkRequest(input).projectId))),
    orca.panels.handle('scope.unlink', (input, context) => {
      refuseInput(input)
      return answer(context.signal, link(null))
    }),
    orca.panels.handle('scope.register', (input, context) => answer(context.signal, register(parseRegisterRequest(input).folder))),
    // Open in Orca: only a workspace Orca lists now is shown.
    orca.panels.handle('workspace.open', async (input) => {
      const { workspaceId } = parseOpenRequest(input)
      if (!(await workspaces()).some((row) => row.id === workspaceId)) refuseRequest('Orca no longer lists that workspace.')
      await orca.host.call('workspace.open', { workspaceId })
      return null
    }),
    // The event also fires when the focused workspace's terminals change, and once on subscribing:
    // only a different workspace, or none, is a hint worth posting.
    orca.events.on('workspace.changed', (payload) => {
      const id = payload.context === null ? null : (payload.context.workspaceId ?? '')
      if (id === lastFocused) return
      const first = lastFocused === undefined
      lastFocused = id
      if (!first) orca.panels.post('scope.changed', null)
    })
  ]

  return {
    workspaces,
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
