// The chat list as a frame gets it: the request a panel sends and the trimmed view model the
// worker answers. It is types and constants only, so the panel and the worker read one contract
// and none of Archon's JSON crosses to the panel.
import type { ConnectionAnswer } from './connection-view'

/**
 * How many conversations Archon lists at most: `GET /api/conversations` takes no limit and
 * Archon's own default is 50, newest activity first, with no way to reach older ones.
 */
export const ARCHON_CONVERSATIONS_CAP = 50

/** The least time between two reads of the list that no person asked for. */
export const CHAT_LIST_GAP_MS = 2_000

/**
 * What a panel sends. Under "This project" it sends the Archon project's id; under "All
 * projects" it leaves it out.
 */
export type ChatsRequest = { codebaseId?: string }

/** One conversation with Archon's agent, trimmed to what a row shows. */
export type ChatRow = {
  /** The conversation's platform id, which Archon's conversation routes take. */
  id: string
  /** Null when Archon has no title for it. */
  title: string | null
  /** The last activity, in milliseconds since the epoch, or null when the time does not parse. */
  lastActivityAt: number | null
  /**
   * Under "All projects" only: the Archon project's name, or null when the conversation has no
   * project Archon lists. Left out under "This project".
   */
  project?: string | null
}

export type ChatsView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  | {
      kind: 'ready'
      /** Newest activity first, as Archon listed them, without launch conversations and unreadable rows. */
      rows: ChatRow[]
      /** Whether Archon returned as many rows as it lists at most, so some may be missing. */
      capped: boolean
      /** How many of Archon's rows could not be read and are not shown. */
      unreadable: number
    }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type ChatsAnswer = ConnectionAnswer & { chats: ChatsView }
