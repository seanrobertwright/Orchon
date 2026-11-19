// The Workflows section in the worker (#16): a project select, the workflows Archon lists for the
// chosen project with where each comes from, and Delete of a project or global workflow. A
// project's list is the launcher's kept list, so Archon is not read twice for it. The worker is
// the boundary: it checks every request itself, sends a Delete once with the write timeout, and
// never sends one again.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { isArchonWorkflowName, newWorkflowDefinition, newWorkflowFile, WORKFLOW_NAME_CAP, type BuilderIdentity } from '../editors/builder/builder-view'
import { PROJECT_GONE } from './builder'
import type { BuilderDraft, BuilderDrafts } from './builder-drafts'
import type { Client } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import type { LaunchLists, ListResult } from './launch'
import type { ArchonProject } from './project-match'
import { storeKey, type FocusedWorkspace } from './project-scope'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { SERVER_TEXT_CAP } from './run-control-view'
import { PROJECT_ID_CAP } from './scope-view'
import { NOT_CONNECTED_TEXT } from './worker-words'
import { normalisePath } from './workspaces'
import { parseWorkflowList, WORKFLOWS_CAP_BYTES, WORKFLOWS_PATH, type ListedWorkflow } from './workflows-list'
import {
  DELETE_NAME_CAP,
  DELETE_TIMED_OUT,
  isDeletableName,
  isOwnedSource,
  NAME_REFUSED,
  nameInUse,
  NEEDS_PROJECT,
  NOT_DELETABLE,
  SECTION_DESCRIPTION_CAP,
  SECTION_PROJECTS_CAP,
  SECTION_SEARCH_CAP,
  SECTION_WORKFLOWS_CAP,
  type DeleteAnswer,
  type DeleteOutcome,
  type SectionList,
  type SectionWorkflow,
  type SectionDrafts,
  type WorkflowDelete,
  type WorkflowNew,
  type WorkflowsAnswer,
  type WorkflowsRequest,
  type WorkflowsSectionView
} from './workflows-section-view'

const contains = (text: string, needle: string): boolean => text.toLowerCase().includes(needle.toLowerCase())

function optionalText(input: Record<string, unknown>, key: string, field: string, cap: number): string | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  const value = input[key]
  if (typeof value !== 'string' || value.length > cap) refuseRequest(`${field} must be text of at most ${String(cap)} characters.`)
  return value
}

/** A frame's `workflows.read`, or a refusal. */
export function parseWorkflowsRequest(input: unknown): WorkflowsRequest {
  if (input === undefined || input === null) return {}
  if (!isRecord(input)) refuseRequest('The workflows read takes a project, a search, a filter and whether to read again.')
  refuseOtherKeys(input, ['project', 'search', 'filter', 'reload'], 'The workflows read')
  const request: WorkflowsRequest = {}
  if (Object.hasOwn(input, 'project')) {
    const project = input['project']
    if (!isCappedText(project, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
    request.project = project
  }
  const search = optionalText(input, 'search', 'The search', SECTION_SEARCH_CAP)
  if (search !== undefined) request.search = search
  const filter = optionalText(input, 'filter', 'The filter', SECTION_SEARCH_CAP)
  if (filter !== undefined) request.filter = filter
  if (Object.hasOwn(input, 'reload')) {
    if (typeof input['reload'] !== 'boolean') refuseRequest('Reload must be true or false.')
    request.reload = input['reload']
  }
  return request
}

/** A frame's `workflows.delete`, or a refusal. The name must be in Delete's closed set. */
export function parseWorkflowDelete(input: unknown): WorkflowDelete {
  if (!isRecord(input)) refuseRequest('Delete takes a workflow name and a project.')
  refuseOtherKeys(input, ['name', 'codebaseId'], 'Delete')
  const name = input['name']
  const codebaseId = input['codebaseId']
  if (!isCappedText(name, DELETE_NAME_CAP) || !isDeletableName(name)) {
    refuseRequest('The workflow name must be letters, digits, ".", "_" and "-", starting with a letter, digit or "_".')
  }
  if (codebaseId !== null && !isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  return { name, codebaseId }
}

/** A frame's `workflows.new`, or a refusal: a name of at most the cap, a project id or null, and a place. The name rule is checked after, with a sentence. */
export function parseWorkflowNew(input: unknown): WorkflowNew {
  if (!isRecord(input)) refuseRequest('New workflow takes a name, a project and a place.')
  refuseOtherKeys(input, ['name', 'codebaseId', 'place'], 'New workflow')
  const name = own(input, 'name')
  if (typeof name !== 'string' || name.length > WORKFLOW_NAME_CAP) refuseRequest(`The workflow name must be text of at most ${String(WORKFLOW_NAME_CAP)} characters.`)
  if (!Object.hasOwn(input, 'codebaseId')) refuseRequest('New workflow takes a project id, or null for none.')
  const codebaseId = own(input, 'codebaseId')
  if (codebaseId !== null && !isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  const place = own(input, 'place')
  if (place !== 'project' && place !== 'global') refuseRequest('The place must be project or global.')
  if (place === 'project' && codebaseId === null) refuseRequest(NEEDS_PROJECT)
  return { name, codebaseId, place }
}

/** The drafts the section names, for the chosen project or none; undefined when there are none to name. */
function sectionDrafts(all: readonly BuilderDraft[], dropped: number, codebaseId: string | null): SectionDrafts | undefined {
  if (all.length === 0 && dropped === 0) return undefined
  const fresh = all.filter((draft) => draft.isNew && (draft.codebaseId === null || draft.codebaseId === codebaseId))
  const rows = fresh
    .map((draft) => ({ name: draft.name, codebaseId: draft.codebaseId, scope: draft.scope === 'global' ? ('global' as const) : ('project' as const) }))
    .sort((first, second) => first.name.localeCompare(second.name) || first.scope.localeCompare(second.scope))
  return { fresh: rows, elsewhere: all.filter((draft) => draft.isNew).length - fresh.length, dropped }
}

/** Archon's `error` words, cut, or null when its answer holds none. */
function archonWords(body: unknown): string | null {
  const error = isRecord(body) ? own(body, 'error') : undefined
  return isText(error) ? cutAt(error, SERVER_TEXT_CAP) : null
}

export type WorkflowsSectionPorts = {
  client: Client
  current(): Promise<ConnectionView>
  focused(): Promise<FocusedWorkspace>
  /** The launcher's kept reads, shared. */
  lists: LaunchLists
  /** Why Open in builder is off, or null when it is on. Never off when left out. */
  builderOff?(): Promise<string | null>
  /** The builder drafts, which the section marks and lists, and New workflow keeps. */
  drafts?: Pick<BuilderDrafts, 'list' | 'keep' | 'remove'>
  /** Writes a builder pointer file for an identity and opens it, for New workflow. */
  openIdentity?(identity: BuilderIdentity): Promise<{ opened: true } | { opened: false; reason: string }>
}

export function startWorkflowsSection(orca: OrcaWorkerApi, ports: WorkflowsSectionPorts): Disposable {
  /** The list with no project, kept for one store. */
  let unscoped: { store: string; result: ListResult } | undefined

  async function readUnscoped(server: Connected, reload: boolean): Promise<ListResult> {
    const store = storeKey(server)
    if (!reload && unscoped?.store === store) return unscoped.result
    const answer = await ports.client.request({ baseUrl: server.baseUrl, path: WORKFLOWS_PATH, timeout: 'read', maxBytes: WORKFLOWS_CAP_BYTES })
    let result: ListResult
    if (!answer.ok) result = answer.failure.kind === 'too-large' ? { kind: 'too-large' } : { kind: 'failed', message: readFailureText(answer.failure) }
    else {
      const list = parseWorkflowList(answer.value)
      result = list === null ? { kind: 'failed', message: unreadableAnswerText(server.version) } : { kind: 'ready', list }
    }
    unscoped = { store, result }
    return result
  }

  /**
   * The workflows listed for a project, or with none. With no `cwd` Archon reads its first
   * project's folder, so with no project its project workflows are dropped: what is left is
   * global, bundled and installed.
   */
  async function listFor(server: Connected, project: ArchonProject | undefined, reload: boolean): Promise<{ result: ListResult; rows: ListedWorkflow[] }> {
    const result = project === undefined ? await readUnscoped(server, reload) : await ports.lists.list(server, project, reload)
    if (result.kind !== 'ready') return { result, rows: [] }
    const rows = project === undefined ? result.list.workflows.filter((row) => row.source !== 'project') : result.list.workflows
    return { result, rows }
  }

  function sectionList(result: ListResult, listed: ListedWorkflow[], filter: string, drafted: (row: ListedWorkflow) => boolean): SectionList {
    if (result.kind !== 'ready') return result
    const all: SectionWorkflow[] = listed
      .map((row) => ({
        name: row.name,
        description: cutAt(row.description, SECTION_DESCRIPTION_CAP),
        source: row.source,
        deletable: isOwnedSource(row.source) && isDeletableName(row.name),
        ...(drafted(row) ? { draft: true as const } : {})
      }))
      .sort((first, second) => first.name.localeCompare(second.name) || first.source.localeCompare(second.source))
    const matching = filter === '' ? all : all.filter((row) => contains(row.name, filter) || contains(row.description, filter))
    return { kind: 'ready', rows: matching.slice(0, SECTION_WORKFLOWS_CAP), total: all.length, matching: matching.length, unreadable: result.list.unreadable }
  }

  /** The folder the workflows are read from, when the focused workspace is another one. */
  function readFromOf(focused: FocusedWorkspace, project: ArchonProject | undefined): string | null {
    if (project === undefined || focused.kind !== 'local') return null
    return normalisePath(focused.root) === normalisePath(project.defaultCwd) ? null : project.defaultCwd
  }

  async function viewOf(request: WorkflowsRequest, reload: boolean): Promise<WorkflowsSectionView> {
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { kind: 'not-connected' }
    const read = await ports.lists.projects(connection, reload)
    if (read.kind === 'failed') return read
    const { listed } = read
    const byName = [...listed.projects].sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id))
    const search = request.search ?? ''
    const found = search === '' ? byName : byName.filter((project) => contains(project.name, search))
    const project = request.project === undefined ? undefined : listed.projects.find((entry) => entry.id === request.project)
    const rows = found.slice(0, SECTION_PROJECTS_CAP).map(({ id, name }) => ({ id, name }))
    if (project !== undefined && !rows.some((row) => row.id === project.id)) rows.unshift({ id: project.id, name: project.name })
    const { result, rows: workflows } = await listFor(connection, project, reload)
    const builderOff = ports.builderOff === undefined ? null : await ports.builderOff()
    const kept = ports.drafts === undefined ? { drafts: [], dropped: 0 } : await ports.drafts.list()
    const codebaseId = project?.id ?? null
    const drafted = (row: ListedWorkflow): boolean => kept.drafts.some((draft) => draft.name === row.name && draft.scope === row.source && draft.codebaseId === codebaseId)
    const drafts = sectionDrafts(kept.drafts, kept.dropped, codebaseId)
    return {
      kind: 'ready',
      projects: { rows, more: Math.max(0, found.length - SECTION_PROJECTS_CAP), unreadable: listed.unreadable },
      codebaseId: project?.id ?? null,
      folder: project?.defaultCwd ?? null,
      readFrom: readFromOf(await ports.focused(), project),
      list: sectionList(result, workflows, request.filter ?? '', drafted),
      ...(builderOff === null ? {} : { builderOff }),
      ...(drafts === undefined ? {} : { drafts })
    }
  }

  /**
   * New workflow: checks the name against Archon's rule and against the names in use here, keeps
   * a draft of one empty prompt node, and opens its tab. Archon is written nothing: the first
   * Save writes the workflow. A tab that does not open lets the draft go.
   */
  async function createNew(input: WorkflowNew): Promise<{ opened: true } | { opened: false; reason: string }> {
    const refused = (reason: string) => ({ opened: false as const, reason })
    const connection = await ports.current()
    if (connection.kind !== 'connected') return refused(NOT_CONNECTED_TEXT)
    const off = ports.builderOff === undefined ? null : await ports.builderOff()
    if (off !== null) return refused(off)
    if (ports.drafts === undefined || ports.openIdentity === undefined) return refused(NOT_CONNECTED_TEXT)
    const { name, place } = input
    if (!isArchonWorkflowName(name)) return refused(NAME_REFUSED)
    let project: ArchonProject | undefined
    if (input.codebaseId !== null) {
      const read = await ports.lists.projects(connection, false)
      if (read.kind === 'failed') return refused(read.message)
      project = read.listed.projects.find((entry) => entry.id === input.codebaseId)
      if (project === undefined) return refused(PROJECT_GONE)
    }
    // The names in use: those Archon lists for the project, and for a global workflow those it lists with none.
    const lists = [await listFor(connection, project, false), ...(place === 'global' ? [await listFor(connection, undefined, false)] : [])]
    for (const { result } of lists) {
      if (result.kind === 'failed') return refused(`Orchon could not read the workflows to check the name. ${result.message}`)
      if (result.kind === 'too-large') return refused("Orchon could not check the name: Archon's workflow list is too large to read.")
    }
    const codebaseId = place === 'global' ? null : input.codebaseId
    const { drafts } = await ports.drafts.list()
    const drafted = drafts.some((draft) => draft.name === name && (draft.codebaseId === codebaseId || draft.codebaseId === null || codebaseId === null))
    if (drafted || lists.some(({ rows }) => rows.some((row) => row.name === name))) return refused(nameInUse(name))
    const identity: BuilderIdentity = { name, codebaseId, scope: place }
    const kept = await ports.drafts.keep({ ...identity, definition: newWorkflowDefinition(name), base: null, file: newWorkflowFile(place) }, true)
    if (!kept.kept) return refused(kept.reason)
    const opened = await ports.openIdentity(identity)
    if (!opened.opened) await ports.drafts.remove(identity)
    return opened
  }

  async function answer(request: WorkflowsRequest, reload: boolean): Promise<WorkflowsAnswer> {
    const workflows = await viewOf(request, reload)
    return { connection: await ports.current(), workflows }
  }

  /** Deletes one workflow, once. Whatever happens, the list is read again. */
  async function remove(input: WorkflowDelete): Promise<DeleteAnswer> {
    const request: WorkflowsRequest = input.codebaseId === null ? {} : { project: input.codebaseId }
    const outcome = await sendDelete(input)
    return { ...(await answer(request, true)), outcome }
  }

  async function sendDelete(input: WorkflowDelete): Promise<DeleteOutcome> {
    const failed = (message: string): DeleteOutcome => ({ kind: 'failed', name: input.name, message })
    const connection = await ports.current()
    if (connection.kind !== 'connected') return failed(NOT_CONNECTED_TEXT)
    let project: ArchonProject | undefined
    if (input.codebaseId !== null) {
      const read = await ports.lists.projects(connection, false)
      if (read.kind === 'failed') return failed(read.message)
      project = read.listed.projects.find((entry) => entry.id === input.codebaseId)
      if (project === undefined) return failed(NOT_DELETABLE)
    }
    // The workflow must be in the list the person saw, and one they own; its source is the
    // worker's, never the frame's.
    const { rows } = await listFor(connection, project, false)
    const row = rows.find((entry) => entry.name === input.name && isOwnedSource(entry.source))
    if (row === undefined) return failed(NOT_DELETABLE)
    let query: URLSearchParams
    if (row.source === 'global') query = new URLSearchParams({ source: 'global' })
    else if (project !== undefined) query = new URLSearchParams({ cwd: project.defaultCwd, source: 'project' })
    else return failed(NOT_DELETABLE)
    const sent = await ports.client.request({
      baseUrl: connection.baseUrl,
      path: `${WORKFLOWS_PATH}/${encodeURIComponent(input.name)}?${query.toString()}`,
      method: 'DELETE',
      timeout: 'write',
      errorBody: true
    })
    if (sent.ok) return { kind: 'deleted', name: input.name }
    if (sent.failure.kind === 'timeout') return failed(DELETE_TIMED_OUT)
    const words = sent.failure.kind === 'status' ? archonWords(sent.failure.body) : null
    return failed(words ?? readFailureText(sent.failure))
  }

  const subscriptions: Disposable[] = [
    orca.panels.handle('workflows.read', (input) => {
      const request = parseWorkflowsRequest(input)
      return answer(request, request.reload === true)
    }),
    orca.panels.handle('workflows.delete', (input) => remove(parseWorkflowDelete(input))),
    orca.panels.handle('workflows.new', (input) => createNew(parseWorkflowNew(input)))
  ]

  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
