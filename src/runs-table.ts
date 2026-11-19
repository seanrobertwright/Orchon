// The runs table's request: a frame sends a status filter and how many rows it wants, and the
// worker reads rows 0 to N from Archon in its own pages and answers once, with the counts. The
// frame gets the trimmed view model of `dashboard-runs.ts`, never Archon's JSON.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { DASHBOARD_RUNS_PATH, parseDashboardRunsPage } from './dashboard-runs'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { isRecord } from './records'
import { ROWS_CAP, STATUS_FILTERS, type RunRow, type RunsAnswer, type RunsRequest, type RunsView, type StatusFilter } from './runs-view'

/** How many runs the worker asks Archon for at a time. */
export const PAGE_SIZE = 50

function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 'invalid_params' })
}

const isFilter = (value: unknown): value is StatusFilter => STATUS_FILTERS.some((filter) => filter === value)

/** A frame's request, or a refusal: a known filter, and a whole number of rows from 1 to the cap. */
export function parseRunsRequest(input: unknown): RunsRequest {
  if (!isRecord(input)) refuse('The runs request takes a status and a number of rows.')
  const status = Object.hasOwn(input, 'status') ? input['status'] : undefined
  const rows = Object.hasOwn(input, 'rows') ? input['rows'] : undefined
  if (!isFilter(status)) refuse(`The status must be one of ${STATUS_FILTERS.join(', ')}.`)
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1 || rows > ROWS_CAP) {
    refuse(`The number of rows must be a whole number from 1 to ${String(ROWS_CAP)}.`)
  }
  for (const key of Object.keys(input)) {
    if (key !== 'status' && key !== 'rows') refuse(`The runs request does not take ${key}.`)
  }
  return { status, rows }
}

function pagePath(status: StatusFilter, offset: number): string {
  const query = new URLSearchParams()
  if (status !== 'all') query.set('status', status)
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
    const answer = await client.request({ baseUrl: server.baseUrl, path: pagePath(request.status, offset), timeout: 'read', signal })
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
}

/** Answers the frames' `runs.read`. */
export function startRunsTable(orca: OrcaWorkerApi, ports: RunsTablePorts): Disposable {
  return orca.panels.handle('runs.read', async (input, context): Promise<RunsAnswer> => {
    const request = parseRunsRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, runs: { kind: 'not-connected' } }
    const runs = await readRuns(ports.client, connection, request, context.signal)
    return { connection: await ports.current(), runs }
  })
}
