// The client: the one module every call to Archon goes through, and the only caller of `fetch`.
// It talks to this computer's loopback address and nowhere else, never follows a redirect,
// bounds every call in time and in size, and takes nothing but JSON for an answer.
import { isLoopbackHost } from './loopback'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** What the client hands its transport. `redirect` is always `manual`: a redirect is not followed. */
export type FetchInit = {
  method: Method
  headers: Record<string, string>
  body?: string
  redirect: 'manual'
  signal: AbortSignal
}

/** The part of an answer the client reads. */
export type FetchAnswer = {
  status: number
  headers: { get(name: string): string | null }
  body: AsyncIterable<Uint8Array> | null
}

/** The transport: `fetch` in Orca, a scripted Archon in the tests. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchAnswer>

export const realFetch: FetchLike = (url, init) => fetch(url, init)

/** One-shot timers, so a test can move time by hand. */
export type Timers = {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** How long each kind of call may take, from the request to the last byte of the answer. */
export const TIMEOUT_MS = { health: 3_000, read: 10_000, write: 30_000 } as const
export type TimeoutKind = keyof typeof TIMEOUT_MS

/** Where the client stops reading an answer unless the call names another cap. */
export const READ_CAP_BYTES = 8 * 1024 * 1024

export type ClientCall = {
  /** `http://`, a loopback host and a port. */
  baseUrl: string
  /** A path on that server, starting with `/`. Ids in it are encoded by the caller. */
  path: string
  timeout: TimeoutKind
  /** `GET` when left out. */
  method?: Method
  /** Sent as JSON. The worker builds it; nothing from a frame is passed through. */
  body?: unknown
  maxBytes?: number
  /**
   * Keeps the JSON body of an answer outside 200 to 299, such as Archon's message on a refused
   * write. It is read under the same cap; one that is not JSON is left out.
   */
  errorBody?: boolean
  /** Aborts the call when its caller no longer wants the answer. */
  signal?: AbortSignal
}

/** Why a call gave no value. Each kind is a different thing to tell the person. */
export type ClientFailure =
  /** The URL is not on this computer. Nothing was sent. */
  | { kind: 'not-loopback' }
  /** Nothing took the connection, or it broke before the answer was whole. */
  | { kind: 'refused' }
  | { kind: 'timeout'; timeoutMs: number }
  /** The answer passed the read cap. Nothing partial is kept. */
  | { kind: 'too-large' }
  /** No JSON content type, or a body that is not JSON. From a `200` it means the feature is missing. */
  | { kind: 'not-json' }
  /** A status outside 200 to 299, a redirect included. `body` only when the call asked for it. */
  | { kind: 'status'; status: number; body?: unknown }
  /** The caller aborted the call. */
  | { kind: 'cancelled' }

export type ClientResult = { ok: true; value: unknown } | { ok: false; failure: ClientFailure }

export type Client = { request(call: ClientCall): Promise<ClientResult> }

const fail = (failure: ClientFailure): ClientResult => ({ ok: false, failure })

/** The URL to call, or null when the base is not loopback `http` or the path would leave it. */
function loopbackUrl(baseUrl: string, path: string): string | null {
  if (!URL.canParse(baseUrl)) return null
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' || !isLoopbackHost(base.hostname)) return null
  if (base.username !== '' || base.password !== '') return null
  if (!URL.canParse(path, base)) return null
  const target = new URL(path, base)
  return target.origin === base.origin ? target.href : null
}

const JSON_CONTENT_TYPE = /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i

/**
 * The body as text. It stops, with a failure, once the body passes `maxBytes` or holds bytes
 * that are not UTF-8. Leaving the loop closes the body, so nothing more is read.
 */
async function readCapped(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<string | ClientFailure> {
  if (body === null) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const decode = (chunk?: Uint8Array): string | null => {
    try {
      return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true })
    } catch {
      return null
    }
  }
  let size = 0
  let text = ''
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > maxBytes) return { kind: 'too-large' }
    const decoded = decode(chunk)
    if (decoded === null) return { kind: 'not-json' }
    text += decoded
  }
  const rest = decode()
  return rest === null ? { kind: 'not-json' } : text + rest
}

function parseJson(text: string): ClientResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return fail({ kind: 'not-json' })
  }
}

export function createClient(ports: { fetch: FetchLike; timers: Timers }): Client {
  async function exchange(url: string, call: ClientCall, signal: AbortSignal): Promise<ClientResult> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const init: FetchInit = { method: call.method ?? 'GET', headers, redirect: 'manual', signal }
    if (call.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(call.body)
    }
    const answer = await ports.fetch(url, init)
    const json = JSON_CONTENT_TYPE.test(answer.headers.get('content-type')?.trim() ?? '')
    if (answer.status < 200 || answer.status > 299) {
      if (call.errorBody !== true || !json) return fail({ kind: 'status', status: answer.status })
      const text = await readCapped(answer.body, call.maxBytes ?? READ_CAP_BYTES)
      const parsed = typeof text === 'string' ? parseJson(text) : null
      return fail(parsed?.ok === true ? { kind: 'status', status: answer.status, body: parsed.value } : { kind: 'status', status: answer.status })
    }
    if (!json) return fail({ kind: 'not-json' })
    const text = await readCapped(answer.body, call.maxBytes ?? READ_CAP_BYTES)
    return typeof text === 'string' ? parseJson(text) : fail(text)
  }

  return {
    async request(call) {
      const url = loopbackUrl(call.baseUrl, call.path)
      if (url === null) return fail({ kind: 'not-loopback' })
      if (call.signal?.aborted === true) return fail({ kind: 'cancelled' })

      const timeoutMs = TIMEOUT_MS[call.timeout]
      const controller = new AbortController()
      let ended: ClientFailure | undefined
      // The transport may ignore the signal, so the call itself also ends when it is aborted.
      const aborted = new Promise<ClientResult>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(fail(ended ?? { kind: 'cancelled' })))
      })
      const end = (failure: ClientFailure): void => {
        ended ??= failure
        controller.abort()
      }
      const timer = ports.timers.set(() => end({ kind: 'timeout', timeoutMs }), timeoutMs)
      const cancel = (): void => end({ kind: 'cancelled' })
      call.signal?.addEventListener('abort', cancel)
      try {
        return await Promise.race([
          exchange(url, call, controller.signal).catch(() => fail(ended ?? { kind: 'refused' })),
          aborted
        ])
      } finally {
        ports.timers.clear(timer)
        call.signal?.removeEventListener('abort', cancel)
        // Lets go of a body the client stopped reading.
        controller.abort()
      }
    }
  }
}
