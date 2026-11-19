// Launch in the worker (#15, #27): the form's lists, the draft of each workspace, Start, and the
// launch tracker that finds the run a launch started. The worker is the boundary: it checks every
// request itself, builds both bodies to Archon from a fixed list of keys, sends each write once
// with the write timeout, and never sends one again.
import type { Disposable, JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import { DASHBOARD_RUNS_PATH } from './dashboard-runs'
import type { HintType } from './hint-view'
import {
  CONVERSATIONS_KEPT,
  DESCRIPTION_CAP,
  LAUNCH_ID_CAP,
  MESSAGE_CAP,
  NO_MESSAGE,
  PROJECTS_CAP,
  RECORDS_CAP,
  SEARCH_CAP,
  WORKFLOW_NAME_CAP,
  WORKFLOWS_CAP,
  type LaunchAnswer,
  type LaunchEdit,
  type LaunchNotice,
  type LaunchRequest,
  type LaunchStart,
  type DraftInput,
  type LaunchView,
  type LaunchWorkflow,
  type NoticesAnswer,
  type RerunRequest,
  type StartingState,
  type StartingView,
  type WorkflowsView
} from './launch-view'
import type { ArchonProject } from './project-match'
import type { FocusedWorkspace } from './project-scope'
import { NOT_LISTED } from './project-scope'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { SERVER_TEXT_CAP } from './run-control-view'
import { RUN_ID_CAP } from './run-detail-view'
import { PROJECT_ID_CAP, REMOTE_WORKSPACE } from './scope-view'
import { readRun } from './run-detail'
import { rerunDraft, rerunRefusal, rerunSourceOf } from './rerun'
import { NOT_CONNECTED_TEXT } from './worker-words'
import { parseWorkflowList, WORKFLOWS_CAP_BYTES, WORKFLOWS_PATH, type WorkflowList } from './workflows-list'

/** How often the tracker looks for a run in the first 30 seconds, and how often after. */
export const FIRST_LOOK_MS = 2_000
export const FIRST_LOOKS_FOR_MS = 30_000
export const LATER_LOOK_MS = 10_000
/** A launch Archon started that shows no run after this long offers "Keep waiting". */
export const LATE_AFTER_MS = 60_000
/** How many of the project's newest runs the tracker reads. */
export const LOOK_ROWS = 50
/** How many workspaces keep a draft, and how many projects keep a workflow list, in memory. */
const DRAFTS_CAP = 50
const LISTS_CAP = 20

const LAST_WORKFLOW_KEY = 'launch-last-workflow'
const CONVERSATIONS_KEY = 'launch-conversations'
/** How many projects per store remember their last launched workflow. */
const LAST_WORKFLOWS_KEPT = 500

/** The worker's own refusals, said on the form. */
export const NO_LOCAL_WORKSPACE = 'Focus a local workspace in Orca to launch a run.'
export const WORKFLOW_NOT_LISTED = 'Archon does not list that workflow for this project. Refresh and choose another.'
export const NOT_ACCEPTED = 'Archon did not accept the launch.'
/** Re-run's refusal for a run Archon no longer has; the others are `rerunRefusal`'s. */
export const RERUN_GONE = 'This run no longer exists.'
/** The notice when the run's workflow is gone from the project's list. */
export const workflowGoneNote = (workflow: string): string =>
  `The workflow ${workflow} is no longer listed for this project, so no workflow is chosen. Choose one.`

/** What saved data is stored under: the server's store id, or its base URL when it reports none. */
const storeKey = (server: Connected): string => server.storeId ?? server.baseUrl

/**
 * The ids of the conversations the launcher created for this Archon store, as it keeps them in
 * plugin storage. Storage that cannot be read, or holds something else, gives none.
 */
export async function launchedConversationIds(orca: OrcaWorkerApi, server: Connected): Promise<Set<string>> {
  let stored: unknown
  try {
    stored = await orca.storage.get(CONVERSATIONS_KEY)
  } catch {
    return new Set()
  }
  const ids = isRecord(stored) ? own(stored, storeKey(server)) : undefined
  return new Set(Array.isArray(ids) ? (ids as unknown[]).filter(isText) : [])
}

type Draft = {
  /** Undefined: not chosen, so the panel's project is the default. Null: chosen empty. */
  codebaseId?: string | null
  workflow?: string | null
  message: string
  error?: string
  posting: boolean
  /** The launch the Starting view shows. */
  starting?: string
  /** The inputs Re-run filled, for the chosen workflow. */
  inputs?: DraftInput[]
  /** Re-run's notices, until the draft's project changes or a launch starts. */
  notes?: string[]
}

type LaunchRecord = {
  launchId: string
  store: string
  codebaseId: string
  project: string
  workflow: string
  /** The conversation's platform id, which the launch route takes, and its own id. */
  conversationId: string
  conversationDbId: string
  state: StartingState
  runId?: string
  /** When the wait the 60 seconds count from began: the answer, or "Keep waiting". */
  waitFrom: number
  sentAt: number
  late: boolean
  dismissed: boolean
  timer?: unknown
  looking: boolean
}

export type Listed = { projects: ArchonProject[]; unreadable: number }
export type ProjectsResult = { kind: 'ready'; listed: Listed } | { kind: 'failed'; message: string }
export type ListResult = { kind: 'ready'; list: WorkflowList } | { kind: 'too-large' } | { kind: 'failed'; message: string }

/**
 * The launcher's kept reads of Archon's projects and of each project's trimmed workflow list,
 * which the Workflows section shares so neither is read twice. `reload` reads Archon again.
 */
export type LaunchLists = {
  projects(server: Connected, reload: boolean): Promise<ProjectsResult>
  list(server: Connected, project: ArchonProject, reload: boolean): Promise<ListResult>
}

/** Drops a map's oldest entries, by insertion order, until it holds at most `cap`. */
function capOldest(map: Map<string, unknown>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

const refuseInput = (input: unknown): void => {
  if (input !== undefined && input !== null) refuseRequest('This request takes no input.')
}

function optionalText(input: Record<string, unknown>, key: string, field: string, cap: number): string | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  const value = input[key]
  if (typeof value !== 'string' || value.length > cap) refuseRequest(`${field} must be text of at most ${String(cap)} characters.`)
  return value
}

/** A frame's `launch.read`, or a refusal. */
export function parseLaunchRequest(input: unknown): LaunchRequest {
  if (input === undefined || input === null) return {}
  if (!isRecord(input)) refuseRequest('The launch read takes a project, a search, a filter and whether to read again.')
  refuseOtherKeys(input, ['project', 'search', 'filter', 'reload'], 'The launch read')
  const request: LaunchRequest = {}
  if (Object.hasOwn(input, 'project')) {
    const project = input['project']
    if (!isCappedText(project, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
    request.project = project
  }
  const search = optionalText(input, 'search', 'The search', SEARCH_CAP)
  if (search !== undefined) request.search = search
  const filter = optionalText(input, 'filter', 'The filter', SEARCH_CAP)
  if (filter !== undefined) request.filter = filter
  if (Object.hasOwn(input, 'reload')) {
    if (typeof input['reload'] !== 'boolean') refuseRequest('Reload must be true or false.')
    request.reload = input['reload']
  }
  return request
}

/** A frame's `launch.edit`, or a refusal. */
export function parseLaunchEdit(input: unknown): LaunchEdit {
  if (!isRecord(input)) refuseRequest('The launch edit takes a project, a workflow and a message.')
  refuseOtherKeys(input, ['codebaseId', 'workflow', 'message'], 'The launch edit')
  const edit: LaunchEdit = {}
  for (const [key, field, cap] of [
    ['codebaseId', 'The project id', PROJECT_ID_CAP],
    ['workflow', 'The workflow', WORKFLOW_NAME_CAP]
  ] as const) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (value !== null && !isCappedText(value, cap)) refuseRequest(cappedTextRefusal(field, cap))
    edit[key] = value
  }
  const message = optionalText(input, 'message', 'The message', MESSAGE_CAP)
  if (message !== undefined) edit.message = message
  return edit
}

/** Start's input, or a refusal: a project, a workflow and a message of 1 to `MESSAGE_CAP` characters. */
export function parseLaunchStart(input: unknown): LaunchStart {
  if (!isRecord(input)) refuseRequest('Start takes a project, a workflow and a message.')
  refuseOtherKeys(input, ['codebaseId', 'workflow', 'message'], 'Start')
  const codebaseId = input['codebaseId']
  const workflow = input['workflow']
  const message = input['message']
  if (!isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  if (!isCappedText(workflow, WORKFLOW_NAME_CAP)) refuseRequest(cappedTextRefusal('The workflow', WORKFLOW_NAME_CAP))
  if (!isCappedText(message, MESSAGE_CAP)) refuseRequest(cappedTextRefusal('The message', MESSAGE_CAP))
  return { codebaseId, workflow, message }
}

/** Re-run's input, or a refusal: a run id of 1 to `RUN_ID_CAP` characters. */
export function parseRerunRequest(input: unknown): RerunRequest {
  if (!isRecord(input)) refuseRequest('Re-run takes a run id.')
  refuseOtherKeys(input, ['runId'], 'Re-run')
  const runId = input['runId']
  if (!isCappedText(runId, RUN_ID_CAP)) refuseRequest(cappedTextRefusal('The run id', RUN_ID_CAP))
  return { runId }
}

/** The launch id `launch.dismiss` and `launch.wait` take, or a refusal. */
function parseLaunchId(input: unknown, name: string): string {
  if (!isRecord(input)) refuseRequest(`${name} takes a launch id.`)
  refuseOtherKeys(input, ['launchId'], name)
  const id = input['launchId']
  if (!isCappedText(id, LAUNCH_ID_CAP)) refuseRequest(cappedTextRefusal('The launch id', LAUNCH_ID_CAP))
  return id
}

/** Recommended first, then by name. */
function ordered(list: WorkflowList): LaunchWorkflow[] {
  const recommended = new Set(list.recommended)
  return list.workflows
    .map((workflow) => ({ name: workflow.name, description: workflow.description, source: workflow.source, recommended: recommended.has(workflow.name) }))
    .sort((first, second) => Number(second.recommended) - Number(first.recommended) || first.name.localeCompare(second.name))
}

const contains = (text: string, needle: string): boolean => text.toLowerCase().includes(needle.toLowerCase())

/** Whether a message holds anything but spaces. It is still sent as typed. */
const hasWords = (message: string): boolean => message.trim() !== ''

/** Archon's `error` words, cut, or null when its answer holds none. */
function archonWords(body: unknown): string | null {
  const error = isRecord(body) ? own(body, 'error') : undefined
  return isText(error) ? cutAt(error, SERVER_TEXT_CAP) : null
}

export type LaunchPorts = {
  client: Client
  current(): Promise<ConnectionView>
  focused(): Promise<FocusedWorkspace>
  /** Subscribes to every dashboard hint the worker posts. */
  onHint(listener: (types: HintType[]) => void): Disposable
  now(): number
  timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
}

export function startLaunch(orca: OrcaWorkerApi, ports: LaunchPorts): Disposable & { lists: LaunchLists } {
  const drafts = new Map<string, Draft>()
  const records: LaunchRecord[] = []
  const lists = new Map<string, ListResult>()
  let projects: { store: string; listed: Listed } | undefined
  let nextLaunch = 1
  let stopped = false

  function draftOf(workspace: string): Draft {
    let draft = drafts.get(workspace)
    if (draft === undefined) {
      draft = { message: '', posting: false }
      drafts.set(workspace, draft)
      // One draft per workspace, and at most `DRAFTS_CAP` workspaces: the oldest goes first.
      capOldest(drafts, DRAFTS_CAP)
    }
    return draft
  }

  /** The draft's key: the focused local workspace, or the one key for none. */
  const workspaceKey = (focused: FocusedWorkspace): string => (focused.kind === 'local' ? `ws:${focused.workspaceId}` : 'none')

  async function readProjects(server: Connected, reload: boolean): Promise<ProjectsResult> {
    const store = storeKey(server)
    if (!reload && projects?.store === store) return { kind: 'ready', listed: projects.listed }
    const answer = await ports.client.request({ baseUrl: server.baseUrl, path: CODEBASES_PATH, timeout: 'read' })
    if (!answer.ok) return { kind: 'failed', message: readFailureText(answer.failure) }
    const listed = parseCodebases(answer.value)
    if (listed === null) return { kind: 'failed', message: unreadableAnswerText(server.version) }
    projects = { store, listed }
    return { kind: 'ready', listed }
  }

  async function readList(server: Connected, project: ArchonProject, reload: boolean): Promise<ListResult> {
    const key = `${storeKey(server)}\n${project.id}`
    const held = lists.get(key)
    if (!reload && held !== undefined) return held
    const answer = await ports.client.request({
      baseUrl: server.baseUrl,
      path: `${WORKFLOWS_PATH}?${new URLSearchParams({ cwd: project.defaultCwd }).toString()}`,
      timeout: 'read',
      maxBytes: WORKFLOWS_CAP_BYTES
    })
    let result: ListResult
    if (!answer.ok) result = answer.failure.kind === 'too-large' ? { kind: 'too-large' } : { kind: 'failed', message: readFailureText(answer.failure) }
    else {
      const list = parseWorkflowList(answer.value)
      result = list === null ? { kind: 'failed', message: unreadableAnswerText(server.version) } : { kind: 'ready', list }
    }
    lists.delete(key)
    lists.set(key, result)
    capOldest(lists, LISTS_CAP)
    return result
  }

  async function storedRecord(key: string): Promise<Record<string, unknown>> {
    try {
      const value: unknown = await orca.storage.get(key)
      return isRecord(value) ? value : {}
    } catch {
      return {}
    }
  }

  async function lastWorkflow(server: Connected, codebaseId: string): Promise<string | null> {
    const inner = own(await storedRecord(LAST_WORKFLOW_KEY), storeKey(server))
    const name = isRecord(inner) ? own(inner, codebaseId) : undefined
    return isText(name) ? name : null
  }

  /** Storage writes go one after another, so no launch loses another's write. */
  let writes: Promise<void> = Promise.resolve()
  function write(key: string, change: (stored: Record<string, unknown>) => JsonValue): Promise<void> {
    const next = writes.then(async () => {
      await orca.storage.set(key, change(await storedRecord(key)))
    })
    writes = next.catch(() => {})
    return writes
  }

  /** The text maps of every store, as plain data. Anything else in storage is dropped. */
  function textMaps(stored: Record<string, unknown>): Record<string, Record<string, string>> {
    const maps: Record<string, Record<string, string>> = {}
    for (const [store, inner] of Object.entries(stored)) {
      if (!isRecord(inner)) continue
      const kept: Record<string, string> = {}
      for (const [id, name] of Object.entries(inner)) if (isText(name)) kept[id] = name
      maps[store] = kept
    }
    return maps
  }

  function rememberWorkflow(store: string, codebaseId: string, workflow: string): Promise<void> {
    return write(LAST_WORKFLOW_KEY, (stored) => {
      const maps = textMaps(stored)
      const kept = { ...(Object.hasOwn(maps, store) ? maps[store] : {}) }
      // The newest goes last, and only the newest `LAST_WORKFLOWS_KEPT` projects are kept.
      delete kept[codebaseId]
      kept[codebaseId] = workflow
      const ids = Object.keys(kept)
      for (const id of ids.slice(0, Math.max(0, ids.length - LAST_WORKFLOWS_KEPT))) delete kept[id]
      maps[store] = kept
      return maps
    })
  }

  function rememberConversation(store: string, conversationId: string): Promise<void> {
    return write(CONVERSATIONS_KEY, (stored) => {
      const lists: Record<string, string[]> = {}
      for (const [key, inner] of Object.entries(stored)) if (Array.isArray(inner)) lists[key] = (inner as unknown[]).filter(isText)
      const held = (Object.hasOwn(lists, store) ? (lists[store] ?? []) : []).filter((id) => id !== conversationId)
      lists[store] = [conversationId, ...held].slice(0, CONVERSATIONS_KEPT)
      return lists
    })
  }

  const noticesOf = (): LaunchNotice[] =>
    records
      .filter((record) => record.runId !== undefined && !record.dismissed)
      .reverse()
      .map((record) => ({ launchId: record.launchId, workflow: record.workflow, runId: record.runId ?? '' }))

  function startingOf(record: LaunchRecord): StartingView {
    const view: StartingView = { launchId: record.launchId, workflow: record.workflow, project: record.project, state: record.state, late: record.late }
    if (record.runId !== undefined) view.runId = record.runId
    return view
  }

  function workflowsView(list: ListResult | undefined, filter: string, chosen: string | null): WorkflowsView {
    if (list === undefined) return { kind: 'none' }
    if (list.kind !== 'ready') return list
    const all = ordered(list.list)
    const matching = filter === '' ? all : all.filter((row) => contains(row.name, filter) || contains(row.description, filter))
    const rows = matching.slice(0, WORKFLOWS_CAP)
    const picked = chosen === null ? undefined : all.find((row) => row.name === chosen)
    if (picked !== undefined && !rows.includes(picked)) rows.unshift(picked)
    return { kind: 'ready', rows, total: all.length, matching: matching.length, unreadable: list.list.unreadable }
  }

  /** The form as it stands for the focused workspace, reading Archon only for what it lacks. */
  async function viewOf(request: LaunchRequest, reload: boolean): Promise<LaunchView> {
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { kind: 'not-connected' }
    const focused = await ports.focused()
    if (focused.kind === 'remote') return { kind: 'remote' }
    const draft = draftOf(workspaceKey(focused))
    const read = await readProjects(connection, reload)
    if (read.kind === 'failed') return read
    const { listed } = read
    const byName = [...listed.projects].sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id))
    const search = request.search ?? ''
    const found = search === '' ? byName : byName.filter((project) => contains(project.name, search))
    const wanted = draft.codebaseId === undefined ? (request.project ?? null) : draft.codebaseId
    const project = wanted === null ? undefined : listed.projects.find((entry) => entry.id === wanted)
    const rows = found.slice(0, PROJECTS_CAP).map(({ id, name }) => ({ id, name }))
    if (project !== undefined && !rows.some((row) => row.id === project.id)) rows.unshift({ id: project.id, name: project.name })
    const list = project === undefined ? undefined : await readList(connection, project, reload)
    let workflow: string | null = null
    if (project !== undefined && list?.kind === 'ready') {
      const names = new Set(list.list.workflows.map((entry) => entry.name))
      const remembered = await lastWorkflow(connection, project.id)
      const recommended = list.list.recommended.find((name) => names.has(name)) ?? null
      if (draft.workflow !== undefined) workflow = draft.workflow !== null && names.has(draft.workflow) ? draft.workflow : null
      else if (remembered !== null && names.has(remembered)) workflow = remembered
      else workflow = recommended
    }
    const listedWorkflow = workflow === null || list?.kind !== 'ready' ? undefined : list.list.workflows.find((entry) => entry.name === workflow)
    const view: LaunchView = {
      kind: 'ready',
      projects: { rows, more: Math.max(0, found.length - PROJECTS_CAP), unreadable: listed.unreadable },
      codebaseId: project?.id ?? null,
      workflows: workflowsView(list, request.filter ?? '', workflow),
      workflow,
      description: cutAt(listedWorkflow?.description ?? '', DESCRIPTION_CAP),
      message: draft.message,
      posting: draft.posting
    }
    if (draft.error !== undefined) view.error = draft.error
    if (draft.inputs !== undefined && draft.inputs.length > 0 && workflow !== null && workflow === draft.workflow) view.inputs = draft.inputs
    if (draft.notes !== undefined && draft.notes.length > 0) view.notes = draft.notes
    const starting = draft.starting === undefined ? undefined : records.find((record) => record.launchId === draft.starting)
    if (starting !== undefined) view.starting = startingOf(starting)
    return view
  }

  async function answer(request: LaunchRequest, reload = false): Promise<LaunchAnswer> {
    const launch = await viewOf(request, reload)
    return { connection: await ports.current(), launch, notices: noticesOf() }
  }

  const changed = (): void => {
    if (!stopped) orca.panels.post('launch.changed', null)
  }

  // ---- The tracker: finding the run a launch started. ----

  const tracking = (record: LaunchRecord): boolean => record.runId === undefined && !record.late

  function schedule(record: LaunchRecord): void {
    if (record.timer !== undefined) ports.timers.clear(record.timer)
    record.timer = undefined
    if (stopped || !tracking(record)) return
    const elapsed = ports.now() - record.sentAt
    record.timer = ports.timers.set(() => {
      record.timer = undefined
      void look([record])
    }, elapsed < FIRST_LOOKS_FOR_MS ? FIRST_LOOK_MS : LATER_LOOK_MS)
  }

  /** Whether a row of the project's runs names the launch's conversation, by either id. */
  function runFor(rows: unknown[], record: LaunchRecord): string | undefined {
    for (const row of rows) {
      if (!isRecord(row)) continue
      const id = own(row, 'id')
      if (!isText(id)) continue
      if (own(row, 'parent_conversation_id') === record.conversationDbId || own(row, 'parent_platform_id') === record.conversationId) return id
    }
    return undefined
  }

  /** Reads each project's newest runs once and takes the row each launch names. */
  async function look(candidates: LaunchRecord[]): Promise<void> {
    const due = candidates.filter((record) => tracking(record) && !record.looking)
    if (due.length === 0) return
    const connection = await ports.current()
    let any = false
    if (connection.kind === 'connected') {
      const ofStore = due.filter((record) => record.store === storeKey(connection))
      for (const record of ofStore) record.looking = true
      try {
        for (const codebaseId of new Set(ofStore.map((record) => record.codebaseId))) {
          const query = new URLSearchParams({ codebaseId, limit: String(LOOK_ROWS), offset: '0' })
          const read = await ports.client.request({ baseUrl: connection.baseUrl, path: `${DASHBOARD_RUNS_PATH}?${query.toString()}`, timeout: 'read' })
          const runs = read.ok && isRecord(read.value) ? own(read.value, 'runs') : undefined
          if (!Array.isArray(runs)) continue
          for (const record of ofStore.filter((entry) => entry.codebaseId === codebaseId)) {
            const runId = runFor(runs as unknown[], record)
            if (runId === undefined) continue
            record.runId = runId
            record.state = 'found'
            any = true
          }
        }
      } finally {
        for (const record of ofStore) record.looking = false
      }
    }
    for (const record of due) {
      // A launch Archon started with no run after 60 seconds offers "Keep waiting". One queued
      // for a free slot, or one whose call timed out, keeps looking with no limit.
      if (tracking(record) && record.state === 'started' && ports.now() - record.waitFrom >= LATE_AFTER_MS) {
        record.late = true
        any = true
      }
      schedule(record)
    }
    if (any) changed()
  }

  function track(record: LaunchRecord): void {
    records.push(record)
    // At most `RECORDS_CAP` launch records: the oldest goes, and stops looking.
    while (records.length > RECORDS_CAP) {
      const oldest = records.shift()
      if (oldest?.timer !== undefined) ports.timers.clear(oldest.timer)
    }
    schedule(record)
  }

  // ---- Start. ----

  async function start(input: LaunchStart): Promise<LaunchAnswer> {
    const connection = await ports.current()
    const focused = await ports.focused()
    const draft = draftOf(workspaceKey(focused))
    const request: LaunchRequest = {}
    // A second press while one launch is posted is ignored.
    if (draft.posting) return answer(request)
    draft.codebaseId = input.codebaseId
    draft.workflow = input.workflow
    draft.message = input.message
    const refuse = (text: string): Promise<LaunchAnswer> => {
      draft.error = text
      return answer(request)
    }
    if (connection.kind !== 'connected') return refuse(NOT_CONNECTED_TEXT)
    if (focused.kind === 'remote') return refuse(REMOTE_WORKSPACE)
    if (focused.kind !== 'local') return refuse(NO_LOCAL_WORKSPACE)
    if (!hasWords(input.message)) return refuse(NO_MESSAGE)
    draft.posting = true
    delete draft.error
    try {
      const read = await readProjects(connection, true)
      if (read.kind === 'failed') return await refuse(read.message)
      const { listed } = read
      const project = listed.projects.find((entry) => entry.id === input.codebaseId)
      if (project === undefined) return await refuse(NOT_LISTED)
      const list = await readList(connection, project, false)
      if (list.kind !== 'ready' || !list.list.workflows.some((entry) => entry.name === input.workflow)) return await refuse(WORKFLOW_NOT_LISTED)
      const store = storeKey(connection)
      const created = await ports.client.request({
        baseUrl: connection.baseUrl,
        path: CONVERSATIONS_PATH,
        method: 'POST',
        body: { codebaseId: project.id },
        timeout: 'write',
        errorBody: true
      })
      if (!created.ok) {
        const words = created.failure.kind === 'status' ? archonWords(created.failure.body) : null
        return await refuse(words ?? readFailureText(created.failure))
      }
      const conversationId = isRecord(created.value) ? own(created.value, 'conversationId') : undefined
      const conversationDbId = isRecord(created.value) ? own(created.value, 'id') : undefined
      if (!isText(conversationId) || !isText(conversationDbId)) return await refuse(unreadableAnswerText(connection.version))
      await rememberConversation(store, conversationId)
      const sent = await ports.client.request({
        baseUrl: connection.baseUrl,
        path: `${WORKFLOWS_PATH}/${encodeURIComponent(input.workflow)}/run`,
        method: 'POST',
        body: { conversationId, message: input.message },
        timeout: 'write',
        errorBody: true
      })
      let state: StartingState
      if (sent.ok) {
        const accepted = isRecord(sent.value) ? own(sent.value, 'accepted') : undefined
        const status = isRecord(sent.value) ? own(sent.value, 'status') : undefined
        if (accepted !== true) return await refuse(NOT_ACCEPTED)
        state = status === 'queued-capacity' ? 'queued' : 'started'
      } else if (sent.failure.kind === 'timeout') {
        // Never sent again: the run may have started, so the worker looks for it.
        state = 'looking'
      } else {
        const words = sent.failure.kind === 'status' ? archonWords(sent.failure.body) : null
        if (sent.failure.kind === 'status' && sent.failure.status === 400) {
          // Archon refused the launch: the conversation it made for it goes.
          await ports.client.request({
            baseUrl: connection.baseUrl,
            path: `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}`,
            method: 'DELETE',
            timeout: 'write'
          })
        }
        return await refuse(words ?? readFailureText(sent.failure))
      }
      const at = ports.now()
      const record: LaunchRecord = {
        launchId: `launch-${String(nextLaunch)}`,
        store,
        codebaseId: project.id,
        project: project.name,
        workflow: input.workflow,
        conversationId,
        conversationDbId,
        state,
        waitFrom: at,
        sentAt: at,
        late: false,
        dismissed: false,
        looking: false
      }
      nextLaunch += 1
      track(record)
      draft.starting = record.launchId
      draft.message = ''
      delete draft.inputs
      delete draft.notes
      await rememberWorkflow(store, project.id, input.workflow)
      return await answer(request)
    } finally {
      draft.posting = false
    }
  }

  async function edit(input: LaunchEdit): Promise<LaunchAnswer> {
    const draft = draftOf(workspaceKey(await ports.focused()))
    if (input.codebaseId !== undefined && input.codebaseId !== draft.codebaseId) {
      draft.codebaseId = input.codebaseId
      // Another project lists other workflows: its own default applies.
      delete draft.workflow
      delete draft.inputs
      delete draft.notes
    }
    if (input.workflow !== undefined) {
      // Inputs belong to the workflow they were filled for.
      if (input.workflow !== draft.workflow) delete draft.inputs
      draft.workflow = input.workflow
    }
    if (input.message !== undefined) draft.message = input.message
    return answer({})
  }

  /**
   * Re-run: the draft of the focused workspace filled from the run as Archon records it, never
   * from what a frame sends. It launches nothing.
   */
  async function rerun(input: RerunRequest, signal: AbortSignal): Promise<LaunchAnswer> {
    const connection = await ports.current()
    if (connection.kind !== 'connected') return answer({})
    const focused = await ports.focused()
    const fetched = await readRun(ports.client, connection, input.runId, signal)
    if (fetched.kind === 'gone') refuseRequest(RERUN_GONE)
    if (fetched.kind === 'failed') refuseRequest(fetched.message)
    const { run } = fetched
    let project: ArchonProject | undefined
    if (run.codebaseId !== null) {
      const read = await readProjects(connection, true)
      if (read.kind === 'failed') refuseRequest(read.message)
      project = read.listed.projects.find((entry) => entry.id === run.codebaseId)
    }
    const refusal = rerunRefusal({
      status: run.status,
      project: run.codebaseId === null ? 'none' : project === undefined ? 'unlisted' : 'listed',
      remote: focused.kind === 'remote'
    })
    // `rerunRefusal` refuses a project that is not listed; the second test only narrows the type.
    if (refusal !== null || project === undefined) refuseRequest(refusal ?? NOT_LISTED)
    const list = await readList(connection, project, true)
    const listed = list.kind === 'ready' ? list.list.workflows.find((entry) => entry.name === run.workflow) : undefined
    const draft = draftOf(workspaceKey(focused))
    // A launch being posted keeps its draft: Re-run fills nothing until it is answered.
    if (draft.posting) return answer({})
    const workflowGone = list.kind === 'ready' && listed === undefined
    const built = rerunDraft(rerunSourceOf(fetched.value), list.kind === 'ready' ? (listed?.inputs ?? null) : 'unread')
    const notes = workflowGone ? [workflowGoneNote(run.workflow), ...built.notes] : built.notes
    draft.codebaseId = project.id
    // A list that could not be read keeps the name, so the workflow is chosen once it is read.
    draft.workflow = workflowGone ? null : run.workflow
    draft.message = built.message
    draft.inputs = built.inputs
    draft.notes = notes
    delete draft.error
    delete draft.starting
    return answer({})
  }

  async function notices(): Promise<NoticesAnswer> {
    return { connection: await ports.current(), notices: noticesOf(), looking: records.filter(tracking).length }
  }

  const subscriptions: Disposable[] = [
    orca.panels.handle('launch.read', (input) => {
      const request = parseLaunchRequest(input)
      return answer(request, request.reload === true)
    }),
    orca.panels.handle('launch.edit', (input) => edit(parseLaunchEdit(input))),
    orca.panels.handle('launch.start', (input) => start(parseLaunchStart(input))),
    orca.panels.handle('launch.rerun', (input, context) => rerun(parseRerunRequest(input), context.signal)),
    orca.panels.handle('launch.notices', (input) => {
      refuseInput(input)
      return notices()
    }),
    // "Launch another": the form again, for the focused workspace.
    orca.panels.handle('launch.another', async (input) => {
      refuseInput(input)
      delete draftOf(workspaceKey(await ports.focused())).starting
      return answer({})
    }),
    // A callout's dismiss, or a run the Starting view opened: no callout for it again.
    orca.panels.handle('launch.dismiss', async (input) => {
      const launchId = parseLaunchId(input, 'Dismiss')
      const record = records.find((entry) => entry.launchId === launchId)
      if (record !== undefined) record.dismissed = true
      for (const draft of drafts.values()) if (draft.starting === launchId) delete draft.starting
      return notices()
    }),
    // "Keep waiting": another 60 seconds of looking.
    orca.panels.handle('launch.wait', async (input) => {
      const launchId = parseLaunchId(input, 'Keep waiting')
      const record = records.find((entry) => entry.launchId === launchId)
      if (record !== undefined && record.runId === undefined && record.late) {
        record.late = false
        record.waitFrom = ports.now()
        schedule(record)
      }
      return answer({})
    }),
    // Every dashboard hint is a reason to look again.
    ports.onHint(() => void look([...records]))
  ]

  return {
    lists: { projects: readProjects, list: readList },
    dispose() {
      stopped = true
      for (const record of records) if (record.timer !== undefined) ports.timers.clear(record.timer)
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}

export const CONVERSATIONS_PATH = '/api/conversations'
