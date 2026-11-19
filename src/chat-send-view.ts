// Sending a chat message, as a frame gets it: the requests a panel sends and the outcomes the
// worker answers. It is types and constants only, so the panel and the worker read one contract
// and none of Archon's JSON crosses to the panel.
import type { ConnectionAnswer } from './connection-view'

/**
 * The most a message may hold, in UTF-16 units: the unit the composer's `maxLength` counts, so
 * the text area and the worker hold the same cap (#18, part 9).
 */
export const CHAT_MESSAGE_CAP = 32 * 1024

/**
 * What **Send** sends: the message as typed, and either the open conversation's platform id or,
 * for the first send of a new chat, the Archon project to create it in.
 */
export type ChatSendRequest = { conversationId: string; message: string } | { codebaseId: string; message: string }

export type ChatSendOutcome =
  /** Archon accepted the message. For a new chat the id is the conversation it created. */
  | { kind: 'sent'; conversationId: string }
  /**
   * Archon did not answer within the write timeout. The message may have arrived, so it is never
   * sent again by the worker; the person decides.
   */
  | { kind: 'timeout'; timeoutMs: number }
  /** The worker or Archon refused the message. Nothing was accepted. The message is one sentence. */
  | { kind: 'refused'; message: string }
  /** Archon answered that the conversation does not exist. */
  | { kind: 'gone' }
  /** Orchon is not connected, so nothing was sent. */
  | { kind: 'not-connected' }

export type ChatSendAnswer = ConnectionAnswer & { outcome: ChatSendOutcome }

/** An Archon project a new chat may be created in, with the folder its agent works in. */
export type ChatProject = { id: string; name: string; defaultCwd: string }

/** How many projects the composer's project select lists, by name. */
export const CHAT_PROJECTS_CAP = 100

/** What a new chat asks for: Archon's projects, and the one the panel's scope chose when it has one. */
export type ChatProjectsRequest = { codebaseId?: string }

export type ChatProjectsView =
  | { kind: 'not-connected' }
  | {
      kind: 'ready'
      /** The project the request named, or null when it named none or Archon does not list it. */
      chosen: ChatProject | null
      /** The first `CHAT_PROJECTS_CAP` projects by name. */
      projects: ChatProject[]
      /** How many listed projects are past the cap and not shown. */
      more: number
      /** How many of Archon's rows could not be read and are not shown. */
      unreadable: number
    }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type ChatProjectsAnswer = ConnectionAnswer & { projects: ChatProjectsView }
