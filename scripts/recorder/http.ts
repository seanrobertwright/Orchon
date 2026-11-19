// The recorder's HTTP gateway: the one file of the recorder that uses fetch. It calls only the
// loopback address, on the port the recorder bound its release to, and never the port a
// developer's own Archon listens on. The lint config names this file as the exception.
import { DEVELOPER_PORT } from './arguments.ts'
import { createFrameSplitter, type Frame } from './frames.ts'

const HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 60_000

/** The recorder was asked to call something other than its own release. */
export class NotOwnServer extends Error {
  override name = 'NotOwnServer'
}

export interface Answer {
  status: number
  contentType: string | null
  /** The body parsed as JSON when it is JSON, and as text otherwise. */
  body: unknown
}

export interface OpenStream {
  status: number
  contentType: string | null
  /** Resolves when the stream ends, saying who ended it. */
  ended: Promise<{ by: 'server' | 'recorder' | 'error'; error?: string }>
  /** Ends the stream from this side and waits until it has ended. */
  close(): Promise<void>
}

export interface LoopbackClient {
  readonly port: number
  request(method: string, path: string, body?: unknown): Promise<Answer>
  /** Opens a server-sent event stream and hands over every frame as it arrives. */
  openStream(path: string, onFrame: (frame: Frame) => void): Promise<OpenStream>
}

export function createLoopbackClient(port: number): LoopbackClient {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new NotOwnServer('That is not a port.')
  if (port === DEVELOPER_PORT) {
    throw new NotOwnServer(`Port ${DEVELOPER_PORT} is where your own Archon listens. The recorder never calls it.`)
  }

  const urlOf = (path: string): string => {
    if (!path.startsWith('/')) throw new NotOwnServer('A path starts with a slash.')
    const url = new URL(`http://${HOST}:${port}${path}`)
    if (url.hostname !== HOST || url.port !== String(port) || url.username !== '' || url.password !== '') {
      throw new NotOwnServer('That address is not the release the recorder started.')
    }
    return url.href
  }

  return {
    port,
    async request(method, path, body) {
      const headers: Record<string, string> = {}
      if (body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(urlOf(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const text = await response.text()
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        // Not JSON: an HTML page or plain text, kept as it came.
      }
      return { status: response.status, contentType: response.headers.get('content-type'), body: parsed }
    },

    async openStream(path, onFrame) {
      const controller = new AbortController()
      const response = await fetch(urlOf(path), {
        headers: { accept: 'text/event-stream' },
        redirect: 'manual',
        signal: controller.signal
      })
      const ended = (async (): Promise<{ by: 'server' | 'recorder' | 'error'; error?: string }> => {
        if (response.body === null) return { by: 'server' }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const split = createFrameSplitter()
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) return { by: 'server' }
            for (const frame of split(decoder.decode(value, { stream: true }))) onFrame(frame)
          }
        } catch (error) {
          return controller.signal.aborted ? { by: 'recorder' } : { by: 'error', error: String(error) }
        }
      })()
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        ended,
        async close() {
          controller.abort()
          await ended
        }
      }
    }
  }
}
