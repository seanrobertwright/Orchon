// A chat thread as a frame gets it: the request a panel sends and the trimmed view model the
// worker answers. It is types, constants and the draw cost both sides count by, so the panel and
// the worker read one contract and none of Archon's JSON crosses to the panel.
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

/** The most of a workflow result's summary that its card shows; Open run shows the rest of the run. */
export const RESULT_SUMMARY_CAP = 2_000

/** The most characters of a workflow's name that a dispatch row or a result card shows. */
export const WORKFLOW_NAME_CAP = 200

/** The least time between two reads of the thread that no person asked for. */
export const THREAD_GAP_MS = 2_000

/**
 * What a panel sends: the conversation's platform id, how many of its newest messages to read,
 * a multiple of `THREAD_PAGE` up to `ARCHON_MESSAGES_CAP`, and whether to carry tool calls.
 */
export type ThreadRequest = {
  conversationId: string
  limit: number
  toolCalls?: boolean
  /**
   * Set on the first read after the person opened the thread, or after the panel mounted on it:
   * a stream another reader took is read again only then.
   */
  open?: true
}

/**
 * What the conversation's stream has said of its turn, while the worker reads it. `busy` is null
 * until a `conversation_lock` frame says; `tool` names the tool the agent is using, or is null.
 */
export type ThreadLive = { busy: boolean | null; tool: string | null }

/** The hint that a conversation's stream said something: which conversation, and no message data. */
export type ChatHint = { conversationId: string }

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
  /**
   * Set on a message that started a workflow: the row draws it in place of the content, so
   * `blocks` is empty. `workerId` is the platform id of the conversation the run works in, which
   * finds the run, or null when Archon saved none the worker accepts.
   */
  dispatch?: { workflow: string; workerId: string | null }
  /**
   * Set on a workflow's result: the card names the workflow and opens its run, and `blocks` hold
   * the summary, cut at `RESULT_SUMMARY_CAP` with `notShown` saying how much is not shown.
   */
  result?: { workflow: string; runId: string }
}

/** The conversation and its newest messages. */
export type Thread = {
  id: string
  /** Null when Archon has no title for it. */
  title: string | null
  /** The conversation's Archon project, or null when it has none Archon lists. */
  project: { name: string; defaultCwd: string } | null
  /**
   * Newest first, without rows that could not be read and without framework messages other than
   * a workflow's dispatch and its result.
   */
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
  /** Set while the worker reads the conversation's stream and it has said something of the turn. */
  live?: ThreadLive
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

/**
 * The nodes the thread draws for one message, text included, counted as if every part it can
 * show were drawn and every tool call row open. It is never less than the objects the message's
 * view model holds, so it bounds those too. The worker bounds its answer with it, and the frame
 * test "one message draws no more nodes than messageDrawCost counts" holds the panel to it, so a
 * change to how a message is drawn that outgrows it fails there.
 */
export function messageDrawCost(view: ThreadMessage): number {
  let cost = 6 + view.blocks.length + (view.notShown > 0 ? 1 : 0)
  if (view.files !== undefined) cost += 2
  if (view.error !== undefined) cost += 3
  if (view.toolCalls !== undefined) cost += 2 + 8 * view.toolCalls.calls.length
  if (view.dispatch !== undefined) cost += 8
  if (view.result !== undefined) cost += 6
  return cost
}

