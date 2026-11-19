// The chat list's request: a frame sends the project scope, and the worker reads the scope's web
// conversations from Archon and answers once. The frame gets the trimmed view model of
// `chats-view.ts`, never Archon's JSON.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { ARCHON_CONVERSATIONS_CAP, type ChatRow, type ChatsAnswer, type ChatsRequest, type ChatsView } from './chats-view'
import { CONVERSATIONS_PATH, parseConversations, WEB_PLATFORM } from './conversations'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { launchedConversationIds } from './launch'
import { cappedTextRefusal, isCappedText, isRecord, own, refuseOtherKeys, refuseRequest } from './records'
import { PROJECT_ID_CAP } from './scope-view'

/** A frame's request, or a refusal: nothing, or the id of an Archon project. */
export function parseChatsRequest(input: unknown): ChatsRequest {
  if (input === undefined || input === null) return {}
  if (!isRecord(input)) refuseRequest('The chat list request takes the id of an Archon project, or nothing.')
  refuseOtherKeys(input, ['codebaseId'], 'The chat list request')
  if (!Object.hasOwn(input, 'codebaseId')) return {}
  const codebaseId = own(input, 'codebaseId')
  if (!isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  return { codebaseId }
}

function listPath(request: ChatsRequest): string {
  const query = new URLSearchParams({ platform: WEB_PLATFORM })
  if (request.codebaseId !== undefined) query.set('codebaseId', request.codebaseId)
  return `${CONVERSATIONS_PATH}?${query.toString()}`
}

/** One read of Archon, parsed: the value, or the failure the panel says. */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

async function readParsed<T>(
  client: Client,
  server: Connected,
  path: string,
  parse: (value: unknown) => T | null,
  signal: AbortSignal
): Promise<Parsed<T>> {
  const answer = await client.request({ baseUrl: server.baseUrl, path, timeout: 'read', signal })
  if (!answer.ok) return { ok: false, message: readFailureText(answer.failure) }
  const value = parse(answer.value)
  return value === null ? { ok: false, message: unreadableAnswerText(server.version) } : { ok: true, value }
}

/** Reads the scope's web conversations once. */
export async function readChats(
  client: Client,
  server: Connected,
  request: ChatsRequest,
  signal: AbortSignal,
  launched: ReadonlySet<string> = new Set()
): Promise<ChatsView> {
  const read = await readParsed(client, server, listPath(request), parseConversations, signal)
  if (!read.ok) return { kind: 'failed', message: read.message }
  const list = read.value
  // Under "All projects" each row names its project, from Archon's list of them.
  let names: Map<string, string> | undefined
  if (request.codebaseId === undefined) {
    const projects = await readParsed(client, server, CODEBASES_PATH, parseCodebases, signal)
    if (!projects.ok) return { kind: 'failed', message: projects.message }
    names = new Map(projects.value.projects.map((project) => [project.id, project.name]))
  }
  const rows: ChatRow[] = []
  for (const conversation of list.rows) {
    // CLI and Telegram conversations are never listed, nor the launcher's own.
    if (conversation.platform !== WEB_PLATFORM || launched.has(conversation.id)) continue
    const row: ChatRow = { id: conversation.id, title: conversation.title, lastActivityAt: conversation.lastActivityAt }
    // A project Archon no longer lists is no project.
    if (names !== undefined) row.project = conversation.codebaseId === null ? null : (names.get(conversation.codebaseId) ?? null)
    rows.push(row)
  }
  return { kind: 'ready', rows, capped: list.sent >= ARCHON_CONVERSATIONS_CAP, unreadable: list.unreadable }
}

export type ChatListPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
}

/** Answers the frames' `chats.read`. */
export function startChatList(orca: OrcaWorkerApi, ports: ChatListPorts): Disposable {
  return orca.panels.handle('chats.read', async (input, context): Promise<ChatsAnswer> => {
    const request = parseChatsRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, chats: { kind: 'not-connected' } }
    const chats = await readChats(ports.client, connection, request, context.signal, await launchedConversationIds(orca, connection))
    return { connection: await ports.current(), chats }
  })
}
