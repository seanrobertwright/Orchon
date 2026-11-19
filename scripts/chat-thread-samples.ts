// A chat thread as the worker would answer it, for the panel's tests and for the scenarios of
// `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { MockHostOptions } from 'orca/testing'
import type { ChatsRequest, ChatsView } from '../src/chats-view.ts'
import type { Thread, ThreadMessage, ThreadRequest, ThreadView } from '../src/chat-thread-view.ts'
import type { ConnectionView } from '../src/connection-view.ts'
import type { ScopeView } from '../src/scope-view.ts'
import { answeringChats } from './chat-samples.ts'
import { connected } from './connection-samples.ts'

/** When the sample messages were saved: minutes before noon UTC on 18 November 2026. */
const NOON = Date.UTC(2026, 10, 18, 12, 0, 0)

/** One sample message: even ones are the agent's, odd ones the person's; index 0 is the newest. */
export function sampleMessage(index: number): ThreadMessage {
  const assistant = index % 2 === 0
  return {
    id: `msg-${String(index)}`,
    role: assistant ? 'assistant' : 'user',
    at: NOON - index * 60_000,
    format: 'markdown',
    blocks: [assistant ? `Reply **${String(index)}**` : `Question ${String(index)}`],
    notShown: 0
  }
}

/** A thread of `count` sample messages, newest first, as the worker answers `request`. */
export function sampleThread(count: number, request: ThreadRequest, change: Partial<Thread> = {}): ThreadView {
  return {
    kind: 'ready',
    thread: {
      id: request.conversationId,
      title: 'Question 0',
      project: { name: 'acme/web', defaultCwd: '/home/someone/code/acme-web' },
      messages: Array.from({ length: Math.min(count, request.limit) }, (_, index) => sampleMessage(index)),
      limit: request.limit,
      earlier: count > request.limit && request.limit < 500,
      atArchonCap: count > request.limit && request.limit >= 500,
      unreadable: 0,
      cut: 0,
      ...change
    }
  }
}

/** A message by which the orchestrator started the `deploy-site` workflow in conversation `workerId`. */
export const sampleDispatch = (workerId: string | null): ThreadMessage => ({
  ...sampleMessage(0),
  id: 'msg-dispatch',
  blocks: [],
  dispatch: { workflow: 'deploy-site', workerId }
})

/** The result of the `deploy-site` workflow's run `run-5`, with `change` over it. */
export const sampleResult = (change: Partial<ThreadMessage> = {}): ThreadMessage => ({
  ...sampleMessage(0),
  id: 'msg-result',
  blocks: ['The site is **live**.'],
  result: { workflow: 'deploy-site', runId: 'run-5' },
  ...change
})

/** A thread of `count` sample messages with `messages` newest, over them, as the worker answers a request. */
export const sampleThreadWith =
  (count: number, ...messages: ThreadMessage[]) =>
  (request: ThreadRequest): ThreadView => {
    const view = sampleThread(count, request)
    if (view.kind !== 'ready') return view
    return { ...view, thread: { ...view.thread, messages: [...messages, ...view.thread.messages] } }
  }

/**
 * A stand-in for the worker that answers a thread with `thread(request)` as it stands at each
 * request, and the chat list, the scope and the runs table as `answeringChats` does.
 */
export function answeringThread(
  thread: (request: ThreadRequest) => ThreadView,
  options: { chats?: (request: ChatsRequest) => ChatsView; scope?: () => ScopeView; connection?: ConnectionView } = {}
): MockHostOptions {
  const connection = options.connection ?? connected
  const base = answeringChats(options.chats ?? (() => ({ kind: 'ready', rows: [], capped: false, unreadable: 0 })), options)
  return {
    requests: {
      ...base.requests,
      'chat.read': (request: ThreadRequest) => ({ connection, thread: thread(request) })
    }
  }
}
