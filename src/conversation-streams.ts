// The stream reader for Archon's conversation streams, `/api/stream/{conversationId}`: one reader
// per conversation, shared by everyone who listens to it, so the launch tracker and chat never
// hold two. Archon gives a conversation's stream to one reader at a time: when another takes it,
// the stream ends with no frame, and the reader is never opened again. It reads through the one
// client and parses frames by hand. Nothing here waits on a frame: every promise is caught, since
// an unhandled rejection would stop the worker.
import type { Client } from './client'
import { errorText } from './records'
import { createFrameParser, readConversationFrame, type ConversationFrame } from './stream-frames'

/** Who listens to a conversation's stream, each with a cap on how many streams it holds open. */
export type StreamPurpose = 'launch' | 'chat'

/** The most streams each purpose holds open (#15, #18). */
export const STREAM_CAPS: Readonly<Record<StreamPurpose, number>> = { launch: 20, chat: 5 }

/** Archon's stream of one conversation. The id is the conversation's platform id. */
export const conversationStreamPath = (conversationId: string): string => `/api/stream/${encodeURIComponent(conversationId)}`

export type ConversationEvent =
  | { kind: 'frame'; frame: ConversationFrame }
  /**
   * The stream ended, broke or could not be opened: another reader took it, or the server let it
   * go. It is not opened again for anyone listening now.
   */
  | { kind: 'ended' }

export type StreamListener = (event: ConversationEvent) => void

/** One listener's hold on a conversation's stream. */
export type StreamHold = {
  /** Stops listening; the stream closes once nobody listens. */
  close(): void
}

export type ConversationStreams = {
  /**
   * Listens to a conversation's stream, opening it at once unless it is already open, in which
   * case the open reader is shared. Null when the purpose already holds its cap of streams.
   */
  listen(request: { baseUrl: string; conversationId: string; purpose: StreamPurpose; listener: StreamListener }): StreamHold | null
  /** Closes every stream. Nothing is heard after. */
  stop(): void
}

export type ConversationStreamsPorts = {
  client: Client
  log(message: string): void
}

type Reader = {
  key: string
  controller: AbortController
  listeners: Map<number, { purpose: StreamPurpose; listener: StreamListener }>
  ended: boolean
}

export function createConversationStreams(ports: ConversationStreamsPorts): ConversationStreams {
  const readers = new Map<string, Reader>()
  let nextHold = 1
  let stopped = false

  const held = (purpose: StreamPurpose): number =>
    [...readers.values()].filter((reader) => [...reader.listeners.values()].some((entry) => entry.purpose === purpose)).length

  function tell(reader: Reader, event: ConversationEvent): void {
    for (const { listener } of [...reader.listeners.values()]) {
      try {
        listener(event)
      } catch (error) {
        ports.log(`Orchon could not act on a conversation's stream: ${errorText(error)}`)
      }
    }
  }

  function end(reader: Reader): void {
    if (reader.ended) return
    reader.ended = true
    if (readers.get(reader.key) === reader) readers.delete(reader.key)
    if (!reader.controller.signal.aborted) tell(reader, { kind: 'ended' })
    reader.controller.abort()
  }

  async function read(reader: Reader, baseUrl: string, conversationId: string): Promise<void> {
    const { signal } = reader.controller
    try {
      const opened = await ports.client.stream({ baseUrl, path: conversationStreamPath(conversationId), signal })
      if (!opened.ok) return
      const parser = createFrameParser()
      for await (const text of opened.text) {
        const frames = parser.push(text)
        if (frames === null) break
        for (const frame of frames) {
          const read = readConversationFrame(frame)
          if (read !== null && !signal.aborted) tell(reader, { kind: 'frame', frame: read })
        }
      }
    } finally {
      end(reader)
    }
  }

  return {
    listen({ baseUrl, conversationId, purpose, listener }) {
      if (stopped) return null
      const key = `${baseUrl}\n${conversationId}`
      let reader = readers.get(key)
      const shared = reader !== undefined && [...reader.listeners.values()].some((entry) => entry.purpose === purpose)
      if (!shared && held(purpose) >= STREAM_CAPS[purpose]) return null
      if (reader === undefined) {
        const opened: Reader = { key, controller: new AbortController(), listeners: new Map(), ended: false }
        readers.set(key, opened)
        reader = opened
        read(opened, baseUrl, conversationId).catch((error: unknown) => {
          ports.log(`Orchon could not read a conversation's stream: ${errorText(error)}`)
        })
      }
      const id = nextHold
      nextHold += 1
      const mine = reader
      mine.listeners.set(id, { purpose, listener })
      return {
        close() {
          mine.listeners.delete(id)
          if (mine.listeners.size === 0 && !mine.ended) {
            mine.controller.abort()
            end(mine)
          }
        }
      }
    },
    stop() {
      stopped = true
      for (const reader of [...readers.values()]) {
        reader.listeners.clear()
        reader.controller.abort()
        end(reader)
      }
    }
  }
}
