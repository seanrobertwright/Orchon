// Run detail as a frame gets it: the request a panel sends and the trimmed view model the worker
// answers. It holds the run's facts, its steps, its waiting state and its question only: no artifact listing,
// no event payload and no step output crosses to the panel. It is types and constants only.
import type { ConnectionAnswer } from './connection-view'
import type { Question } from './run-answer-view'
import type { RunStatus } from './runs-view'

/** The most characters a run id a frame sends may have. */
export const RUN_ID_CAP = 200

/** Where the launch message is cut, with a line saying so. */
export const LAUNCH_MESSAGE_CAP = 2_000

/** Where the step list stops, with a line saying how many steps are not shown. */
export const STEP_ROWS_CAP = 500

/** How many sub-runs a waiting parent lists before "and N more". */
export const CHILD_ROWS_CAP = 20

/** How many stalled tool calls a running run lists before "and N more". */
export const STALLED_CALLS_CAP = 10

/** Where Archon's detail of an unreadable run is cut. */
export const UNREADABLE_DETAIL_CAP = 2_000

/**
 * What a panel sends: the run, and `open` when run detail has just been opened, which looks up
 * the sub-runs it waits on at once. Other reads look them up at most every 30 seconds.
 */
export type RunDetailRequest = { runId: string; open?: boolean }

/** A step's state as Archon names it. */
export type StepState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export const STEP_STATES: readonly StepState[] = ['pending', 'running', 'completed', 'failed', 'skipped']

/** One step of the run, one row however often it ran. */
export type Step = {
  /** Archon's node id. An inner step's id is its loop's id, a dot and its own name. */
  id: string
  /** The name the row shows: an inner step's name without its loop's id. */
  name: string
  /** Archon's kind of node, such as `exec` or `gate`, or null when no event named it. */
  kind: string | null
  state: StepState
  /** The id of the loop that holds this step, or null for a step at the top. */
  loop: string | null
  /** How many times the step started: the count of its start events. */
  starts: number
  /** How long its latest start took, or null while it runs or when Archon gave no time. */
  durationMs: number | null
  /** False for a step no event of the run names yet. */
  reached: boolean
}

/** A sub-run a waiting parent lists. The workflow and status are null until they are looked up. */
export type ChildRow = { id: string; workflow: string | null; status: RunStatus | null }

/** A tool call that has not returned: its name, Archon's title for it or null, and for how long. */
export type StalledCall = { name: string; title: string | null; stalledForMs: number }

/** What a run waits for, besides a question. Times are null when Archon's time does not parse. */
export type Waiting =
  | { kind: 'time'; until: number | null }
  | { kind: 'event'; event: string; until: number | null }
  /** Rows of at most `CHILD_ROWS_CAP` sub-runs, and how many more it waits on. */
  | { kind: 'children'; children: ChildRow[]; more: number }
  /** Paused on a provider usage limit: Archon tries again by itself at `resumeAt`. */
  | { kind: 'usage-limit'; resumeAt: number | null }
  /** Archon cannot read what the run waits for. `detail` is its text, cut at `UNREADABLE_DETAIL_CAP`. */
  | { kind: 'unreadable'; detail: string }
  /** A running run whose tool calls have not returned: at most `STALLED_CALLS_CAP`, and how many more. */
  | { kind: 'stalled'; calls: StalledCall[]; more: number }
  /** An `attention` kind this version of Orchon does not know. Nothing else is read from it. */
  | { kind: 'unknown' }

export type RunDetail = {
  id: string
  workflow: string
  status: RunStatus
  /** Milliseconds since the epoch, or null when Archon gave none or it does not parse. */
  startedAt: number | null
  endedAt: number | null
  /** What the run cost in US dollars, or null when Archon reports none. */
  costUsd: number | null
  /** The Archon project's name, or null when the run has none or Archon no longer lists it. */
  project: string | null
  /** The folder the run works in, as Archon spells it, or null. */
  workingPath: string | null
  /** The `workspace.list` row whose path is the run's folder, once normalised. Left out when Orca lists none. */
  workspaceId?: string
  /** The launch message, cut at `LAUNCH_MESSAGE_CAP` characters. Empty when there was none. */
  message: string
  /** Whether the launch message was cut. */
  messageCut: boolean
  /**
   * The steps in the order the tree shows them: steps at the top ordered by first start, each
   * loop followed by its inner steps, then the steps not reached in Archon's order. At most
   * `STEP_ROWS_CAP`.
   */
  steps: Step[]
  /** How many steps the run has, shown or not. */
  stepCount: number
  /** How many of Archon's steps could not be read and are not shown. */
  unreadableSteps: number
  waiting: Waiting | null
  /** The open gate or attention wait of a paused run, which the answer block shows. Left out when there is none. */
  question?: Question
  /** Set when Archon's `owner_observation` says the run's owner is unreachable. Left out otherwise. */
  ownerUnreachable?: true
}

export type RunDetailView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  | { kind: 'ready'; detail: RunDetail }
  /** Archon has no run with this id. */
  | { kind: 'gone' }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type RunDetailAnswer = ConnectionAnswer & {
  run: RunDetailView
  /**
   * Why Open graph is off for a ready run, as one sentence: no local workspace is focused, it is
   * remote, the run has no project, or a write failed there. Left out when it is on.
   */
  graphOff?: string
  /**
   * Why Open workflow in builder is off for a ready run, as one sentence: no local workspace is
   * focused, it is remote, or a write failed there. Left out when it is on.
   */
  builderOff?: string
  /** A ready run's Archon project id, which Open workflow in builder names. Left out for a run with none. */
  codebaseId?: string
  /**
   * Set when run detail offers Re-run: a completed or cancelled run whose project Archon still
   * lists, outside a remote workspace. Left out otherwise.
   */
  rerun?: true
}
