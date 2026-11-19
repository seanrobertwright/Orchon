// Sending a chat message: the worker's side of **Send**. The worker is the boundary, so it checks
// every request itself before anything reaches Archon, builds each body from the keys that exist
// at the floor (Archon 0.12.1), sends each write once with the write timeout, and never tries one
// again (#18, parts 3 and 9).
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import {
  CHAT_MESSAGE_CAP,
  CHAT_PROJECTS_CAP,
  messageBytes,
  type ChatProject,
  type ChatProjectsAnswer,
  type ChatProjectsRequest,
  type ChatProjectsView,
  type ChatSendAnswer,
  type ChatSendOutcome,
  type ChatSendRequest
} from './chat-send-view'
import type { Client, ClientFailure } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import { cutAt } from './cutter'
import { SERVER_TEXT_CAP } from './run-control-view'
import { CONVERSATION_ID, CONVERSATION_ID_CAP, CONVERSATIONS_PATH } from './conversations'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { PROJECT_ID_CAP } from './scope-view'

/** Whether a message holds anything but blanks. It is still sent exactly as typed. */
export const hasWords = (message: string): boolean => message.trim() !== ''

/** A frame's request, or a refusal. The message is kept exactly as typed: a slash command passes through. */
export function parseChatSendRequest(input: unknown): ChatSendRequest {
  if (!isRecord(input)) refuseRequest('Send takes a message and a conversation id or a project id.')
  refuseOtherKeys(input, ['conversationId', 'codebaseId', 'message'], 'Send')
  const message = own(input, 'message')
  if (typeof message !== 'string' || message.length === 0 || messageBytes(message) > CHAT_MESSAGE_CAP) {
    refuseRequest(`The message must be text of 1 character to ${String(CHAT_MESSAGE_CAP)} bytes.`)
  }
  if (!hasWords(message)) refuseRequest('The message holds only blanks.')
  const conversationId = own(input, 'conversationId')
  const codebaseId = own(input, 'codebaseId')
  if ((conversationId === undefined) === (codebaseId === undefined)) refuseRequest('Send takes a conversation id or a project id, not both.')
  if (conversationId !== undefined) {
    if (typeof conversationId !== 'string' || conversationId === '' || conversationId.length > CONVERSATION_ID_CAP || !CONVERSATION_ID.test(conversationId)) {
      refuseRequest(`${cappedTextRefusal('The conversation id', CONVERSATION_ID_CAP)} It may hold only letters, digits, _ and -.`)
    }
    return { conversationId, message }
  }
  if (typeof codebaseId !== 'string' || codebaseId === '' || codebaseId.length > PROJECT_ID_CAP) {
    refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  }
  return { codebaseId, message }
}

/** A frame's request for a new chat's projects, or a refusal. */
export function parseChatProjectsRequest(input: unknown): ChatProjectsRequest {
  if (!isRecord(input)) refuseRequest("A new chat's projects take nothing but the scope's project id.")
  refuseOtherKeys(input, ['codebaseId'], "A new chat's projects")
  if (!Object.hasOwn(input, 'codebaseId')) return {}
  const codebaseId = own(input, 'codebaseId')
  if (typeof codebaseId !== 'string' || codebaseId === '' || codebaseId.length > PROJECT_ID_CAP) {
    refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  }
  return { codebaseId }
}

/** Archon's projects as a new chat offers them, read afresh. */
export async function readChatProjects(client: Client, server: Connected, request: ChatProjectsRequest, signal?: AbortSignal): Promise<ChatProjectsView> {
  const read = await client.request({ baseUrl: server.baseUrl, path: CODEBASES_PATH, timeout: 'read', ...(signal === undefined ? {} : { signal }) })
  if (!read.ok) return { kind: 'failed', message: readFailureText(read.failure) }
  const listed = parseCodebases(read.value)
  if (listed === null) return { kind: 'failed', message: unreadableAnswerText(server.version) }
  const projects: ChatProject[] = listed.projects
    .map(({ id, name, defaultCwd }) => ({ id, name, defaultCwd }))
    .sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id))
  const chosen = request.codebaseId === undefined ? null : (projects.find((project) => project.id === request.codebaseId) ?? null)
  return {
    kind: 'ready',
    chosen,
    projects: projects.slice(0, CHAT_PROJECTS_CAP),
    more: Math.max(0, projects.length - CHAT_PROJECTS_CAP),
    unreadable: listed.unreadable
  }
}

export type ChatSendPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
}

/** Said when Archon answered a send without accepting it. */
export const NOT_ACCEPTED = 'Archon did not accept the message.'

/** The worker's own refusal of a second send while one waits for Archon. */
export const SEND_IN_FLIGHT = 'Another message is still waiting for Archon.'

/** What a write that gave no value means. A timeout is never sent again: the message may have arrived. */
function failedWrite(failure: ClientFailure, goneOn404: boolean): ChatSendOutcome {
  if (failure.kind === 'timeout') return { kind: 'timeout', timeoutMs: failure.timeoutMs }
  if (failure.kind === 'status') {
    if (goneOn404 && failure.status === 404) return { kind: 'gone' }
    const error = isRecord(failure.body) ? own(failure.body, 'error') : undefined
    if (isText(error)) return { kind: 'refused', message: cutAt(error, SERVER_TEXT_CAP) }
  }
  return { kind: 'refused', message: readFailureText(failure) }
}

async function sendTo(ports: ChatSendPorts, server: Connected, conversationId: string, message: string): Promise<ChatSendOutcome> {
  const sent = await ports.client.request({
    baseUrl: server.baseUrl,
    path: `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/message`,
    method: 'POST',
    body: { message },
    timeout: 'write',
    errorBody: true
  })
  if (!sent.ok) return failedWrite(sent.failure, true)
  // The send answers `accepted`, with a status of started or queued: queued is accepted too.
  if (!isRecord(sent.value) || own(sent.value, 'accepted') !== true) return { kind: 'refused', message: NOT_ACCEPTED }
  return { kind: 'sent', conversationId }
}

/** Said when a new chat names a project Archon does not list now. */
export const PROJECT_NOT_LISTED = 'Archon does not list this project now. Choose another project.'

/** The first send of a new chat: the project must be one Archon lists now, read afresh. */
async function createIn(ports: ChatSendPorts, server: Connected, codebaseId: string, message: string): Promise<ChatSendOutcome> {
  const read = await ports.client.request({ baseUrl: server.baseUrl, path: CODEBASES_PATH, timeout: 'read' })
  if (!read.ok) return { kind: 'refused', message: readFailureText(read.failure) }
  const listed = parseCodebases(read.value)
  if (listed === null) return { kind: 'refused', message: unreadableAnswerText(server.version) }
  if (!listed.projects.some((project) => project.id === codebaseId)) return { kind: 'refused', message: PROJECT_NOT_LISTED }
  const created = await ports.client.request({
    baseUrl: server.baseUrl,
    path: CONVERSATIONS_PATH,
    method: 'POST',
    body: { codebaseId, message },
    timeout: 'write',
    errorBody: true
  })
  if (!created.ok) return failedWrite(created.failure, false)
  const conversationId = isRecord(created.value) ? own(created.value, 'conversationId') : undefined
  if (typeof conversationId !== 'string' || conversationId.length > CONVERSATION_ID_CAP || !CONVERSATION_ID.test(conversationId)) {
    return { kind: 'refused', message: unreadableAnswerText(server.version) }
  }
  return { kind: 'sent', conversationId }
}

/** Answers the frames' `chat.send` and `chat.projects`. */
export function startChatSend(orca: OrcaWorkerApi, ports: ChatSendPorts): Disposable {
  /** Whether a send waits for Archon: one at a time, from the check to the answer. */
  let sending = false
  const projects = orca.panels.handle('chat.projects', async (input, context): Promise<ChatProjectsAnswer> => {
    const request = parseChatProjectsRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, projects: { kind: 'not-connected' } }
    const view = await readChatProjects(ports.client, connection, request, context.signal)
    return { connection: await ports.current(), projects: view }
  })
  const sends = orca.panels.handle('chat.send', async (input): Promise<ChatSendAnswer> => {
    const request = parseChatSendRequest(input)
    if (sending) return { connection: await ports.current(), outcome: { kind: 'refused', message: SEND_IN_FLIGHT } }
    sending = true
    try {
      const connection = await ports.current()
      if (connection.kind !== 'connected') return { connection, outcome: { kind: 'not-connected' } }
      const outcome = Object.hasOwn(request, 'conversationId')
        ? await sendTo(ports, connection, (request as { conversationId: string }).conversationId, request.message)
        : await createIn(ports, connection, (request as { codebaseId: string }).codebaseId, request.message)
      return { connection: await ports.current(), outcome }
    } finally {
      sending = false
    }
  })
  return {
    dispose() {
      projects.dispose()
      sends.dispose()
    }
  }
}
