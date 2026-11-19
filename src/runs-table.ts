// The runs table's request: a frame sends a status filter and how many rows it wants, and the
// worker reads rows 0 to N from Archon in its own pages and answers once, with the counts. The
// frame gets the trimmed view model of `dashboard-runs.ts`, never Archon's JSON.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { DASHBOARD_RUNS_PATH, parseDashboardRunsPage } from './dashboard-runs'
import type { WorkspaceRow } from './project-scope'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, refuseRequest } from './records'
import { NEEDS_YOU_UNAVAILABLE, type NeedsYou } from './needs-you'
import { ROWS_CAP, TABLE_FILTERS, type RunRow, type RunsAnswer, type RunsRequest, type RunsView, type TableFilter } from './runs-view'
import { PROJECT_ID_CAP } from './scope-view'
import { normalisePath } from './workspaces'

/** How many runs the worker asks Archon for at a time. */
export const PAGE_SIZE = 50

const isFilter = (value: unknown): value is TableFilter => TABLE_FILTERS.some((filter) => filter === value)

/** A frame's request, or a refusal: a known filter, and a whole number of rows from 1 to the cap. */
export function parseRunsRequest(input: unknown): RunsRequest {
  if (!isRecord(input)) refuseRequest('The runs request takes a status and a number of rows.')
  const status = Object.hasOwn(input, 'status') ? input['status'] : undefined
  const rows = Object.hasOwn(input, 'rows') ? input['rows'] : undefined
  if (!isFilter(status)) refuseRequest(`The status must be one of ${TABLE_FILTERS.join(', ')}.`)
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1 || rows > ROWS_CAP) {
    refuseRequest(`The number of rows must be a whole number from 1 to ${String(ROWS_CAP)}.`)
  }
  if (Object.hasOwn(input, 'codebaseId')) {
    const codebaseId = input['codebaseId']
    if (!isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  }
  for (const key of Object.keys(input)) {
    if (key !== 'status' && key !== 'rows' && key !== 'codebaseId') refuseRequest(`The runs request does not take ${key}.`)
  }
  const codebaseId = input['codebaseId']
  return typeof codebaseId === 'string' ? { status, rows, codebaseId } : { status, rows }
}

function pagePath(request: RunsRequest, offset: number): string {
  const query = new URLSearchParams()
  if (request.status !== 'all') query.set('status', request.status)
  if (request.codebaseId !== undefined) query.set('codebaseId', request.codebaseId)
  query.set('limit', String(PAGE_SIZE))
  query.set('offset', String(offset))
  return `${DASHBOARD_RUNS_PATH}?${query.toString()}`
}

/** Reads pages of the newest runs until it holds the rows asked for, or Archon has no more. */
export async function readRuns(client: Client, server: Connected, request: RunsRequest, signal: AbortSignal): Promise<RunsView> {
  const rows: RunRow[] = []
  let unreadable = 0
  let offset = 0
  for (;;) {
    const answer = await client.request({ baseUrl: server.baseUrl, path: pagePath(request, offset), timeout: 'read', signal })
    if (!answer.ok) return { kind: 'failed', message: readFailureText(answer.failure) }
    const page = parseDashboardRunsPage(answer.value)
    if (page === null) return { kind: 'failed', message: unreadableAnswerText(server.version) }
    rows.push(...page.rows)
    unreadable += page.unreadable
    offset += page.sent
    if (rows.length >= request.rows || page.sent < PAGE_SIZE || offset >= page.total) {
      return { kind: 'ready', counts: page.counts, total: page.total, rows: rows.slice(0, request.rows), unreadable }
    }
  }
}

export type RunsTablePorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
  /** Orca's workspaces, so a run whose folder Orca lists can be opened there. None when left out. */
  workspaces?(): Promise<readonly Pick<WorkspaceRow, 'id' | 'path'>[]>
  /** The snapshot of runs that need you: the callout, the "Needs you" filter and each row's question. */
  needsYou?: NeedsYou
}

/**
 * Answers the table from the snapshot as well: the "Needs you" filter lists the snapshot's runs
 * under the scope, every answer carries the callout, and a row of a run that needs you carries
 * what it waits for, so the table, the callout and the status bar item cannot disagree.
 */
async function readWithSnapshot(client: Client, server: Connected, request: RunsRequest, signal: AbortSignal, needsYou: NeedsYou): Promise<RunsView> {
  await needsYou.settled()
  if (request.status === 'needs-you') {
    const rows = needsYou.rows(request.rows, request.codebaseId)
    if (rows === null) return { kind: 'failed', message: NEEDS_YOU_UNAVAILABLE }
    // The other filters' counts still come from Archon, in one page.
    const counted = await readRuns(client, server, { ...request, status: 'all', rows: 1 }, signal)
    if (counted.kind !== 'ready') return counted
    const view = needsYou.view(request.codebaseId)
    return { ...counted, total: view.kind === 'ready' ? view.total : rows.length, rows, unreadable: view.kind === 'ready' ? view.unreadable : 0, needsYou: view }
  }
  const read = await readRuns(client, server, request, signal)
  if (read.kind !== 'ready') return read
  const rows = read.rows.map((row) => {
    const waiting = needsYou.waiting(row.id)
    return waiting === undefined ? row : { ...row, waiting }
  })
  return { ...read, rows, needsYou: needsYou.view(request.codebaseId) }
}

/** The id of the first workspace row whose path is `path`, once both are normalised, if any. */
export function workspaceIdFor(path: string, rows: readonly Pick<WorkspaceRow, 'id' | 'path'>[]): string | undefined {
  const key = normalisePath(path)
  if (key === null) return undefined
  return rows.find((row) => normalisePath(row.path) === key)?.id
}

/**
 * Gives each run whose folder a workspace row names, once both are normalised, that row's id.
 * Nothing is asked of the disk: whether a worktree folder exists is not on the closed list of #32.
 */
function withWorkspaces(runs: RunsView, rows: readonly Pick<WorkspaceRow, 'id' | 'path'>[]): RunsView {
  if (runs.kind !== 'ready' || rows.length === 0) return runs
  const byPath = new Map<string, string>()
  for (const row of rows) {
    const key = normalisePath(row.path)
    if (key !== null && !byPath.has(key)) byPath.set(key, row.id)
  }
  return {
    ...runs,
    rows: runs.rows.map((run) => {
      const key = run.workingPath === null ? null : normalisePath(run.workingPath)
      const workspaceId = key === null ? undefined : byPath.get(key)
      return workspaceId === undefined ? run : { ...run, workspaceId }
    })
  }
}

/** Answers the frames' `runs.read`. */
export function startRunsTable(orca: OrcaWorkerApi, ports: RunsTablePorts): Disposable {
  return orca.panels.handle('runs.read', async (input, context): Promise<RunsAnswer> => {
    const request = parseRunsRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, runs: { kind: 'not-connected' } }
    const read =
      ports.needsYou === undefined
        ? await readRuns(ports.client, connection, request, context.signal)
        : await readWithSnapshot(ports.client, connection, request, context.signal, ports.needsYou)
    const runs = read.kind === 'ready' && ports.workspaces !== undefined ? withWorkspaces(read, await ports.workspaces()) : read
    return { connection: await ports.current(), runs }
  })
}
