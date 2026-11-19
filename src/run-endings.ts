// Run endings for notifications: while "Runs that need you and runs that end" is chosen, the
// worker reads the one run a `workflow_status` frame names to learn whether it ended, and how.
// With any other value it makes no such call. Reads go one at a time, a run waiting at most once.
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected } from './connection-view'
import { identities, isEnded, type Notice } from './notifications'
import { readRun } from './run-detail'

/** How many runs may wait to be read; the frames of more are dropped and said in the log. */
export const ENDINGS_QUEUE_CAP = 50
/** How long a read of the project names is used before it is made again. */
export const PROJECT_NAMES_MS = 30_000

export type RunEndingsPorts = {
  client: Client
  now(): number
  /** Whether runs that end are opted in now. */
  optedIn(): boolean
  /** A run that ended, on this store. */
  ended(storeId: string | null, notice: Notice): void
  log(message: string): void
}

export type RunEndings = {
  /** Connected to this server: frames from now on are read against it. */
  connected(server: Connected): void
  /** No longer Connected: stops reading and forgets what waited. */
  disconnected(): void
  /** A `workflow_status` frame named this run. */
  status(runId: string): void
  stop(): void
}

export function createRunEndings(ports: RunEndingsPorts): RunEndings {
  let server: Connected | null = null
  let controller = new AbortController()
  const waiting = new Set<string>()
  let reading = false
  let names: { at: number; byId: Map<string, string> } | undefined
  /** Whether the log has said the queue is full since it last had room. */
  let toldFull = false

  async function projectName(target: Connected, codebaseId: string | null, signal: AbortSignal): Promise<string | null> {
    if (codebaseId === null) return null
    if (names === undefined || ports.now() - names.at >= PROJECT_NAMES_MS) {
      const answer = await ports.client.request({ baseUrl: target.baseUrl, path: CODEBASES_PATH, timeout: 'read', signal })
      const list = answer.ok ? parseCodebases(answer.value) : null
      if (list !== null) names = { at: ports.now(), byId: new Map(list.projects.map((project) => [project.id, project.name])) }
    }
    return names?.byId.get(codebaseId) ?? null
  }

  async function readOne(target: Connected, runId: string, signal: AbortSignal): Promise<void> {
    const read = await readRun(ports.client, target, runId, signal)
    if (read.kind !== 'run' || !isEnded(read.run.status) || signal.aborted) return
    const { status, workflow, codebaseId } = read.run
    const project = await projectName(target, codebaseId, signal)
    if (signal.aborted) return
    ports.ended(target.storeId, { identity: identities.ended(runId, status), kind: status, workflow, project })
  }

  /** Reads what waits, one run at a time, while Connected and opted in. */
  function drain(): void {
    if (reading) return
    const target = server
    const [next] = waiting
    if (target === null || next === undefined) return
    waiting.delete(next)
    reading = true
    const { signal } = controller
    readOne(target, next, signal)
      .catch((error: unknown) => {
        ports.log(`Orchon could not read whether a run ended: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (signal !== controller.signal) return
        reading = false
        drain()
      })
  }

  function halt(): void {
    controller.abort()
    controller = new AbortController()
    reading = false
    waiting.clear()
  }

  return {
    connected(next) {
      halt()
      server = next
    },
    disconnected() {
      halt()
      server = null
    },
    status(runId) {
      if (server === null || !ports.optedIn()) return
      if (!waiting.has(runId) && waiting.size >= ENDINGS_QUEUE_CAP) {
        if (!toldFull) ports.log(`Orchon has ${String(ENDINGS_QUEUE_CAP)} runs waiting to be read and does not check whether more of them ended.`)
        toldFull = true
        return
      }
      toldFull = false
      waiting.add(runId)
      drain()
    },
    stop() {
      halt()
      server = null
    }
  }
}
