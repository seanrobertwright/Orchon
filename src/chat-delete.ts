// Deleting a conversation: the worker's side of a thread's **Delete**. The worker checks the
// conversation id itself, sends one `DELETE /api/conversations/{id}`, the route every supported
// release's path list holds, with the write timeout, and never sends it again (#18, part 7).
// Archon's delete is a soft delete with no undo through its API.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { ChatDeleteAnswer, ChatDeleteOutcome, ChatDeleteRequest } from './chat-delete-view'
import type { Client } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { CONVERSATION_ID_CAP, CONVERSATIONS_PATH, isConversationId } from './conversations'
import { cutAt } from './cutter'
import { readFailureText } from './read-failure'
import { cappedTextRefusal, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { SERVER_TEXT_CAP } from './run-control-view'

/** Said when Archon answered a delete without saying it deleted the conversation. */
export const NOT_DELETED = 'Archon did not say it deleted the conversation.'

/** A frame's request, or a refusal. */
export function parseChatDeleteRequest(input: unknown): ChatDeleteRequest {
  if (!isRecord(input)) refuseRequest('Delete takes a conversation id.')
  refuseOtherKeys(input, ['conversationId'], 'Delete')
  const conversationId = own(input, 'conversationId')
  if (!isConversationId(conversationId) || conversationId === '') {
    refuseRequest(`${cappedTextRefusal('The conversation id', CONVERSATION_ID_CAP)} It may hold only letters, digits, _ and -.`)
  }
  return { conversationId }
}

async function deleteConversation(client: Client, server: Connected, conversationId: string): Promise<ChatDeleteOutcome> {
  const sent = await client.request({
    baseUrl: server.baseUrl,
    path: `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}`,
    method: 'DELETE',
    timeout: 'write',
    errorBody: true
  })
  if (!sent.ok) {
    const { failure } = sent
    if (failure.kind === 'timeout') return { kind: 'timeout', timeoutMs: failure.timeoutMs }
    if (failure.kind === 'status') {
      if (failure.status === 404) return { kind: 'gone' }
      const error = isRecord(failure.body) ? own(failure.body, 'error') : undefined
      if (isText(error)) return { kind: 'refused', message: cutAt(error, SERVER_TEXT_CAP) }
    }
    return { kind: 'refused', message: readFailureText(failure) }
  }
  if (!isRecord(sent.value) || own(sent.value, 'success') !== true) return { kind: 'refused', message: NOT_DELETED }
  return { kind: 'deleted' }
}

export type ChatDeletePorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
  /** The conversation no longer exists in Archon: what the worker keeps of it goes. */
  removed?(conversationId: string): void
}

/** Answers the frames' `chat.delete`. */
export function startChatDelete(orca: OrcaWorkerApi, ports: ChatDeletePorts): Disposable {
  return orca.panels.handle('chat.delete', async (input): Promise<ChatDeleteAnswer> => {
    const { conversationId } = parseChatDeleteRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, outcome: { kind: 'not-connected' } }
    const outcome = await deleteConversation(ports.client, connection, conversationId)
    if (outcome.kind === 'deleted' || outcome.kind === 'gone') ports.removed?.(conversationId)
    return { connection: await ports.current(), outcome }
  })
}
