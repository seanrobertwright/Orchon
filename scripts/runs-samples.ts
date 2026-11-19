// The runs table as the worker would answer it, for the panel's tests and for the scenarios of
// `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { ConnectionView } from '../src/connection-view.ts'
import type { RunRow, RunStatus, RunsAnswer, RunsRequest, RunsView, StatusCounts } from '../src/runs-view.ts'
import { connected } from './connection-samples.ts'

/** When the sample runs are set: noon UTC on 18 November 2026. */
export const SAMPLE_NOW = Date.UTC(2026, 10, 18, 12, 0, 0)

/** The status of the sample run at a position in a busy list, newest first. */
const BUSY_STATUSES: readonly RunStatus[] = ['running', 'paused', 'pending', 'failed', 'completed', 'completed', 'cancelled']

/** One run, the Nth newest: started N minutes before the sample time, and ended 75 seconds later unless it is live. */
export function sampleRun(index: number, status: RunStatus = 'completed'): RunRow {
  const startedAt = SAMPLE_NOW - (index + 1) * 60_000
  const live = status === 'running' || status === 'paused' || status === 'pending'
  return {
    id: `run-${String(index)}`,
    workflow: `workflow-${String(index)}`,
    status,
    startedAt,
    endedAt: live ? null : startedAt + 75_000,
    message: `Launch message of run ${String(index)}.`,
    project: index % 2 === 0 ? 'acme/web' : 'acme/api',
    workingPath: `/home/ada/.archon/worktrees/run-${String(index)}`
  }
}

export const EMPTY_COUNTS: StatusCounts = { all: 0, running: 0, paused: 0, pending: 0, completed: 0, failed: 0, cancelled: 0 }

/** No runs at all. */
export const noRuns: Extract<RunsView, { kind: 'ready' }> = { kind: 'ready', counts: EMPTY_COUNTS, total: 0, rows: [], unreadable: 0 }

/** The counts of a busy list of `total` runs, as `busyRun` spreads the statuses. */
export function busyCounts(total: number): StatusCounts {
  const counts: StatusCounts = { ...EMPTY_COUNTS, all: total }
  for (let index = 0; index < total; index += 1) {
    const status = BUSY_STATUSES[index % BUSY_STATUSES.length] ?? 'completed'
    counts[status] += 1
  }
  return counts
}

export const busyRun = (index: number): RunRow => sampleRun(index, BUSY_STATUSES[index % BUSY_STATUSES.length])

/** Rows 0 to N of a busy list holding `total` runs of every status, for one request. */
export function busyRuns(total: number, request: RunsRequest, unreadable = 0): RunsView {
  const matching: RunRow[] = []
  for (let index = 0; index < total; index += 1) {
    const run = busyRun(index)
    if (request.status === 'all' || run.status === request.status) matching.push(run)
  }
  return {
    kind: 'ready',
    counts: busyCounts(total),
    total: matching.length,
    rows: matching.slice(0, request.rows),
    unreadable
  }
}

/** A stand-in for the worker that is connected and answers the runs table as `runs` says. */
export function answeringRuns(
  runs: RunsView | ((request: RunsRequest) => RunsView),
  connection: ConnectionView = connected
): {
  requests: {
    'connection.read': { connection: ConnectionView }
    'connection.retry': { connection: ConnectionView }
    'runs.read': (request: RunsRequest) => RunsAnswer
  }
} {
  return {
    requests: {
      'connection.read': { connection },
      'connection.retry': { connection },
      'runs.read': (request) => ({ connection, runs: typeof runs === 'function' ? runs(request) : runs })
    }
  }
}
