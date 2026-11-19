// Open run on a chat's dispatch row: a frame sends the worker conversation a dispatch named, and
// the worker asks Archon for the run that works in it, `GET /api/workflows/runs/by-worker/{id}`,
// once. It answers the run's id only, which run detail then reads.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { ChatRunAnswer, ChatRunRequest, ChatRunView } from './chat-run-view'
import type { Client } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { CONVERSATION_ID_CAP, isConversationId } from './conversations'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, own, refuseOtherKeys, refuseRequest } from './records'
import { RUN_ID_CAP } from './run-detail-view'

export const BY_WORKER_PATH = '/api/workflows/runs/by-worker/'

/** A frame's request, or a refusal: a worker conversation id the conversation id rule accepts. */
export function parseChatRunRequest(input: unknown): ChatRunRequest {
  if (!isRecord(input)) refuseRequest('Open run takes the id of the conversation the workflow works in.')
  refuseOtherKeys(input, ['workerId'], 'The Open run request')
  const workerId = own(input, 'workerId')
  if (!isConversationId(workerId)) {
    refuseRequest(`${cappedTextRefusal('The conversation id', CONVERSATION_ID_CAP)} It may hold only letters, digits, _ and -.`)
  }
  return { workerId }
}

/** The run's id in Archon's answer, or null when it holds none run detail accepts. */
function runIdOf(value: unknown): string | null {
  const run = isRecord(value) ? own(value, 'run') : undefined
  const id = isRecord(run) ? own(run, 'id') : undefined
  return isCappedText(id, RUN_ID_CAP) ? id : null
}

/** Asks Archon once for the run that works in the worker conversation. A 404 means it is not created yet. */
export async function findChatRun(client: Client, server: Connected, request: ChatRunRequest, signal: AbortSignal): Promise<ChatRunView> {
  const path = `${BY_WORKER_PATH}${encodeURIComponent(request.workerId)}`
  const answer = await client.request({ baseUrl: server.baseUrl, path, timeout: 'read', signal })
  if (!answer.ok) {
    if (answer.failure.kind === 'status' && answer.failure.status === 404) return { kind: 'not-created' }
    return { kind: 'failed', message: readFailureText(answer.failure) }
  }
  const runId = runIdOf(answer.value)
  return runId === null ? { kind: 'failed', message: unreadableAnswerText(server.version) } : { kind: 'found', runId }
}

export type ChatRunPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
}

/** Answers the frames' `chat.findRun`. */
export function startChatRun(orca: OrcaWorkerApi, ports: ChatRunPorts): Disposable {
  return orca.panels.handle('chat.findRun', async (input, context): Promise<ChatRunAnswer> => {
    const request = parseChatRunRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, run: { kind: 'not-connected' } }
    const run = await findChatRun(ports.client, connection, request, context.signal)
    return { connection: await ports.current(), run }
  })
}
