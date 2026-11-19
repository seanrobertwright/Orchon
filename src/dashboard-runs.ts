// The validator and view-model builder of `GET /api/dashboard/runs`. It lists only the fields
// the runs table reads, all of them present at the floor (Archon 0.12.1), and ignores the rest
// of Archon's answer, so nothing else reaches a frame. A run that fails is dropped and counted;
// a page that fails as a whole is an error.
import { cutAt } from './cutter'
import { parseInstant } from './dates'
import { isRecord } from './records'
import { RUN_STATUSES, type RunRow, type RunStatus, type StatusCounts } from './runs-view'

export const DASHBOARD_RUNS_PATH = '/api/dashboard/runs'

/** How much of a launch message the table keeps for the preview. */
export const MESSAGE_CAP = 200

/** One page as the table uses it. */
export type DashboardRunsPage = {
  counts: StatusCounts
  total: number
  rows: RunRow[]
  /** How many runs Archon sent on this page, read or not: the next page starts after them. */
  sent: number
  unreadable: number
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined)

/** A text field that may be missing or null. Any other type fails the run. */
function optionalText(record: Record<string, unknown>, key: string): string | null | false {
  const value = own(record, key)
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : false
}

const isStatus = (value: unknown): value is RunStatus => RUN_STATUSES.some((status) => status === value)

/** One run, or null when it cannot be read: no id, no workflow name, or a status the table does not know. */
export function parseRun(value: unknown): RunRow | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  const workflow = own(value, 'workflow_name')
  const status = own(value, 'status')
  if (typeof id !== 'string' || id === '' || typeof workflow !== 'string' || workflow === '' || !isStatus(status)) {
    return null
  }
  const started = optionalText(value, 'started_at')
  const completed = optionalText(value, 'completed_at')
  const message = optionalText(value, 'user_message')
  const project = optionalText(value, 'codebase_name')
  const workingPath = optionalText(value, 'working_path')
  if (started === false || completed === false || message === false || project === false || workingPath === false) {
    return null
  }
  return {
    id,
    workflow,
    status,
    // A date that does not parse drops the time and keeps the run.
    startedAt: parseInstant(started),
    endedAt: parseInstant(completed),
    message: cutAt(message ?? '', MESSAGE_CAP),
    project: project === '' ? null : project,
    workingPath: workingPath === '' ? null : workingPath
  }
}

/** The per-status counts, or null when one is missing or not a count. */
function parseCounts(value: unknown): StatusCounts | null {
  if (!isRecord(value)) return null
  const all = own(value, 'all')
  if (!isCount(all)) return null
  const counts: StatusCounts = { all, running: 0, paused: 0, pending: 0, completed: 0, failed: 0, cancelled: 0 }
  for (const status of RUN_STATUSES) {
    const count = own(value, status)
    if (!isCount(count)) return null
    counts[status] = count
  }
  return counts
}

/** One page of Archon's answer, or null when the page as a whole cannot be read. */
export function parseDashboardRunsPage(value: unknown): DashboardRunsPage | null {
  if (!isRecord(value)) return null
  const runs = own(value, 'runs')
  const total = own(value, 'total')
  const counts = parseCounts(own(value, 'counts'))
  if (!Array.isArray(runs) || !isCount(total) || counts === null) return null
  const rows: RunRow[] = []
  for (const run of runs as unknown[]) {
    const row = parseRun(run)
    if (row !== null) rows.push(row)
  }
  return { counts, total, rows, sent: runs.length, unreadable: runs.length - rows.length }
}
