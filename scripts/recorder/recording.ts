// A recording: everything the recorder sent and everything the release answered during one
// scenario, in order. Every fixture of a release is one recording.
import type { Frame } from './frames.ts'
import type { Answer, LoopbackClient, OpenStream } from './http.ts'

/** One thing that happened. `kind` says which fields it has. */
export interface LogEntry {
  /** Milliseconds since the scenario began. */
  atMs: number
  /**
   * `http` is a request with its answer; `stream-open`, `frame` and `stream-end` are a stream;
   * every other kind marks what the recorder did or saw between requests.
   */
  kind: string
  [field: string]: unknown
}

export interface Recording {
  /** The Archon release that answered, such as `0.12.1`. */
  release: string
  scenario: string
  log: LogEntry[]
}

export interface StreamReader {
  label: string
  /** Every frame read so far. */
  frames: Frame[]
  hasEnded(): boolean
  close(): Promise<void>
}

export interface Tape {
  readonly log: LogEntry[]
  /** Milliseconds since the tape began. */
  at(): number
  /** Adds an entry that is not a request: what the recorder did or saw. */
  note(kind: string, data?: Record<string, unknown>): void
  /** Sends a request and adds it, with its answer, to the log. */
  call(method: string, path: string, body?: unknown): Promise<Answer>
  /** Sends a request that is not added to the log: polling between the recorded steps. */
  peek(method: string, path: string): Promise<Answer>
  /** Opens a stream and adds every frame to the log under `label`. */
  stream(label: string, path: string): Promise<StreamReader>
}

export function createTape(client: LoopbackClient, now: () => number = () => performance.now()): Tape {
  const began = now()
  const at = (): number => Math.round(now() - began)
  const log: LogEntry[] = []
  const note = (kind: string, data: Record<string, unknown> = {}): void => {
    log.push({ atMs: at(), kind, ...data })
  }
  return {
    log,
    at,
    note,
    async call(method, path, body) {
      const startedMs = at()
      try {
        const answer = await client.request(method, path, body)
        note('http', { method, path, requestBody: body ?? null, startedMs, ...answer })
        return answer
      } catch (error) {
        note('http-failed', { method, path, requestBody: body ?? null, startedMs, error: String(error) })
        throw error
      }
    },
    peek: (method, path) => client.request(method, path),
    async stream(label, path) {
      const frames: Frame[] = []
      let ended = false
      let open: OpenStream
      try {
        open = await client.openStream(path, (frame) => {
          frames.push(frame)
          note('frame', { label, ...frame })
        })
      } catch (error) {
        note('stream-open-failed', { label, path, error: String(error) })
        return { label, frames, hasEnded: () => true, close: async () => undefined }
      }
      note('stream-open', { label, path, status: open.status, contentType: open.contentType })
      void open.ended.then((end) => {
        ended = true
        note('stream-end', { label, ...end })
      })
      return { label, frames, hasEnded: () => ended, close: () => open.close() }
    }
  }
}
