// Deleting a conversation, as a frame gets it: the request a panel sends and the outcomes the
// worker answers. It is types only, so the panel and the worker read one contract.
import type { ConnectionAnswer } from './connection-view'

/** What **Delete** sends: the open conversation's platform id. */
export type ChatDeleteRequest = { conversationId: string }

export type ChatDeleteOutcome =
  /** Archon deleted the conversation. */
  | { kind: 'deleted' }
  /** Archon answered that the conversation does not exist, so there is nothing to delete. */
  | { kind: 'gone' }
  /** Archon did not answer within the write timeout. The delete may have happened, so it is never sent again. */
  | { kind: 'timeout'; timeoutMs: number }
  /** Archon refused, or did not say it deleted it. The message is one sentence. */
  | { kind: 'refused'; message: string }
  /** Orchon is not connected, so nothing was sent. */
  | { kind: 'not-connected' }

export type ChatDeleteAnswer = ConnectionAnswer & { outcome: ChatDeleteOutcome }
