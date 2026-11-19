// A chat thread's request: a frame sends a conversation id and how many of its newest messages to
// read, and the worker reads the conversation, its project and its saved messages from Archon and
// answers once. The frame gets the trimmed view model of `chat-thread-view.ts`, never Archon's
// JSON. It reads saved messages only. Each read renews the lease of `chat-stream.ts` on the
// conversation's stream, and the answer carries what that stream said of the turn, never its text.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import {
  ARCHON_MESSAGES_CAP,
  ERROR_TEXT_CAP,
  FILE_NAME_CAP,
  FILE_NAMES_CAP,
  MESSAGE_CAP,
  messageDrawCost,
  RESULT_SUMMARY_CAP,
  THREAD_PAGE,
  TOOL_CALLS_CAP,
  TOOL_NAME_CAP,
  TOOL_TEXT_CAP,
  type Thread,
  type ThreadAnswer,
  type ThreadMessage,
  type ThreadRequest,
  type ThreadToolCall,
  type ThreadView,
  WORKFLOW_NAME_CAP
} from './chat-thread-view'
import type { ChatStreams } from './chat-stream'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { CONVERSATION_ID_CAP, CONVERSATIONS_PATH, isConversationId, parseConversation } from './conversations'
import { cutAt, cutMarkdown, cutText, oneLine } from './cutter'
import { parseInstant } from './dates'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { RUN_ID_CAP } from './run-detail-view'

/** A frame's request, or a refusal. */
export function parseThreadRequest(input: unknown): ThreadRequest {
  if (!isRecord(input)) refuseRequest('The chat thread request takes a conversation id and a limit.')
  refuseOtherKeys(input, ['conversationId', 'limit', 'toolCalls', 'open'], 'The chat thread request')
  const conversationId = own(input, 'conversationId')
  if (!isConversationId(conversationId)) {
    refuseRequest(`${cappedTextRefusal('The conversation id', CONVERSATION_ID_CAP)} It may hold only letters, digits, _ and -.`)
  }
  const limit = own(input, 'limit')
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < THREAD_PAGE || limit > ARCHON_MESSAGES_CAP || limit % THREAD_PAGE !== 0) {
    refuseRequest(`The limit must be a multiple of ${String(THREAD_PAGE)} from ${String(THREAD_PAGE)} to ${String(ARCHON_MESSAGES_CAP)}.`)
  }
  const request: ThreadRequest = { conversationId, limit }
  if (Object.hasOwn(input, 'toolCalls')) {
    const toolCalls = own(input, 'toolCalls')
    if (typeof toolCalls !== 'boolean') refuseRequest('Tool calls must be true or false.')
    if (toolCalls) request.toolCalls = true
  }
  if (Object.hasOwn(input, 'open')) {
    if (own(input, 'open') !== true) refuseRequest('Open must be true when it is given.')
    request.open = true
  }
  return request
}

/** One saved message as the worker reads it, before it is trimmed for the frame. */
type SavedMessage = {
  id: string
  role: ThreadMessage['role']
  content: string
  at: number | null
  category: string | null
  /** The message of the error Archon saved with it. */
  error: string | null
  /** The names of the files it was sent with, in Archon's order. */
  files: string[]
  toolCalls: SavedToolCall[]
  /** `metadata.workflowDispatch` when it names a workflow, else null. */
  dispatch: NonNullable<ThreadMessage['dispatch']> | null
  /** `metadata.workflowResult` when it names a workflow and a run, else null. */
  result: NonNullable<ThreadMessage['result']> | null
}

/** One tool call Archon saved with a message: its input is any JSON value, or undefined when none was saved. */
type SavedToolCall = { name: string; input: unknown; output: string | null }

const ROLES: readonly string[] = ['user', 'assistant', 'system']

/**
 * A message's `metadata`: JSON text in Archon's answers, an object in older or other answers.
 * Null when it is neither, or text that is not a JSON object.
 */
function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {}
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  if (value === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/** One saved message, or null when it cannot be read. */
function parseMessage(value: unknown): SavedMessage | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  const role = own(value, 'role')
  const content = own(value, 'content')
  if (!isText(id) || typeof role !== 'string' || !ROLES.includes(role) || typeof content !== 'string') return null
  const metadata = parseMetadata(own(value, 'metadata'))
  if (metadata === null) return null
  const category = own(metadata, 'category')
  if (category !== undefined && category !== null && typeof category !== 'string') return null
  const error = parseError(own(metadata, 'error'))
  const files = parseFiles(own(metadata, 'files'))
  const toolCalls = parseToolCalls(own(metadata, 'toolCalls'))
  if (error === false || files === null || toolCalls === null) return null
  return {
    id,
    role: role as ThreadMessage['role'],
    content,
    // A date that does not parse drops the time and keeps the message.
    at: parseInstant(own(value, 'created_at')),
    category: typeof category === 'string' ? category : null,
    error,
    files,
    toolCalls,
    dispatch: parseDispatch(own(metadata, 'workflowDispatch')),
    result: parseResult(own(metadata, 'workflowResult'))
  }
}

/** A workflow's name as a row shows it: one line, cut at `WORKFLOW_NAME_CAP`. */
const workflowName = (name: string): string => cutAt(oneLine(name), WORKFLOW_NAME_CAP)

/**
 * `metadata.workflowDispatch`, or null when it names no workflow. Its worker conversation id is
 * kept only when the conversation id rule accepts it, since it is all the run lookup sends.
 */
function parseDispatch(value: unknown): SavedMessage['dispatch'] {
  if (!isRecord(value)) return null
  const name = own(value, 'workflowName')
  if (!isText(name)) return null
  const worker = own(value, 'workerConversationId')
  return { workflow: workflowName(name), workerId: isConversationId(worker) ? worker : null }
}

/** `metadata.workflowResult`, or null unless it names a workflow and a run id run detail accepts. */
function parseResult(value: unknown): SavedMessage['result'] {
  if (!isRecord(value)) return null
  const name = own(value, 'workflowName')
  const runId = own(value, 'runId')
  if (!isText(name) || !isCappedText(runId, RUN_ID_CAP)) return null
  return { workflow: workflowName(name), runId }
}

/** `metadata.toolCalls`, or null when it is not a list of named calls with text output. */
function parseToolCalls(value: unknown): SavedToolCall[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const calls: SavedToolCall[] = []
  for (const call of value as unknown[]) {
    if (!isRecord(call)) return null
    const name = own(call, 'name')
    const output = own(call, 'output')
    if (!isText(name)) return null
    if (output !== undefined && output !== null && typeof output !== 'string') return null
    calls.push({ name, input: own(call, 'input'), output: typeof output === 'string' ? output : null })
  }
  return calls
}

/** A tool call's input as JSON text, or null when Archon saved none. */
function inputText(input: unknown): string | null {
  if (input === undefined || input === null) return null
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2)
}

/** Text cut at the tool call cap, with how much of it is not shown. */
function capped(text: string | null): { text: string | null; notShown: number } {
  if (text === null) return { text: null, notShown: 0 }
  const shown = cutAt(text, TOOL_TEXT_CAP)
  return { text: shown, notShown: text.length - shown.length }
}

/** The tool calls of one message as the frame gets them, at most `TOOL_CALLS_CAP`. */
function toolCallsView(message: SavedMessage): NonNullable<ThreadMessage['toolCalls']> {
  const calls: ThreadToolCall[] = message.toolCalls.slice(0, TOOL_CALLS_CAP).map((call, index) => {
    const input = capped(inputText(call.input))
    const output = capped(call.output)
    return {
      // A saved message's tool calls never change order, so the position names a call.
      id: `${message.id}-${String(index)}`,
      name: cutAt(oneLine(call.name), TOOL_NAME_CAP),
      input: input.text,
      inputNotShown: input.notShown,
      output: output.text,
      outputNotShown: output.notShown
    }
  })
  return { calls, notShown: message.toolCalls.length - calls.length }
}

/** `metadata.error`'s message, null when there is none, or false when it is not an error. */
function parseError(value: unknown): string | null | false {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) return false
  const message = own(value, 'message')
  return typeof message === 'string' ? message : false
}

/** The names in `metadata.files`, which Archon's console sends, or null when it is not a list of named files. */
function parseFiles(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const names: string[] = []
  for (const file of value as unknown[]) {
    const name = isRecord(file) ? own(file, 'name') : undefined
    if (!isText(name)) return null
    names.push(name)
  }
  return names
}

/** Archon's list, or null when its answer as a whole is not one. */
function parseMessages(value: unknown): { rows: SavedMessage[]; sent: number; unreadable: number } | null {
  if (!Array.isArray(value)) return null
  const rows: SavedMessage[] = []
  for (const row of value as unknown[]) {
    const message = parseMessage(row)
    if (message !== null) rows.push(message)
  }
  return { rows, sent: value.length, unreadable: value.length - rows.length }
}

/** Framework messages: the orchestrator narrating, not the agent. The thread hides them. */
const isFramework = (category: string | null): boolean => category !== null && (category.startsWith('workflow_') || category.startsWith('system_'))

/** A workflow's result card: a `workflow_result` message that names its run. */
const isResult = (message: SavedMessage): message is SavedMessage & { result: NonNullable<SavedMessage['result']> } =>
  message.category === 'workflow_result' && message.result !== null

/** Whether the thread shows a message: every one but framework messages, of which only a dispatch and a result show. */
const isShown = (message: SavedMessage): boolean => !isFramework(message.category) || message.dispatch !== null || isResult(message)

/** A saved message trimmed for the frame. */
function messageView(message: SavedMessage, withToolCalls: boolean): ThreadMessage {
  const format = message.role === 'system' ? 'text' : 'markdown'
  // A dispatch row draws no content: it is the orchestrator's narration of what the row says.
  const content = message.dispatch === null ? message.content : ''
  const cap = isResult(message) ? RESULT_SUMMARY_CAP : MESSAGE_CAP
  const cut = format === 'markdown' ? cutMarkdown(content, cap) : cutText(content, cap)
  const view: ThreadMessage = { id: message.id, role: message.role, at: message.at, format, blocks: cut.blocks.map((block) => block.text), notShown: cut.notShown }
  if (message.dispatch !== null) view.dispatch = message.dispatch
  else if (isResult(message)) view.result = message.result
  if (message.error !== null) view.error = cutAt(message.error, ERROR_TEXT_CAP)
  if (message.files.length > 0) {
    const names = message.files.slice(0, FILE_NAMES_CAP).map((name) => cutAt(oneLine(name), FILE_NAME_CAP))
    view.files = { names, notShown: message.files.length - names.length }
  }
  if (withToolCalls && message.toolCalls.length > 0) view.toolCalls = toolCallsView(message)
  return view
}

/**
 * What the messages of one answer may take. Orca relays an answer of at most 1 MiB and 10,000
 * objects, and one render of the panel draws at most 512 KiB and 5,000 nodes, so the messages
 * keep inside the tighter of each with room for the rest of the panel.
 */
const ANSWER_BYTES = 384 * 1024
const ANSWER_NODES = 3_500

const encoder = new TextEncoder()

/** One read of Archon, parsed: the value, or the view the thread shows in its place. */
type Parsed<T> = { ok: true; value: T } | { ok: false; view: ThreadView }

/** Reads and parses one answer. With `goneOn404`, a 404 means the conversation no longer exists. */
async function readParsed<T>(
  client: Client,
  server: Connected,
  path: string,
  parse: (value: unknown) => T | null,
  signal: AbortSignal,
  goneOn404: boolean
): Promise<Parsed<T>> {
  const answer = await client.request({ baseUrl: server.baseUrl, path, timeout: 'read', signal })
  if (!answer.ok) {
    if (goneOn404 && answer.failure.kind === 'status' && answer.failure.status === 404) return { ok: false, view: { kind: 'gone' } }
    return { ok: false, view: { kind: 'failed', message: readFailureText(answer.failure) } }
  }
  const value = parse(answer.value)
  return value === null ? { ok: false, view: { kind: 'failed', message: unreadableAnswerText(server.version) } } : { ok: true, value }
}

/** Reads one conversation, its project and its newest saved messages once. */
export async function readThread(client: Client, server: Connected, request: ThreadRequest, signal: AbortSignal): Promise<ThreadView> {
  const base = `${CONVERSATIONS_PATH}/${encodeURIComponent(request.conversationId)}`
  const conversation = await readParsed(client, server, base, parseConversation, signal, true)
  if (!conversation.ok) return conversation.view
  const list = await readParsed(client, server, `${base}/messages?limit=${String(request.limit)}`, parseMessages, signal, true)
  if (!list.ok) return list.view
  let project: Thread['project'] = null
  const codebaseId = conversation.value.codebaseId
  if (codebaseId !== null) {
    const projects = await readParsed(client, server, CODEBASES_PATH, parseCodebases, signal, false)
    if (!projects.ok) return projects.view
    const found = projects.value.projects.find((candidate) => candidate.id === codebaseId)
    // A project Archon no longer lists is no project.
    if (found !== undefined) project = { name: found.name, defaultCwd: found.defaultCwd }
  }
  // Archon sends the newest messages oldest first; the thread draws them newest first, and stops
  // when the answer to the panel is full, counting the older messages it leaves out.
  const messages: ThreadMessage[] = []
  let bytes = 0
  let nodes = 0
  let cut = 0
  for (let index = list.value.rows.length - 1; index >= 0; index -= 1) {
    const message = list.value.rows[index] as SavedMessage
    if (!isShown(message)) continue
    if (cut > 0) {
      cut += 1
      continue
    }
    const view = messageView(message, request.toolCalls === true)
    const size = encoder.encode(JSON.stringify(view)).length
    const cost = messageDrawCost(view)
    if (bytes + size > ANSWER_BYTES || nodes + cost > ANSWER_NODES) {
      cut = 1
      continue
    }
    bytes += size
    nodes += cost
    messages.push(view)
  }
  const full = list.value.sent >= request.limit && cut === 0
  return {
    kind: 'ready',
    thread: {
      id: conversation.value.id,
      title: conversation.value.title,
      project,
      messages,
      limit: request.limit,
      earlier: full && request.limit < ARCHON_MESSAGES_CAP,
      atArchonCap: full && request.limit >= ARCHON_MESSAGES_CAP,
      unreadable: list.value.unreadable,
      cut
    }
  }
}

export type ChatThreadPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
  /** The conversations' streams: each read of a thread is their lease. */
  chatStreams?: ChatStreams
  /** A read of the thread was answered from Archon. */
  answered?(conversationId: string, view: ThreadView): void
}

/** Answers the frames' `chat.read`. */
export function startChatThread(orca: OrcaWorkerApi, ports: ChatThreadPorts): Disposable {
  return orca.panels.handle('chat.read', async (input, context): Promise<ThreadAnswer> => {
    const request = parseThreadRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, thread: { kind: 'not-connected' } }
    ports.chatStreams?.lease(connection.baseUrl, request.conversationId, request.open === true)
    const thread = await readThread(ports.client, connection, request, context.signal)
    const live = ports.chatStreams?.live(connection.baseUrl, request.conversationId) ?? null
    if (thread.kind === 'ready' && live !== null) thread.thread.live = live
    ports.answered?.(request.conversationId, thread)
    return { connection: await ports.current(), thread }
  })
}
