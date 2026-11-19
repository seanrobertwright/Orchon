// The runs table as the worker would answer it, for the panel's tests and for the scenarios of
// `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { ConnectionView } from '../src/connection-view.ts'
import type { RunDetail, RunDetailAnswer, RunDetailRequest, RunDetailView, Step } from '../src/run-detail-view.ts'
import {
  CALLOUT_CAP,
  EMPTY_COUNTS,
  type NeedsYouView,
  type RunRow,
  type RunStatus,
  type RunsRequest,
  type RunsView,
  type StatusCounts
} from '../src/runs-view.ts'
import { answeringRuns, connected } from './connection-samples.ts'
export { answeringRuns, noRuns } from './connection-samples.ts'

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

/** A run's detail as the worker answers it: a paused run of a workflow with a loop and steps not reached. */
export function sampleDetail(index = 1, change: Partial<RunDetail> = {}): RunDetail {
  const run = busyRun(index)
  const step = (id: string, state: Step['state'], extra: Partial<Step> = {}): Step => ({
    id,
    name: id,
    kind: 'prompt',
    state,
    loop: null,
    starts: state === 'pending' ? 0 : 1,
    durationMs: state === 'completed' || state === 'failed' ? 12_000 : null,
    reached: state !== 'pending',
    ...extra
  })
  const steps: Step[] = [
    step('plan', 'completed', { durationMs: 95_000 }),
    step('implement', 'running', { kind: 'loop' }),
    step('implement.build', 'completed', { name: 'build', loop: 'implement', starts: 3, kind: 'bash' }),
    step('implement.test', 'running', { name: 'test', loop: 'implement', starts: 2, kind: 'bash' }),
    step('review', 'pending'),
    step('ship', 'pending')
  ]
  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    costUsd: 0.42,
    project: run.project,
    workingPath: run.workingPath,
    message: run.message,
    messageCut: false,
    steps,
    stepCount: steps.length,
    unreadableSteps: 0,
    waiting: null,
    ...change
  }
}

/**
 * A stand-in for the worker that answers the runs table as `answeringRuns` does, and run detail
 * as `detail` says for each request.
 */
export function answeringRun(
  runs: RunsView | ((request: RunsRequest) => RunsView),
  detail: (request: RunDetailRequest) => RunDetailView,
  connection: ConnectionView = connected
) {
  const base = answeringRuns(runs, connection)
  return {
    requests: {
      ...base.requests,
      'run.read': (request: RunDetailRequest): RunDetailAnswer => ({ connection, run: detail(request) })
    }
  }
}

/** The Nth sample run, paused at a gate with its own question, as the snapshot gives it. */
export function waitingRun(index: number): RunRow {
  return { ...sampleRun(index, 'paused'), waiting: { kind: 'gate', question: `Approve the plan of run ${String(index)}?` } }
}

/**
 * A busy list of `total` runs whose answer also carries `needing` runs that need you: the
 * callout's first ten rows, and the "Needs you" filter's rows, as the worker answers them.
 */
export function busyRunsNeedingYou(total: number, needing: number, request: RunsRequest): RunsView {
  const waiting = Array.from({ length: needing }, (_, index) => waitingRun(index))
  const needsYou: NeedsYouView = { kind: 'ready', total: needing, rows: waiting.slice(0, CALLOUT_CAP) }
  const busy = busyRuns(total, request.status === 'needs-you' ? { ...request, status: 'all' } : request)
  if (busy.kind !== 'ready') return busy
  if (request.status === 'needs-you') return { ...busy, total: needing, rows: waiting.slice(0, request.rows), needsYou }
  return { ...busy, needsYou }
}
