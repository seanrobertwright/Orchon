// The runs table's request: a frame sends a status filter and how many rows it wants, and the
// worker reads rows 0 to N from Archon in its own pages and answers once, with the counts. The
// frame gets the trimmed view model of `dashboard-runs.ts`, never Archon's JSON.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { DASHBOARD_RUNS_PATH, parseDashboardRunsPage } from './dashboard-runs'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { isRecord, refuseRequest } from './records'
import { normalisePath } from './workspaces'
import { ROWS_CAP, STATUS_FILTERS, type RunRow, type RunsAnswer, type RunsRequest, type RunsView, type StatusFilter } from './runs-view'

/** How many runs the worker asks Archon for at a time. */
export const PAGE_SIZE = 50

const isFilter = (value: unknown): value is StatusFilter => STATUS_FILTERS.some((filter) => filter === value)

/** A frame's request, or a refusal: a known filter, and a whole number of rows from 1 to the cap. */
export function parseRunsRequest(input: unknown): RunsRequest {
  if (!isRecord(input)) refuseRequest('The runs request takes a status and a number of rows.')
  const status = Object.hasOwn(input, 'status') ? input['status'] : undefined
  const rows = Object.hasOwn(input, 'rows') ? input['rows'] : undefined
  if (!isFilter(status)) refuseRequest(`The status must be one of ${STATUS_FILTERS.join(', ')}.`)
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1 || rows > ROWS_CAP) {
    refuseRequest(`The number of rows must be a whole number from 1 to ${String(ROWS_CAP)}.`)
  }
  if (Object.hasOwn(input, 'codebaseId')) {
    const codebaseId = input['codebaseId']
    if (typeof codebaseId !== 'string' || codebaseId === '' || codebaseId.length > 200) {
      refuseRequest('The project id must be text of 1 to 200 characters.')
    }
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
  workspaces?(): Promise<readonly { id: string; path: string }[]>
}

/**
 * Gives each run whose folder a workspace row names, once both are normalised, that row's id.
 * Nothing is asked of the disk: whether a worktree folder exists is not on the closed list of #32.
 */
function withWorkspaces(runs: RunsView, rows: readonly { id: string; path: string }[]): RunsView {
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
    const read = await readRuns(ports.client, connection, request, context.signal)
    const runs = read.kind === 'ready' && ports.workspaces !== undefined ? withWorkspaces(read, await ports.workspaces()) : read
    return { connection: await ports.current(), runs }
  })
}
