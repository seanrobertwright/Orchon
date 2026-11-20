// The step view as a frame gets it: the requests a panel sends and the trimmed view models the
// worker answers. A step's facts, its output cut into blocks, and one page of its activity: the
// items the worker folded from Archon's provider events, rows only. Raw events never cross to the
// panel, and an item's text, input and output cross only when the item is asked for. It is types
// and constants only.
import type { ConnectionAnswer } from './connection-view'
import type { StepState } from './run-detail-view'
import type { RunStatus } from './runs-view'

/** The most characters a step id a frame sends may have. */
export const STEP_ID_CAP = 400

/** How many items one page of activity holds. */
export const ACTIVITY_PAGE = 50

/** The most pages a frame may ask for, so the list stops at `ACTIVITY_PAGE` times this many items. */
export const ACTIVITY_PAGES_CAP = 20

/** The largest output shown, in characters: 256 KiB. The rest is not shown, with a line saying so. */
export const STEP_OUTPUT_CAP = 256 * 1024

/** The most of one step's events the worker reads, in bytes: 32 MiB. Past it the view shows a notice. */
export const STEP_EVENTS_CAP_BYTES = 32 * 1024 * 1024

/** How often the worker asks Archon for a running step's new events while its view is open. */
export const STEP_POLL_MS = 3_000

/** The most characters of an item an item row carries: the start of its first line. */
export const ITEM_LINE_CAP = 120

/**
 * What a panel sends for the step view: the run, the step's id as run detail lists it, and how
 * many pages of activity it shows, 1 when left out.
 */
export type StepRequest = StepRef & { pages?: number }

/** One step of one run: the run's id and the step's id as run detail lists it. */
export type StepRef = { runId: string; stepId: string }

/** What a panel sends when the step view closes, so the worker stops polling it. */
export type StepCloseRequest = StepRef

/** What a panel sends for one item of a step's activity: its key from a page. */
export type ItemRequest = StepRef & { key: string }

/** A hint that a step's activity changed while its view is open. It carries no activity. */
export type StepHint = StepRef

/** Why a skipped step was skipped, and the condition that skipped it when there was one. */
export type SkipFacts = { reason: string; condition: string | null }

export type StepFacts = {
  id: string
  name: string
  /** Archon's kind of node, or null when no event named it. */
  kind: string | null
  state: StepState
  /** The run's status, so a running step of a paused run reads as waiting. */
  runStatus: RunStatus
  /** The id of the loop that holds this step, or null for a step at the top. */
  loop: string | null
  /** The count of its start events. */
  starts: number
  /** Whether any event of the run names the step. */
  reached: boolean
  /** Its place in run detail's step list, from 1, and the list's length. */
  position: number
  count: number
  /** The steps before and after it in run detail's list, inner steps included, or null at the ends. */
  previous: string | null
  next: string | null
  /** Milliseconds since the epoch of its latest start and end, or null. */
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  costUsd: number | null
  /** Input and output tokens, or null when Archon reported none. */
  tokens: { input: number; output: number } | null
  model: string | null
  provider: string | null
  turns: number | null
  stopReason: string | null
  /** A failed step's error, cut at `ERROR_CAP`, or null. */
  error: string | null
  /** A skipped step's reason and condition, or null. */
  skip: SkipFacts | null
}

/** Where a failed step's error is cut. */
export const ERROR_CAP = 4_000

/** The step's output, plain text in blocks of at most 16 KiB up to `STEP_OUTPUT_CAP`. */
export type StepOutput = { blocks: string[]; notShown: number }

/** The kinds of item the worker folds events into. */
export type ItemKind = 'text' | 'thinking' | 'tool' | 'subtask' | 'warning' | 'hook'

/** One row of a page: what the tree shows, never an item's whole text. */
export type ActivityRow = {
  /** Unique across the step's attempts. */
  key: string
  kind: ItemKind
  /** The row's words, cut at `ITEM_LINE_CAP`. */
  label: string
  /** The second part of the row, such as a tool call's state, or empty. */
  detail: string
  /** When its first event was observed, or null when Archon's time does not parse. */
  at: number | null
}

/** One attempt's rows on the page, newest first. `number` counts the step's attempts from 1. */
export type AttemptRows = { key: string; number: number; rows: ActivityRow[] }

export type ActivityView =
  /**
   * The newest items, newest first, grouped by attempt, newest attempt first. `loaded` items are on
   * the page of `total`; `hidden` events are of kinds not listed, and `unreadable` events could not
   * be read. `live` while the step runs and the worker polls it.
   */
  | {
      kind: 'ready'
      attempts: AttemptRows[]
      loaded: number
      total: number
      /** How many earlier items a press of Show earlier could still add, within the cap. */
      earlier: number
      /** How many earlier items lie past the cap and cannot be shown. */
      pastCap: number
      hidden: number
      unreadable: number
      live: boolean
    }
  /** The step's events passed `STEP_EVENTS_CAP_BYTES`. */
  | { kind: 'too-large' }
  | { kind: 'failed'; message: string }

export type StepView =
  | { kind: 'not-connected' }
  | { kind: 'ready'; facts: StepFacts; output: StepOutput | null; activity: ActivityView }
  /** Archon has no run with this id. */
  | { kind: 'gone' }
  /** The run has no step with this id. */
  | { kind: 'no-step' }
  | { kind: 'failed'; message: string }

export type StepAnswer = ConnectionAnswer & { step: StepView }

/** A text cut at 16 KiB: `cut` when there was more. */
export type CutText = { text: string; cut: boolean }

/** Where a tool call stands: running until its update says how it ended. */
export type ToolState = 'running' | 'completed' | 'failed' | 'cancelled'

/** A tool call's state in words, for its row and its preview. */
export const TOOL_STATE_WORDS: Record<ToolState, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }

/** One item as its preview shows it. */
export type ItemView =
  | { kind: 'not-connected' }
  /** The step's list holds no item with this key: it is gone, or the list was read again. */
  | { kind: 'not-found' }
  | { kind: 'text' | 'thinking'; text: CutText }
  | {
      kind: 'tool'
      name: string
      title: string | null
      state: ToolState
      input: CutText | null
      output: CutText | null
      /** Set when Archon stored only part of the output. */
      outputTruncated: boolean
      exitCode: number | null
    }
  | { kind: 'subtask'; status: string; description: string | null; summary: CutText | null }
  | { kind: 'warning'; code: string | null; text: CutText }
  | { kind: 'hook'; name: string; event: string | null; exitCode: number | null }
  | { kind: 'failed'; message: string }

export type ItemAnswer = ConnectionAnswer & { item: ItemView }
