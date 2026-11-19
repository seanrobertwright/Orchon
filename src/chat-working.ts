// What the panel holds of a conversation's stream: what the worker last said of each thread's turn
// while it reads the stream, so that busy comes from the stream's `conversation_lock` frames and
// the working line names the tool in use. When the worker no longer reads the stream, the thread
// says nothing of it and busy is inferred from the saved messages again (`chat-composer.tsx`).
import { atom, read, set } from 'orca'
import type { ThreadLive } from './chat-thread-view'
import { now } from './dates'

/** What the stream said, and since when its busy has said the same, by conversation. */
type Said = ThreadLive & { since: number }

const said = atom<Record<string, Said>>({})

const saidOf = (conversationId: string): Said | undefined => {
  const all = read(said)
  return Object.hasOwn(all, conversationId) ? all[conversationId] : undefined
}

/** Takes what a thread answer carried of the stream; none means the worker does not read it now. */
export function observeLive(conversationId: string, live: ThreadLive | undefined): void {
  const before = saidOf(conversationId)
  if (live === undefined && before === undefined) return
  const next = { ...read(said) }
  if (live === undefined) delete next[conversationId]
  else next[conversationId] = { busy: live.busy, tool: live.tool, since: before !== undefined && before.busy === live.busy ? before.since : now() }
  set(said, next)
}

/**
 * Whether the conversation is busy. While the stream says, it is: busy, or a message sent after
 * it last said not busy and before it says the turn began. Otherwise a turn the panel inferred,
 * which began at `turnSince`, is busy.
 */
export function streamBusy(conversationId: string, turnSince: number | undefined): boolean {
  const live = saidOf(conversationId)
  if (live === undefined || live.busy === null) return turnSince !== undefined
  return live.busy || (turnSince !== undefined && turnSince > live.since)
}

/** The working line: it names the tool the agent is using when the worker knows it. */
export function workingLabel(conversationId: string): string {
  const tool = saidOf(conversationId)?.tool ?? null
  return tool === null ? 'Working…' : `Working: ${tool}…`
}
