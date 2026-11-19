// A run's artifacts: the validator and view-model builder of `GET /api/runs/{runId}/artifacts`,
// and the reader of one file under `/api/artifacts/{runId}/<path>`. The list is read when a frame
// opens Artifacts and kept for the folders and filters that follow, so a run of thousands of
// files is read once. A file is fetched only when that list holds its path.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import {
  ARTIFACT_FILTER_CAP,
  ARTIFACT_PATH_CAP,
  ARTIFACT_ROWS_CAP,
  type ArtifactEntry,
  type ArtifactFile,
  type ArtifactFolder,
  type ArtifactsAnswer,
  type ArtifactsRequest,
  type ArtifactsView
} from './artifacts-view'
import type { Client } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { parseInstant } from './dates'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, own, refuseRequest } from './records'
import { RUN_ID_CAP } from './run-detail-view'

/** How many runs' lists the worker keeps, newest last. */
const KEPT_LISTS = 3

/** A frame's list request, or a refusal. */
export function parseArtifactsRequest(input: unknown): ArtifactsRequest {
  if (!isRecord(input)) refuseRequest('The artifacts request takes a run id.')
  const runId = own(input, 'runId')
  if (!isCappedText(runId, RUN_ID_CAP)) refuseRequest(cappedTextRefusal('The run id', RUN_ID_CAP))
  const request: ArtifactsRequest = { runId }
  const open = own(input, 'open')
  if (open !== undefined) {
    if (typeof open !== 'boolean') refuseRequest('Open must be true or false.')
    request.open = open
  }
  const folder = own(input, 'folder')
  if (folder !== undefined) {
    if (!isCappedText(folder, ARTIFACT_PATH_CAP)) refuseRequest(cappedTextRefusal('The folder', ARTIFACT_PATH_CAP))
    request.folder = folder
  }
  const filter = own(input, 'filter')
  if (filter !== undefined) {
    if (!isCappedText(filter, ARTIFACT_FILTER_CAP)) refuseRequest(cappedTextRefusal('The filter', ARTIFACT_FILTER_CAP))
    request.filter = filter
  }
  for (const key of Object.keys(input)) {
    if (!['runId', 'open', 'folder', 'filter'].includes(key)) refuseRequest(`The artifacts request does not take ${key}.`)
  }
  return request
}

/** Whether a path is one this module can fetch: parts of text, none empty, `.` or `..`. */
function isArtifactPath(value: unknown): value is string {
  if (!isCappedText(value, ARTIFACT_PATH_CAP)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** One file of Archon's list, or null when it cannot be read. */
function parseFile(value: unknown): ArtifactFile | null {
  if (!isRecord(value)) return null
  const path = own(value, 'path')
  const size = own(value, 'size')
  if (!isArtifactPath(path) || !isSize(size)) return null
  return { path, name: path.slice(path.lastIndexOf('/') + 1), size, modifiedAt: parseInstant(own(value, 'modifiedAt')) }
}

/** What one folder holds directly: its folders by name with their file counts, and its files by name. */
type FolderIndex = { folders: Map<string, ArtifactFolder>; files: ArtifactFile[] }

/** A run's list as the worker keeps it. */
export type ArtifactList = {
  /** Every readable file, by path. */
  byPath: Map<string, ArtifactFile>
  /** Every readable file, sorted by path, for the filter. */
  sorted: ArtifactFile[]
  /** Each folder's direct entries, the top level under the empty path, each sorted by name. */
  folders: Map<string, { folders: ArtifactFolder[]; files: ArtifactFile[] }>
  unreadable: number
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const byPathOrder = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Archon's answer, indexed by folder in one pass, or null when it is not a list. */
export function parseArtifactList(value: unknown): ArtifactList | null {
  if (!isRecord(value)) return null
  const files = own(value, 'files')
  if (!Array.isArray(files)) return null
  const byPath = new Map<string, ArtifactFile>()
  let unreadable = 0
  for (const item of files as unknown[]) {
    const file = parseFile(item)
    if (file === null || byPath.has(file.path)) unreadable += 1
    else byPath.set(file.path, file)
  }
  const index = new Map<string, FolderIndex>()
  const folderOf = (path: string): FolderIndex => {
    let held = index.get(path)
    if (held === undefined) {
      held = { folders: new Map(), files: [] }
      index.set(path, held)
    }
    return held
  }
  folderOf('')
  for (const file of byPath.values()) {
    const parts = file.path.split('/')
    let parent = ''
    for (const part of parts.slice(0, -1)) {
      const path = parent === '' ? part : `${parent}/${part}`
      const siblings = folderOf(parent).folders
      const folder = siblings.get(part) ?? { path, name: part, files: 0 }
      folder.files += 1
      siblings.set(part, folder)
      parent = path
    }
    folderOf(parent).files.push(file)
  }
  const folders = new Map<string, { folders: ArtifactFolder[]; files: ArtifactFile[] }>()
  for (const [path, held] of index) {
    folders.set(path, { folders: [...held.folders.values()].sort(byName), files: held.files.sort(byName) })
  }
  return { byPath, sorted: [...byPath.values()].sort(byPathOrder), folders, unreadable }
}

/** One folder's entries, folders first, at most the cap. A folder the list does not hold is empty. */
function folderView(list: ArtifactList, folder: string): ArtifactsView {
  const held = list.folders.get(folder) ?? { folders: [], files: [] }
  const all: ArtifactEntry[] = [
    ...held.folders.map((entry): ArtifactEntry => ({ kind: 'folder', ...entry })),
    ...held.files.map((entry): ArtifactEntry => ({ kind: 'file', ...entry }))
  ]
  const entries = all.slice(0, ARTIFACT_ROWS_CAP)
  return { kind: 'folder', folder, entries, notShown: all.length - entries.length, total: list.byPath.size, unreadable: list.unreadable }
}

/** The files whose path holds the filter, ignoring case, by path, at most the cap. */
function matchesView(list: ArtifactList, filter: string): ArtifactsView {
  const needle = filter.toLowerCase()
  const files: ArtifactFile[] = []
  let matches = 0
  for (const file of list.sorted) {
    if (!file.path.toLowerCase().includes(needle)) continue
    matches += 1
    if (files.length < ARTIFACT_ROWS_CAP) files.push(file)
  }
  return { kind: 'matches', filter, files, matches, notShown: matches - files.length, total: list.byPath.size, unreadable: list.unreadable }
}

export type ArtifactsPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
}

export const artifactListPath = (runId: string): string => `/api/runs/${encodeURIComponent(runId)}/artifacts`

/** Answers the frames' `artifacts.read`. */
export function startArtifacts(orca: OrcaWorkerApi, ports: ArtifactsPorts): Disposable {
  /** Each run's list as last read, newest last. */
  const lists = new Map<string, ArtifactList>()

  type Listed = { ok: true; list: ArtifactList } | { ok: false; view: { kind: 'gone' } | { kind: 'failed'; message: string } }

  /** The run's list: read from Archon when asked to or when none is kept, else the kept one. */
  async function listOf(server: Connected, runId: string, fresh: boolean, signal: AbortSignal): Promise<Listed> {
    const held = lists.get(runId)
    if (!fresh && held !== undefined) return { ok: true, list: held }
    const answer = await ports.client.request({ baseUrl: server.baseUrl, path: artifactListPath(runId), timeout: 'read', signal })
    if (!answer.ok) {
      if (answer.failure.kind === 'status' && answer.failure.status === 404) return { ok: false, view: { kind: 'gone' } }
      return { ok: false, view: { kind: 'failed', message: readFailureText(answer.failure) } }
    }
    const list = parseArtifactList(answer.value)
    if (list === null) return { ok: false, view: { kind: 'failed', message: unreadableAnswerText(server.version) } }
    lists.delete(runId)
    lists.set(runId, list)
    while (lists.size > KEPT_LISTS) lists.delete(lists.keys().next().value as string)
    return { ok: true, list }
  }

  return orca.panels.handle('artifacts.read', async (input, context): Promise<ArtifactsAnswer> => {
    const request = parseArtifactsRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, artifacts: { kind: 'not-connected' } }
    const listed = await listOf(connection, request.runId, request.open === true, context.signal)
    const artifacts = !listed.ok
      ? listed.view
      : request.filter === undefined
        ? folderView(listed.list, request.folder ?? '')
        : matchesView(listed.list, request.filter)
    return { connection: await ports.current(), artifacts }
  })
}
