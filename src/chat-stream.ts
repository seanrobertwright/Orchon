// Live chat: the worker reads a conversation's stream while a panel shows its thread, through the
// shared reader of `conversation-streams.ts`, so the panel learns at once when the agent starts and
// stops working and which tool it uses. The panel's reads of the thread are the lease: 60 seconds
// without one lets the stream go. A frame is read for its type, and a tool call for its tool's
// name; each one read posts a hint with no message data, and the panel reads the thread again. No
// reply text is ever taken from the stream. Nothing here waits on a frame, and every timer is
// cleared when the lease ends or the worker stops.
import type { Timers } from './client'
import type { ChatHint, ThreadLive } from './chat-thread-view'
import { TOOL_NAME_CAP } from './chat-thread-view'
import type { ConversationEvent, ConversationStreams, StreamHold } from './conversation-streams'
import { cutAt, oneLine } from './cutter'
import { FIRST_STREAM_RETRY_MS, HINT_GAP_MS, LAST_STREAM_RETRY_MS } from './live'

/** How long a read of the thread holds its conversation's stream (#18, part 4). */
export const CHAT_LEASE_MS = 60_000

export type ChatStreamsPorts = {
  streams: ConversationStreams
  now(): number
  timers: Timers
  /** Posts a hint that the conversation changed. It carries no message data. */
  hint(hint: ChatHint): void
}

export type ChatStreams = {
  /**
   * A panel read the thread: the lease is renewed, and the stream opened unless it is held, its
   * reconnect is waiting, or it was displaced. `opened` says the person opened the thread, which
   * is the one thing that opens a displaced stream again.
   */
  lease(baseUrl: string, conversationId: string, opened: boolean): void
  /** What the stream has said of the conversation's turn, or null when the worker holds none that said anything. */
  live(baseUrl: string, conversationId: string): ThreadLive | null
  /** Lets every stream go and clears every timer. Nothing is heard after. */
  stop(): void
}

type Lease = {
  baseUrl: string
  conversationId: string
  hold: StreamHold | null
  /** Rises with each listen, so an older hold's events change nothing. */
  generation: number
  /** Another reader took the stream: it is not opened again until the thread is. */
  displaced: boolean
  /** Null until a `conversation_lock` frame says. */
  busy: boolean | null
  tool: string | null
  leaseTimer: unknown
  retryTimer: unknown
  retryDelay: number
  hintTimer: unknown
  lastHint: number | undefined
}

export function createChatStreams(ports: ChatStreamsPorts): ChatStreams {
  const leases = new Map<string, Lease>()
  let stopped = false

  const keyOf = (baseUrl: string, conversationId: string): string => `${baseUrl}\n${conversationId}`

  function clear(timer: unknown): undefined {
    if (timer !== undefined) ports.timers.clear(timer)
    return undefined
  }

  /** At most one hint a second per conversation. */
  function hint(lease: Lease): void {
    if (lease.hintTimer !== undefined) return
    const post = (): void => {
      lease.hintTimer = undefined
      lease.lastHint = ports.now()
      ports.hint({ conversationId: lease.conversationId })
    }
    const wait = lease.lastHint === undefined ? 0 : lease.lastHint + HINT_GAP_MS - ports.now()
    if (wait <= 0) post()
    else lease.hintTimer = ports.timers.set(post, wait)
  }

  /** The stream says nothing now: the panel falls back on what the saved messages show. */
  function forget(lease: Lease): void {
    lease.hold?.close()
    lease.hold = null
    lease.generation += 1
    lease.busy = null
    lease.tool = null
  }

  function hear(lease: Lease, mine: number, event: ConversationEvent): void {
    if (mine !== lease.generation) return
    if (event.kind === 'ended') {
      forget(lease)
      if (event.cause === 'network') {
        const wait = lease.retryDelay
        lease.retryDelay = Math.min(lease.retryDelay * 2, LAST_STREAM_RETRY_MS)
        lease.retryTimer = ports.timers.set(() => {
          lease.retryTimer = undefined
          listen(lease)
        }, wait)
      } else {
        lease.displaced = true
      }
      hint(lease)
      return
    }
    const { frame } = event
    switch (frame.type) {
      case 'lock':
        lease.busy = frame.locked
        lease.tool = null
        break
      case 'tool_call':
        lease.tool = cutAt(oneLine(frame.name), TOOL_NAME_CAP)
        break
      case 'tool_result':
        lease.tool = null
        break
      case 'text':
      case 'error':
      case 'warning':
        break
      // Any other frame, such as the launcher's dispatch, is not chat's to read.
      default:
        return
    }
    // A frame came through, so the stream is open and the backoff starts over.
    lease.retryDelay = FIRST_STREAM_RETRY_MS
    hint(lease)
  }

  function listen(lease: Lease): void {
    if (stopped) return
    lease.generation += 1
    const mine = lease.generation
    // Null when chat already holds its cap of streams: the thread runs on its timers alone.
    lease.hold = ports.streams.listen({
      baseUrl: lease.baseUrl,
      conversationId: lease.conversationId,
      purpose: 'chat',
      listener: (event) => hear(lease, mine, event)
    })
  }

  function end(lease: Lease): void {
    forget(lease)
    lease.leaseTimer = clear(lease.leaseTimer)
    lease.retryTimer = clear(lease.retryTimer)
    lease.hintTimer = clear(lease.hintTimer)
    leases.delete(keyOf(lease.baseUrl, lease.conversationId))
  }

  return {
    lease(baseUrl, conversationId, opened) {
      if (stopped) return
      const key = keyOf(baseUrl, conversationId)
      let lease = leases.get(key)
      if (lease === undefined) {
        lease = {
          baseUrl,
          conversationId,
          hold: null,
          generation: 0,
          displaced: false,
          busy: null,
          tool: null,
          leaseTimer: undefined,
          retryTimer: undefined,
          retryDelay: FIRST_STREAM_RETRY_MS,
          hintTimer: undefined,
          lastHint: undefined
        }
        leases.set(key, lease)
      }
      const held = lease
      held.leaseTimer = clear(held.leaseTimer)
      held.leaseTimer = ports.timers.set(() => {
        held.leaseTimer = undefined
        end(held)
      }, CHAT_LEASE_MS)
      if (opened && held.displaced) {
        held.displaced = false
        held.retryDelay = FIRST_STREAM_RETRY_MS
      }
      if (held.hold === null && !held.displaced && held.retryTimer === undefined) listen(held)
    },
    live(baseUrl, conversationId) {
      const lease = leases.get(keyOf(baseUrl, conversationId))
      if (lease === undefined || lease.hold === null || (lease.busy === null && lease.tool === null)) return null
      return { busy: lease.busy, tool: lease.tool }
    },
    stop() {
      stopped = true
      for (const lease of [...leases.values()]) end(lease)
    }
  }
}
