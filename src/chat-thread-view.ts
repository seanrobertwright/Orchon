// A chat thread as a frame gets it: the request a panel sends and the trimmed view model the
// worker answers. It is types and constants only, so the panel and the worker read one contract
// and none of Archon's JSON crosses to the panel.
import type { ConnectionAnswer } from './connection-view'

/** How many messages the thread asks for first, and how many more each **Show earlier** adds. */
export const THREAD_PAGE = 50

/** The most messages Archon sends for one conversation, whatever limit it is asked for. */
export const ARCHON_MESSAGES_CAP = 500

/** A message longer than this, in UTF-16 units, is cut, with a line saying how much is not shown. */
export const MESSAGE_CAP = 64 * 1024

/** The most of a tool call's input, and of its output, that the thread shows. */
export const TOOL_TEXT_CAP = 16 * 1024

/** The most characters of a tool's name a row shows. */
export const TOOL_NAME_CAP = 200

/** The most tool calls one message shows. */
export const TOOL_CALLS_CAP = 50

/** The most file names one message lists. */
export const FILE_NAMES_CAP = 20

/** The most characters of one file name the list shows. */
export const FILE_NAME_CAP = 200

/** The most of an error's message that its callout shows. */
export const ERROR_TEXT_CAP = 2_000

/** The least time between two reads of the thread that no person asked for. */
export const THREAD_GAP_MS = 2_000

/**
 * What a panel sends: the conversation's platform id, how many of its newest messages to read,
 * a multiple of `THREAD_PAGE` up to `ARCHON_MESSAGES_CAP`, and whether to carry tool calls.
 */
export type ThreadRequest = { conversationId: string; limit: number; toolCalls?: boolean }

/** One tool call of a saved message, as its collapsed row shows it. */
export type ThreadToolCall = {
  /** Stable within the message: a saved message's tool calls never change order. */
  id: string
  name: string
  /** The input as JSON text, cut at `TOOL_TEXT_CAP`, or null when Archon saved none. */
  input: string | null
  inputNotShown: number
  /** The output, cut at `TOOL_TEXT_CAP`, or null when Archon saved none. */
  output: string | null
  outputNotShown: number
}

/** One saved message, trimmed to what the thread draws. */
export type ThreadMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  /** When Archon saved it, in milliseconds since the epoch, or null when the time does not parse. */
  at: number | null
  /** User and assistant messages are Markdown; a system message is plain text. */
  format: 'markdown' | 'text'
  /** The content cut into blocks Orca can draw, at most `MESSAGE_CAP` of it in all. */
  blocks: string[]
  /** How many UTF-16 units of the content are past `MESSAGE_CAP` and not shown. */
  notShown: number
  /** The message of the error Archon saved with it, cut at `ERROR_TEXT_CAP`. */
  error?: string
  /** The names of the files it was sent with from Archon's console, at most `FILE_NAMES_CAP`. */
  files?: { names: string[]; notShown: number }
  /** Only when the request asked for tool calls and the message has some. */
  toolCalls?: { calls: ThreadToolCall[]; notShown: number }
}

/** The conversation and its newest messages. */
export type Thread = {
  id: string
  /** Null when Archon has no title for it. */
  title: string | null
  /** The conversation's Archon project, or null when it has none Archon lists. */
  project: { name: string; defaultCwd: string } | null
  /** Newest first, without framework messages and rows that could not be read. */
  messages: ThreadMessage[]
  /** The limit this answer read with. */
  limit: number
  /** Whether Archon may hold older messages that a higher limit would fetch. */
  earlier: boolean
  /** Whether Archon sent its most, so older messages cannot be fetched at all. */
  atArchonCap: boolean
  /** How many of Archon's rows could not be read and are not shown. */
  unreadable: number
  /** How many older messages were left out because the answer to the panel was full. */
  cut: number
}

export type ThreadView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  | { kind: 'ready'; thread: Thread }
  /** Archon answered that the conversation does not exist. */
  | { kind: 'gone' }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type ThreadAnswer = ConnectionAnswer & { thread: ThreadView }
