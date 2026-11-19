// The chat list as the worker would answer it, for the panel's tests and for the scenarios of
// `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { MockHostOptions } from 'orca/testing'
import { ARCHON_CONVERSATIONS_CAP, type ChatRow, type ChatsRequest, type ChatsView } from '../src/chats-view.ts'
import type { ConnectionView } from '../src/connection-view.ts'
import type { ScopeView } from '../src/scope-view.ts'
import { connected } from './connection-samples.ts'
import { busyRuns } from './runs-samples.ts'
import { answeringScope, matchedWeb } from './scope-samples.ts'

/** When the sample conversations were last active: minutes before noon UTC on 18 November 2026. */
const NOON = Date.UTC(2026, 10, 18, 12, 0, 0)

/** One sample conversation; under "All projects" it names a project, or none for every third. */
export function sampleChat(index: number, allProjects = false): ChatRow {
  const row: ChatRow = { id: `web-chat-${String(index)}`, title: index % 4 === 3 ? null : `Question ${String(index)}`, lastActivityAt: NOON - index * 60_000 }
  if (allProjects) row.project = index % 3 === 2 ? null : 'acme/web'
  return row
}

/** `count` conversations as the worker answers the request, capped when Archon gave its cap. */
export function sampleChats(count: number, request: ChatsRequest = {}, unreadable = 0): Extract<ChatsView, { kind: 'ready' }> {
  const allProjects = request.codebaseId === undefined
  return { kind: 'ready', rows: Array.from({ length: count }, (_, index) => sampleChat(index, allProjects)), capped: count >= ARCHON_CONVERSATIONS_CAP, unreadable }
}

/**
 * A stand-in for the worker that answers the chat list with `chats(request)` as it stands at each
 * request, the scope with `scope()`, and the runs table as `answeringScope` does.
 */
export function answeringChats(
  chats: (request: ChatsRequest) => ChatsView,
  options: { scope?: () => ScopeView; connection?: ConnectionView } = {}
): MockHostOptions {
  const connection = options.connection ?? connected
  const base = answeringScope(options.scope ?? (() => matchedWeb), (request) => busyRuns(3, request), { connection })
  return {
    requests: {
      ...base.requests,
      'chats.read': (request: ChatsRequest) => ({ connection, chats: chats(request) })
    }
  }
}
