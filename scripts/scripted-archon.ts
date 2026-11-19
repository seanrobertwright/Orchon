// A scripted Archon for the tests: it stands in at the client's transport, so no test opens a
// socket or depends on what answers on the machine. With it come a clock the test moves by hand
// and an in-memory disk. It is development tooling: Orca never loads it.
import { join, parse } from 'node:path'
import { mockHost, mountWorker, type MockHost, type MockHostOptions, type TestWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { FetchAnswer, FetchInit, FetchLike, Timers } from '../src/client.ts'
import type { ConnectionView } from '../src/connection-view.ts'
import { DEFAULT_BASE_URL } from '../src/discovery.ts'
import type { Disk, DiskEntry, FolderState, TextFile, WriteOutcome } from '../src/disk.ts'
import { ATTENTION_PATH, RUNNING_PATH } from '../src/needs-you.ts'
import { OPENAPI_PATH } from '../src/path-check.ts'
import { start } from '../src/worker.ts'
import { readRepoText } from './repo-files.ts'
import { field } from './shape.ts'

/** Lets every promise chain that is ready run to its next real wait. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

export type Clock = {
  now(): number
  timers: Timers
  /** Moves time forward, running each timer that falls due at its own moment. */
  advance(ms: number): Promise<void>
  /** How far ahead each waiting timer is, soonest first. */
  waiting(): number[]
}

/** When a scripted clock starts: noon UTC on 18 November 2026. */
export const CLOCK_START = Date.UTC(2026, 10, 18, 12, 0, 0)

/** A clock that only moves when the test says so. */
export function createClock(start = CLOCK_START): Clock {
  let time = start
  let nextId = 1
  const due = new Map<number, { at: number; run: () => void }>()
  const soonest = (): [number, { at: number; run: () => void }] | undefined =>
    [...due.entries()].sort(([a, first], [b, second]) => first.at - second.at || a - b)[0]

  return {
    now: () => time,
    timers: {
      set(run, ms) {
        const id = nextId
        nextId += 1
        due.set(id, { at: time + ms, run })
        return id
      },
      clear(handle) {
        if (typeof handle === 'number') due.delete(handle)
      }
    },
    async advance(ms) {
      const target = time + ms
      await settle()
      for (let next = soonest(); next !== undefined && next[1].at <= target; next = soonest()) {
        const [id, timer] = next
        due.delete(id)
        time = timer.at
        timer.run()
        await settle()
      }
      time = target
      await settle()
    },
    waiting: () => [...due.values()].map((timer) => timer.at - time).sort((a, b) => a - b)
  }
}

/** What the scripted Archon does with one request. */
export type Scripted =
  | { kind: 'json'; value: unknown; status?: number; contentType?: string }
  | { kind: 'text'; text: string; contentType: string | null; status?: number }
  | { kind: 'chunks'; chunks: Uint8Array[]; contentType?: string }
  /** Nothing listens: the connection is refused. */
  | { kind: 'refuse' }
  /** The server takes the connection and never answers, until the caller gives up. */
  | { kind: 'hang' }
  /** A body held open: the test sends its text piece by piece, and ends or breaks it. */
  | ScriptedStream

/** A held-open answer, such as Archon's dashboard stream. Each one answers a single request. */
export type ScriptedStream = {
  kind: 'stream'
  contentType: string | null
  status: number
  /** Sends one more piece of the body. */
  send(text: string): void
  /** The server ends the body. */
  end(): void
  /** The connection breaks before the body ends. */
  break(): void
  /** Whether a request took this answer. */
  readonly opened: boolean
  /** Whether the caller let go of the body: it aborted, or stopped reading. */
  readonly closed: boolean
  /** The body the scripted Archon answers with: it ends when the signal aborts. */
  body(signal: AbortSignal): AsyncIterable<Uint8Array>
}

/** A held-open answer with the event-stream content type, unless told otherwise. */
export function openStream(options: { contentType?: string | null; status?: number } = {}): ScriptedStream {
  const queue: (string | 'end' | 'break')[] = []
  let wake = (): void => {}
  let opened = false
  let closed = false
  const push = (item: string | 'end' | 'break'): void => {
    queue.push(item)
    wake()
  }
  return {
    kind: 'stream',
    contentType: options.contentType === undefined ? 'text/event-stream' : options.contentType,
    status: options.status ?? 200,
    send: (text) => push(text),
    end: () => push('end'),
    break: () => push('break'),
    get opened() {
      return opened
    },
    get closed() {
      return closed
    },
    body(signal) {
      opened = true
      return {
        [Symbol.asyncIterator]: () => ({
          async next(): Promise<IteratorResult<Uint8Array>> {
            for (;;) {
              if (signal.aborted) {
                closed = true
                throw new DOMException('aborted', 'AbortError')
              }
              const item = queue.shift()
              if (item === 'end') return { done: true, value: undefined }
              if (item === 'break') throw new TypeError('terminated', { cause: { code: 'ECONNRESET' } })
              if (item !== undefined) return { done: false, value: encoder.encode(item) }
              await new Promise<void>((resolve) => {
                wake = resolve
                signal.addEventListener('abort', () => resolve(), { once: true })
              })
            }
          },
          return(): Promise<IteratorResult<Uint8Array>> {
            closed = true
            return Promise.resolve({ done: true, value: undefined })
          }
        })
      }
    }
  }
}

export type ScriptedCall = { url: string; method: string; redirect: string; headers: Record<string, string>; body?: string }

export type ScriptedArchon = {
  fetch: FetchLike
  /**
   * Every request that reached the transport, in order, except the opens of a stream and the
   * snapshot's reads.
   */
  calls: ScriptedCall[]
  /** Every open of a stream (a path under `/api/stream/`), in order. */
  streams: ScriptedCall[]
  /**
   * Every read of the snapshot of runs that need you (`/api/runs/attention` and
   * `/api/dashboard/runs?limit=1`), in order. The worker sends them by itself while Connected.
   */
  snapshots: ScriptedCall[]
  /**
   * Sets what one URL answers from now on. A URL never set refuses the connection, with three
   * exceptions. A path list: an Archon is the floor release unless told otherwise, so
   * `/api/openapi.json` answers the recorded document of 0.12.1. A stream: it takes the
   * connection and sends nothing until told otherwise, so a test that is not about live
   * updates sees no frame and no hint. And the two reads of the snapshot of runs that need you,
   * which the worker sends by itself while Connected: they answer the floor's recorded empty
   * queue and empty run list, so a test that is not about them sees nothing waiting.
   */
  answer(url: string, scripted: Scripted | ((call: ScriptedCall) => Scripted)): void
  /** How many body chunks the caller took from the last answer, and whether it closed the body. */
  lastBody: { taken: number; closed: boolean }
}

const encoder = new TextEncoder()

export const json = (value: unknown, status = 200): Scripted => ({ kind: 'json', value, status })
export const html = (status = 200): Scripted => ({
  kind: 'text',
  text: '<!doctype html><html><body>Archon</body></html>',
  contentType: 'text/html; charset=utf-8',
  status
})
export const REFUSE: Scripted = { kind: 'refuse' }
export const HANG: Scripted = { kind: 'hang' }

/** A health answer as Archon gives it, trimmed to a few of its fields. */
export const health = (fields: Record<string, unknown> = {}): Scripted =>
  json({ status: 'ok', adapter: 'web', runningWorkflows: 0, version: '0.12.1', ...fields })

/** The releases with recorded fixtures, oldest first. */
export const RELEASES = ['0.12.1', '0.13.2', '0.14.0'] as const
export type Release = (typeof RELEASES)[number]

/**
 * One answer a recorded fixture holds, the first unless `index` names another, as the scripted
 * Archon gives it: the recorded status, content type and body. Fixtures are recorded from real
 * releases, never typed.
 */
export function recorded(release: Release, scenario: string, index = 0): Scripted {
  const log = field(JSON.parse(readRepoText(`fixtures/${release}/${scenario}.json`)), 'log')
  const first: unknown = Array.isArray(log) ? log[index] : undefined
  const status = field(first, 'status')
  const contentType = field(first, 'contentType')
  const body = field(first, 'body')
  if (typeof status !== 'number' || typeof contentType !== 'string') {
    throw new Error(`fixtures/${release}/${scenario}.json holds no recorded answer at ${String(index)}.`)
  }
  return typeof body === 'string'
    ? { kind: 'text', text: body, contentType, status }
    : { kind: 'json', value: body, status, contentType }
}

/** The request body a recorded fixture holds at `index`, as Archon was sent it. */
export function recordedRequest(release: Release, scenario: string, index: number): unknown {
  const log = field(JSON.parse(readRepoText(`fixtures/${release}/${scenario}.json`)), 'log')
  return field(Array.isArray(log) ? log[index] : undefined, 'requestBody')
}

/** A recorded path list with some paths taken out, as an Archon that lacks them would answer. */
export function pathListWithout(release: Release, ...paths: string[]): Scripted {
  const document = recorded(release, 'openapi')
  if (document.kind !== 'json') throw new Error(`The recorded path list of ${release} is not JSON.`)
  const all = field(document.value, 'paths')
  const kept = Object.fromEntries(Object.entries(all as Record<string, unknown>).filter(([path]) => !paths.includes(path)))
  return { ...document, value: { ...(document.value as Record<string, unknown>), paths: kept } }
}

let floorPathList: Scripted | undefined

function floorPathListAnswer(): Scripted {
  floorPathList ??= recorded('0.12.1', 'openapi')
  return floorPathList
}

/** The snapshot's two paths, with the floor's recorded answers when nothing waits and nothing runs. */
const SNAPSHOT_PATHS = new Map<string, () => Scripted>([
  [ATTENTION_PATH, () => recorded('0.12.1', 'attention-empty')],
  [RUNNING_PATH, () => recorded('0.12.1', 'dashboard-runs-empty', 1)]
])
const snapshotAnswers = new Map<string, Scripted>()

/** The floor's recorded answer to one of the snapshot's reads, or undefined for any other path. */
function snapshotAnswer(pathAndQuery: string): Scripted | undefined {
  const make = SNAPSHOT_PATHS.get(pathAndQuery)
  if (make === undefined) return undefined
  const answer = snapshotAnswers.get(pathAndQuery) ?? make()
  snapshotAnswers.set(pathAndQuery, answer)
  return answer
}

export function scriptArchon(): ScriptedArchon {
  const answers = new Map<string, Scripted | ((call: ScriptedCall) => Scripted)>()
  const archon: ScriptedArchon = {
    calls: [],
    streams: [],
    snapshots: [],
    lastBody: { taken: 0, closed: false },
    answer(url, scripted) {
      answers.set(url, scripted)
    },
    fetch(url: string, init: FetchInit): Promise<FetchAnswer> {
      const call: ScriptedCall = { url, method: init.method, redirect: init.redirect, headers: init.headers }
      if (init.body !== undefined) call.body = init.body
      const { pathname, search } = new URL(url)
      const stream = pathname.startsWith('/api/stream/')
      if (stream) archon.streams.push(call)
      else if (SNAPSHOT_PATHS.has(`${pathname}${search}`)) archon.snapshots.push(call)
      else archon.calls.push(call)
      const found =
        answers.get(url) ??
        (pathname === OPENAPI_PATH ? floorPathListAnswer() : stream ? HANG : (snapshotAnswer(`${pathname}${search}`) ?? REFUSE))
      const scripted = typeof found === 'function' ? found(call) : found
      if (scripted.kind === 'refuse') {
        return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
      }
      if (scripted.kind === 'hang') {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      if (scripted.kind === 'stream') {
        const contentType = scripted.contentType
        return Promise.resolve({
          status: scripted.status,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
          body: scripted.body(init.signal)
        })
      }
      const body = { taken: 0, closed: false }
      archon.lastBody = body
      const chunks =
        scripted.kind === 'chunks'
          ? scripted.chunks
          : [encoder.encode(scripted.kind === 'json' ? JSON.stringify(scripted.value) : scripted.text)]
      const contentType = scripted.kind === 'text' ? scripted.contentType : (scripted.contentType ?? 'application/json')
      async function* read(): AsyncGenerator<Uint8Array> {
        try {
          for (const chunk of chunks) {
            body.taken += 1
            yield chunk
          }
        } finally {
          body.closed = true
        }
      }
      return Promise.resolve({
        status: scripted.kind === 'chunks' ? 200 : (scripted.status ?? 200),
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
        body: read()
      })
    }
  }
  return archon
}

export type ScriptedDisk = {
  /** The disk module's interface, answered from memory. */
  open(roots: readonly string[]): Disk
  /** The roots of every disk the worker opened, in order. */
  opened: string[][]
  /** Every path the worker asked about, in order. */
  asked: string[]
  folders: Set<string>
  files: Map<string, string>
  /** When each file was last written, by path. A file with none is as old as the clock's start. */
  modified: Map<string, number>
  /** Every write the worker made (`make`, `write` or `remove` and the path), in order, refused ones included. */
  writes: string[]
  /** Set to make every write fail, as a full or read-only disk would. */
  failWrites: boolean
  /** The time a write stamps; the scene sets it to its clock. */
  now(): number
}

/** The name of `path` when it sits directly in `folder`, with either slash, or null. */
function childName(folder: string, path: string): string | null {
  for (const slash of ['/', '\\']) {
    const prefix = folder.endsWith(slash) ? folder : `${folder}${slash}`
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length)
      return rest === '' || rest.includes('/') || rest.includes('\\') ? null : rest
    }
  }
  return null
}

/** An in-memory disk. A path outside the roots it was opened with is refused, as the real one does. */
export function scriptDisk(): ScriptedDisk {
  const disk: ScriptedDisk = {
    opened: [],
    asked: [],
    folders: new Set(),
    files: new Map(),
    modified: new Map(),
    writes: [],
    failWrites: false,
    now: () => CLOCK_START,
    open(roots) {
      disk.opened.push([...roots])
      const inside = (path: string): boolean =>
        roots.some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
      return {
        folderState(path): Promise<FolderState> {
          disk.asked.push(path)
          return Promise.resolve(!inside(path) ? 'refused' : disk.folders.has(path) ? 'exists' : 'missing')
        },
        readText(path): Promise<TextFile> {
          disk.asked.push(path)
          if (!inside(path)) return Promise.resolve({ kind: 'refused' })
          const text = disk.files.get(path)
          return Promise.resolve(text === undefined ? { kind: 'missing' } : { kind: 'text', text })
        },
        makeFolder(path): Promise<WriteOutcome> {
          disk.writes.push(`make ${path}`)
          if (!inside(path)) return Promise.resolve('refused')
          if (disk.failWrites || disk.files.has(path)) return Promise.resolve('failed')
          disk.folders.add(path)
          return Promise.resolve('ok')
        },
        writeText(path, text): Promise<WriteOutcome> {
          disk.writes.push(`write ${path}`)
          if (!inside(path)) return Promise.resolve('refused')
          const parent = [...disk.folders].some((folder) => childName(folder, path) !== null)
          if (disk.failWrites || !parent) return Promise.resolve('failed')
          disk.files.set(path, text)
          disk.modified.set(path, disk.now())
          return Promise.resolve('ok')
        },
        listFolder(path): Promise<DiskEntry[] | null> {
          disk.asked.push(path)
          if (!inside(path) || !disk.folders.has(path)) return Promise.resolve(null)
          const entries: DiskEntry[] = []
          for (const file of disk.files.keys()) {
            const name = childName(path, file)
            if (name !== null) entries.push({ name, modifiedMs: disk.modified.get(file) ?? CLOCK_START, file: true })
          }
          for (const folder of disk.folders) {
            const name = childName(path, folder)
            if (name !== null) entries.push({ name, modifiedMs: CLOCK_START, file: false })
          }
          return Promise.resolve(entries)
        },
        remove(path): Promise<WriteOutcome> {
          disk.writes.push(`remove ${path}`)
          if (!inside(path)) return Promise.resolve('refused')
          if (disk.failWrites || !disk.files.has(path)) return Promise.resolve('failed')
          disk.files.delete(path)
          disk.modified.delete(path)
          return Promise.resolve('ok')
        }
      }
    }
  }
  return disk
}

/** The person's home folder in the tests, and the Archon home folder inside it. Neither exists. */
export const HOME_DIR = join(parse(process.cwd()).root, 'home', 'someone')
export const ARCHON_HOME = join(HOME_DIR, '.archon')
export const SERVER_RECORD = join(ARCHON_HOME, 'server.json')
/** The default address, and the two calls a pass makes there. */
export const DEFAULT = DEFAULT_BASE_URL
export const DEFAULT_HEALTH = `${DEFAULT}/api/health`
export const DEFAULT_OPENAPI = `${DEFAULT}${OPENAPI_PATH}`

export type Scene = {
  archon: ScriptedArchon
  clock: Clock
  disk: ScriptedDisk
  /** What the worker reads as `process.platform`. Windows unless the test sets another before mounting. */
  platform: string
  /** Mounts the worker on the scripted ports and lets its first discovery pass run. */
  mount(options?: MockHostOptions): Promise<MountedScene>
}

export type MountedScene = {
  worker: TestWorker
  host: MockHost
  /** The `orca` object the worker was given, to change a setting as the person would. */
  orca: OrcaWorkerApi
  /** Every connection state the worker posted, in order. */
  posted(): ConnectionView[]
  /** The newest state posted. Unlike `read`, it asks the worker nothing. */
  latest(): ConnectionView
  /** The connection state as a frame reads it, once what the request set off has run. */
  read(): Promise<ConnectionView>
  /** Every `statusBar.update` the worker sent, in order. */
  statusBar(): unknown[]
}

/** The kind of every connection state the worker posted, in order. */
export const kinds = (mounted: MountedScene): string[] => mounted.posted().map((state) => state.kind)

/** The address of every call made to the scripted Archon, in order. */
export const urls = (stage: Scene): string[] => stage.archon.calls.map((call) => call.url)

/**
 * A scripted Archon, clock and disk, and the worker mounted on them. Script what Archon answers
 * and what the disk holds first, then mount: discovery starts when the worker does.
 */
export function scene(): Scene {
  const archon = scriptArchon()
  const clock = createClock()
  const disk = scriptDisk()
  disk.now = clock.now
  const stage: Scene = {
    archon,
    clock,
    disk,
    platform: 'win32',
    async mount(options = {}) {
      const host = mockHost(options)
      let given: OrcaWorkerApi | undefined
      let stop: (() => void) | undefined
      const worker = await mountWorker(
        {
          default(orca: OrcaWorkerApi) {
            given = orca
            stop = start(orca, {
              fetch: archon.fetch,
              openDisk: disk.open,
              homeDir: HOME_DIR,
              platform: stage.platform,
              now: clock.now,
              timers: clock.timers
            })
          },
          deactivate: () => stop?.()
        },
        { host }
      )
      await settle()
      if (given === undefined) throw new Error('The worker was not activated.')
      const posted = (): ConnectionView[] =>
        worker.posts.filter((post) => post.event === 'connection.changed').map((post) => post.payload as ConnectionView)
      return {
        worker,
        host,
        orca: given,
        posted,
        latest() {
          const newest = posted().at(-1)
          if (newest === undefined) throw new Error('The worker has posted no connection state.')
          return newest
        },
        async read() {
          const { connection } = await worker.request('connection.read')
          await settle()
          return connection
        },
        statusBar: () => host.callsOf('statusBar.update')
      }
    }
  }
  return stage
}
