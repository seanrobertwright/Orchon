// Open run on a chat's dispatch row, as a frame gets it: the request a panel sends and the
// trimmed answer the worker gives. It is types only, so the panel and the worker read one contract.
import type { ConnectionAnswer } from './connection-view'

/** What a panel sends: the platform id of the worker conversation a dispatch named. */
export type ChatRunRequest = { workerId: string }

export type ChatRunView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /** The run the dispatch started, which run detail opens. */
  | { kind: 'found'; runId: string }
  /** Archon has no run for the worker conversation yet. */
  | { kind: 'not-created' }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type ChatRunAnswer = ConnectionAnswer & { run: ChatRunView }
