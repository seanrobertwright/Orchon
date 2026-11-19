// The last answer for each thread on screen, kept by the worker in memory only, so a panel that
// mounts again draws the thread at once while it reads it afresh. A thread's reads hold a lease of
// `THREAD_LEASE_MS` on it; when the lease ends, or the conversation is gone or deleted, its answer is
// dropped. Nothing of it is written anywhere, and nothing is counted as unread.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { LAST_ANSWERS_CAP, THREAD_LEASE_MS, type ChatLastAnswer, type ChatLastRequest } from './chat-last-view'
import type { Thread, ThreadView } from './chat-thread-view'
import { parseConversationId } from './conversations'
import { isRecord, own, refuseOtherKeys, refuseRequest } from './records'

/** A frame's request, or a refusal. */
export function parseChatLastRequest(input: unknown): ChatLastRequest {
  if (!isRecord(input)) refuseRequest("A thread's last answer takes a conversation id.")
  refuseOtherKeys(input, ['conversationId'], "A thread's last answer")
  const conversationId = parseConversationId(own(input, 'conversationId'))
  return { conversationId }
}

export type ThreadMemory = Disposable & {
  /** A read of the thread was answered: a ready answer is kept and renews the lease, a gone one drops it. */
  answered(conversationId: string, view: ThreadView): void
  /** The conversation was deleted. */
  forget(conversationId: string): void
}

/** Answers the frames' `chat.last`. */
export function startChatLast(orca: OrcaWorkerApi, ports: { now(): number }): ThreadMemory {
  /** By conversation id, the least recently read first. */
  const kept = new Map<string, { thread: Thread; readAt: number }>()

  function prune(): void {
    const at = ports.now()
    for (const [id, entry] of kept) if (at - entry.readAt >= THREAD_LEASE_MS) kept.delete(id)
    while (kept.size > LAST_ANSWERS_CAP) {
      const oldest = kept.keys().next()
      if (oldest.done === true) break
      kept.delete(oldest.value)
    }
  }

  const handle = orca.panels.handle('chat.last', (input): ChatLastAnswer => {
    const { conversationId } = parseChatLastRequest(input)
    prune()
    return { thread: kept.get(conversationId)?.thread ?? null }
  })
  return {
    answered(conversationId, view) {
      if (view.kind === 'ready') {
        kept.delete(conversationId)
        kept.set(conversationId, { thread: view.thread, readAt: ports.now() })
      } else if (view.kind === 'gone') kept.delete(conversationId)
      prune()
    },
    forget(conversationId) {
      kept.delete(conversationId)
    },
    dispose() {
      handle.dispose()
      kept.clear()
    }
  }
}
