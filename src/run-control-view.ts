// Run control as a frame gets it: the request a panel sends to cancel, abandon or resume a run,
// and the outcome the worker answers. It is types and constants only.
import type { ConnectionAnswer } from './connection-view'

/** The actions a frame may ask for. "Try now" on a usage-limit pause is `resume`. */
export type RunAction = 'cancel' | 'abandon' | 'resume'

export const RUN_ACTIONS: readonly RunAction[] = ['cancel', 'abandon', 'resume']

/** What a panel sends: the run and the action. Nothing else is taken. */
export type RunControlRequest = { runId: string; action: RunAction }

/** Where Archon's text in an outcome is cut. */
export const SERVER_TEXT_CAP = 2_000

export type RunControlOutcome =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /** Archon did it. `message` is its own text, cut at `SERVER_TEXT_CAP`, and may be empty. */
  | { kind: 'done'; message: string }
  /**
   * Archon refused with its own text (a 400, 403 or 409), or the worker refused before asking.
   * `status` is Archon's, or null for the worker's own refusal. `childRunId` when Archon named the
   * sub-run that holds the action up.
   */
  | { kind: 'refused'; status: number | null; message: string; childRunId?: string }
  /** Archon has no run with this id. */
  | { kind: 'gone' }
  /**
   * A 500, any status other than a refusal's or 404, or an answer that is not the expected JSON.
   * `message` is Archon's text, when it gave one.
   */
  | { kind: 'failed'; message: string | null }
  /** Archon did not answer within the write timeout, `timeoutMs`. The action may still have happened. */
  | { kind: 'timeout'; timeoutMs: number }

export type RunControlAnswer = ConnectionAnswer & { outcome: RunControlOutcome }
