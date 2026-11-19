// The runs table as a frame gets it: the request a panel sends and the trimmed view model the
// worker answers. It is types and constants only, so the panel and the worker read one contract
// and none of Archon's JSON crosses to the panel.
import type { ConnectionAnswer } from './connection-view'

/** A run's status as Archon names it. Archon's `pending` is what the panel calls Queued. */
export type RunStatus = 'running' | 'paused' | 'pending' | 'completed' | 'failed' | 'cancelled'

export const RUN_STATUSES: readonly RunStatus[] = ['running', 'paused', 'pending', 'completed', 'failed', 'cancelled']

/** The status select's values: every run, or the runs of one status. */
export type StatusFilter = 'all' | RunStatus

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...RUN_STATUSES]

/** How many rows the panel asks for at a time, and where it stops. */
export const ROWS_STEP = 25
export const ROWS_CAP = 500

/** What a panel sends: the filter, and how many of the newest runs it wants, rows 0 to N. */
export type RunsRequest = { status: StatusFilter; rows: number }

/** How many runs Archon holds of each status, whatever the filter, and in all. */
export type StatusCounts = Record<StatusFilter, number>

/** One run, trimmed to what the table and the preview show. Times are milliseconds since the epoch. */
export type RunRow = {
  id: string
  workflow: string
  status: RunStatus
  /** Null when Archon gave no start time, or one that does not parse. */
  startedAt: number | null
  /** Null while the run has not ended, or when the time does not parse. */
  endedAt: number | null
  /** The start of the launch message, cut for display. Empty when there was none. */
  message: string
  /** The Archon project's name, or null when the run has none. */
  project: string | null
  /** The folder the run works in, as Archon spells it, or null. */
  workingPath: string | null
}

export type RunsView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  | {
      kind: 'ready'
      counts: StatusCounts
      /** How many runs match the filter. */
      total: number
      /** Rows 0 to N, newest first, without the ones that could not be read. */
      rows: RunRow[]
      /** How many of the runs read could not be read and are not shown. */
      unreadable: number
    }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type RunsAnswer = ConnectionAnswer & { runs: RunsView }
