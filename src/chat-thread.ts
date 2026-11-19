// A chat thread's request: a frame sends a conversation id and how many of its newest messages to
// read, and the worker reads the conversation, its project and its saved messages from Archon and
// answers once. The frame gets the trimmed view model of `chat-thread-view.ts`, never Archon's
// JSON. It reads saved messages only: no stream is opened here.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import {
  ARCHON_MESSAGES_CAP,
  ERROR_TEXT_CAP,
  FILE_NAME_CAP,
  FILE_NAMES_CAP,
  MESSAGE_CAP,
  THREAD_PAGE,
  TOOL_CALLS_CAP,
  TOOL_NAME_CAP,
  TOOL_TEXT_CAP,
  type Thread,
  type ThreadAnswer,
  type ThreadMessage,
  type ThreadRequest,
  type ThreadToolCall,
  type ThreadView
} from './chat-thread-view'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { CONVERSATION_ID, CONVERSATION_ID_CAP, CONVERSATIONS_PATH, parseConversation } from './conversations'
import { cutAt, cutMarkdown, cutText, oneLine } from './cutter'
import { parseInstant } from './dates'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'

/** A frame's request, or a refusal. */
export function parseThreadRequest(input: unknown): ThreadRequest {
  if (!isRecord(input)) refuseRequest('The chat thread request takes a conversation id and a limit.')
  refuseOtherKeys(input, ['conversationId', 'limit', 'toolCalls'], 'The chat thread request')
  const conversationId = own(input, 'conversationId')
  if (typeof conversationId !== 'string' || conversationId === '' || conversationId.length > CONVERSATION_ID_CAP || !CONVERSATION_ID.test(conversationId)) {
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
export function parseMessage(value: unknown): SavedMessage | null {
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
    toolCalls
  }
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
export function parseMessages(value: unknown): { rows: SavedMessage[]; sent: number; unreadable: number } | null {
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

/** A saved message trimmed for the frame. */
function messageView(message: SavedMessage, withToolCalls: boolean): ThreadMessage {
  const format = message.role === 'system' ? 'text' : 'markdown'
  const cut = format === 'markdown' ? cutMarkdown(message.content, MESSAGE_CAP) : cutText(message.content, MESSAGE_CAP)
  const view: ThreadMessage = { id: message.id, role: message.role, at: message.at, format, blocks: cut.blocks.map((block) => block.text), notShown: cut.notShown }
  if (message.error !== null) view.error = cutAt(message.error, ERROR_TEXT_CAP)
  if (message.files.length > 0) {
    const names = message.files.slice(0, FILE_NAMES_CAP).map((name) => cutAt(oneLine(name), FILE_NAME_CAP))
    view.files = { names, notShown: message.files.length - names.length }
  }
  if (withToolCalls && message.toolCalls.length > 0) view.toolCalls = toolCallsView(message)
  return view
}

/**
 * What the messages of one answer may take, so it stays inside Orca's limits on a request's
 * answer (1 MiB and 10,000 objects) with room for the rest of it.
 */
const ANSWER_BYTES = 768 * 1024
const ANSWER_OBJECTS = 8_000

const encoder = new TextEncoder()

/** How many objects and lists a value holds, itself included: what Orca's object limit counts. */
function objectCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  let count = 1
  for (const item of Object.values(value)) count += objectCount(item)
  return count
}

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
  let objects = 0
  let cut = 0
  for (let index = list.value.rows.length - 1; index >= 0; index -= 1) {
    const message = list.value.rows[index] as SavedMessage
    if (isFramework(message.category)) continue
    if (cut > 0) {
      cut += 1
      continue
    }
    const view = messageView(message, request.toolCalls === true)
    const size = encoder.encode(JSON.stringify(view)).length
    const count = objectCount(view)
    if (bytes + size > ANSWER_BYTES || objects + count > ANSWER_OBJECTS) {
      cut = 1
      continue
    }
    bytes += size
    objects += count
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
}

/** Answers the frames' `chat.read`. */
export function startChatThread(orca: OrcaWorkerApi, ports: ChatThreadPorts): Disposable {
  return orca.panels.handle('chat.read', async (input, context): Promise<ThreadAnswer> => {
    const request = parseThreadRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, thread: { kind: 'not-connected' } }
    const thread = await readThread(ports.client, connection, request, context.signal)
    return { connection: await ports.current(), thread }
  })
}
