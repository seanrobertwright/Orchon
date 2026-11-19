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
import { isRecord, isText, own, parseOneText, refuseRequest } from './records'
import { CHOICES_CAP, PROJECT_ID_CAP, REMOTE_WORKSPACE, type LinkChoices, type LinkRequest, type OpenRequest, type RegisterRequest, type ScopeAnswer, type ScopeView } from './scope-view'
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
      /** The focused workspace's id and its folder, where a wide tab's pointer file goes. */
      workspaceId: string
      root: string
      /** What a link is saved under: the Orca project, or the folder when it belongs to none. */
      key: string
      /** The Orca project's folder and the workspace's own. */
      folders: string[]
      /** The main checkout folder of a Git project, whose config holds the remote. */
      repository: string | null
    }

/** The fields a `workspace.list` row and a `project.list` row share, or null when one is unreadable. */
function parsePlaced<K extends string>(value: Record<string, unknown>, kinds: readonly K[]): { id: string; kind: K; path: string; hostId: string | null } | null {
  const id = own(value, 'id')
  const kind = kinds.find((known) => known === own(value, 'kind'))
  const path = own(value, 'path')
  const hostId = own(value, 'hostId')
  if (!isText(id) || !isText(path) || kind === undefined) return null
  if (hostId !== null && typeof hostId !== 'string') return null
  return { id, kind, path, hostId }
}

function parseRow(value: unknown): WorkspaceRow | null {
  if (!isRecord(value)) return null
  const placed = parsePlaced(value, ['worktree', 'folder'] as const)
  const projectId = own(value, 'projectId')
  return placed === null ? null : { ...placed, projectId: isText(projectId) ? projectId : null }
}

function parseProject(value: unknown): OrcaProject | null {
  return isRecord(value) ? parsePlaced(value, ['git', 'folder'] as const) : null
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

/** What a refused press says. */
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
  const shape = 'Link takes the id of an Archon project.'
  return { projectId: parseOneText(input, { name: 'Link', shape, key: 'projectId', field: 'The project id', cap: PROJECT_ID_CAP }) }
}

/** Register's input, or a refusal: the folder the person confirmed and nothing else. */
export function parseRegisterRequest(input: unknown): RegisterRequest {
  const shape = 'Register takes the folder that was confirmed.'
  return { folder: parseOneText(input, { name: 'Register', shape, key: 'folder', field: 'The folder', cap: 4096 }) }
}

/** Open in Orca's input, or a refusal: a workspace id and nothing else. */
export function parseOpenRequest(input: unknown): OpenRequest {
  const shape = 'Open in Orca takes a workspace id.'
  return { workspaceId: parseOneText(input, { name: 'Open in Orca', shape, key: 'workspaceId', field: 'The workspace id', cap: 1024 }) }
}

export type ProjectScopePorts = {
  client: Client
  current(): Promise<ConnectionView>
  /** `process.platform` of the worker: the WSL share test runs on Windows only. */
  platform: string
  openDisk(roots: readonly string[]): Disk
}

/** The focused workspace as the wide tabs need it: none, remote, or local with its id and folder. */
export type FocusedWorkspace = { kind: 'none' } | { kind: 'remote' } | { kind: 'local'; workspaceId: string; root: string }

export type ProjectScope = Disposable & {
  /** Every `workspace.list` row, or none when Orca does not answer. */
  workspaces(): Promise<WorkspaceRow[]>
  /** The focused workspace, joined to Orca's lists and given the local-and-writable test of #25. */
  focused(): Promise<FocusedWorkspace>
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
    // `project.list` needs Orca 1.4.259, newer than the oldest Orca the manifest allows. Without
    // it the workspace is matched on its own folder, with no remote and no Register.
    if (row.projectId !== null && orca.host.has('project.list')) {
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
      workspaceId: row.id,
      root: row.path,
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
    async focused() {
      const found = await focus()
      return found.kind === 'local' ? { kind: 'local', workspaceId: found.workspaceId, root: found.root } : found
    },
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
