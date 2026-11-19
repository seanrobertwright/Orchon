// The snapshot of runs that need you: the worker's own copy of the whole install's runs that only a
// person's action will move, and the count of running runs. It is built from two reads,
// `GET /api/runs/attention` (its `runs` and each row's `attention`, never `items`) and
// `GET /api/dashboard/runs?limit=1` (the `running` count), and it answers the status bar item,
// the "runs need you" callout and the "Needs you" filter, so those cannot disagree.
import type { Client, Timers } from './client'
import type { Connected } from './connection-view'
import { cutAt } from './cutter'
import { DASHBOARD_RUNS_PATH, parseDashboardRunsPage, parseRun } from './dashboard-runs'
import type { RunsHint } from './hint-view'
import { isRecord, own } from './records'
import { CALLOUT_CAP, ROWS_CAP, type NeedsYouView, type RunRow, type Waiting } from './runs-view'
import type { StatusCounts } from './status-bar'

export const ATTENTION_PATH = '/api/runs/attention'
/** The running count: one row is the least Archon sends, and the counts come with any page. */
export const RUNNING_PATH = `${DASHBOARD_RUNS_PATH}?limit=1`

/** On a `workflow_status` hint the snapshot is read at most this often. */
export const SNAPSHOT_GAP_MS = 2_000
/** The safety read, whether or not a panel is open. */
export const SNAPSHOT_SAFETY_MS = 30_000
/** How much of a question the snapshot keeps: one line of a callout row or a preview. */
export const QUESTION_CAP = 200

/** One run that needs you, with the Archon project it belongs to for the panel's scope switch. */
type Entry = { row: RunRow & { waiting: Waiting }; codebaseId: string | null }

/** Text on one line: every run of white space, line breaks included, becomes one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * What a row's `attention` says the person must do, or null when it does not need you. A gate
 * (`awaiting_response`), an attention wait (`attention`, legacy waits included) and an unreadable
 * run count; a usage-limit pause, a parent waiting on sub-runs, stalled tool calls and anything
 * else do not. A question with no message text cannot be shown, so it fails the row.
 */
function parseWaiting(attention: unknown): Waiting | null | false {
  if (!isRecord(attention)) return attention === null || attention === undefined ? null : false
  const kind = own(attention, 'kind')
  if (kind === 'unreadable') return { kind: 'unreadable' }
  if (kind !== 'awaiting_response' && kind !== 'attention') return typeof kind === 'string' ? null : false
  const message = own(attention, 'message')
  if (typeof message !== 'string') return false
  return { kind: kind === 'attention' ? 'wait' : 'gate', question: cutAt(oneLine(message), QUESTION_CAP) }
}

/**
 * The runs that need you in Archon's answer, in the order it gave them, or null when the answer
 * as a whole cannot be read. A row that cannot be read is left out and counted.
 */
export function parseAttentionRuns(value: unknown): { entries: Entry[]; unread: number } | null {
  if (!isRecord(value)) return null
  const runs = own(value, 'runs')
  if (!Array.isArray(runs)) return null
  const entries: Entry[] = []
  let unread = 0
  for (const run of runs as unknown[]) {
    const row = parseRun(run)
    const waiting = isRecord(run) ? parseWaiting(own(run, 'attention')) : false
    const codebaseId = isRecord(run) ? own(run, 'codebase_id') : undefined
    if (row === null || waiting === false || (codebaseId !== undefined && codebaseId !== null && typeof codebaseId !== 'string')) {
      unread += 1
      continue
    }
    if (waiting !== null) entries.push({ row: { ...row, waiting }, codebaseId: typeof codebaseId === 'string' ? codebaseId : null })
  }
  return { entries, unread }
}

type Held = { kind: 'counted'; entries: Entry[]; running: number } | { kind: 'unavailable' }

export type NeedsYouPorts = {
  client: Client
  now(): number
  timers: Timers
  /** The snapshot now says something else. */
  changed(): void
  log(message: string): void
}

export type NeedsYou = {
  /** Connected to this server: reads at once, then on the safety timer. A new store starts over. */
  connected(server: Connected): void
  /** No longer Connected: stops reading and forgets the snapshot. */
  disconnected(): void
  /** A hint from the dashboard stream: a `workflow_status` reads again, at most once every 2 seconds. */
  hint(hint: RunsHint): void
  /** The counts for the status bar item, or undefined before the first read. */
  counts(): StatusCounts | undefined
  /** The runs that need you in one Archon project, or the whole install when none is named. */
  view(codebaseId?: string): NeedsYouView
  /** Rows 0 to N of the runs that need you in the scope, in Archon's order. */
  rows(count: number, codebaseId?: string): RunRow[] | null
  /** What a run waits for from the person, when it needs you. */
  waiting(runId: string): Waiting | undefined
  stop(): void
}

export function createNeedsYou(ports: NeedsYouPorts): NeedsYou {
  let server: Connected | null = null
  let held: Held | undefined
  let generation = 0
  let controller = new AbortController()
  let inFlight = false
  let queued = false
  let lastStart: number | undefined
  let gapTimer: unknown
  let safetyTimer: unknown

  const clear = (timer: unknown): undefined => {
    if (timer !== undefined) ports.timers.clear(timer)
    return undefined
  }

  const key = (value: Held | undefined): string => JSON.stringify(value ?? null)

  function keep(next: Held): void {
    const before = key(held)
    held = next
    if (key(next) !== before) ports.changed()
  }

  async function readOnce(target: Connected, signal: AbortSignal): Promise<Held> {
    const call = (path: string) => ports.client.request({ baseUrl: target.baseUrl, path, timeout: 'read', signal })
    const [attention, running] = await Promise.all([call(ATTENTION_PATH), call(RUNNING_PATH)])
    const parsed = attention.ok ? parseAttentionRuns(attention.value) : null
    const page = running.ok ? parseDashboardRunsPage(running.value) : null
    if (parsed === null || page === null) return { kind: 'unavailable' }
    return { kind: 'counted', entries: parsed.entries, running: page.counts.running }
  }

  /** One read now. Another asked for while it is in flight waits for it, then for the gap. */
  function readNow(): void {
    const target = server
    if (target === null) return
    if (inFlight) {
      queued = true
      return
    }
    gapTimer = clear(gapTimer)
    safetyTimer = clear(safetyTimer)
    inFlight = true
    lastStart = ports.now()
    const mine = generation
    readOnce(target, controller.signal)
      .then((next) => {
        if (mine === generation) keep(next)
      })
      .catch((error: unknown) => {
        ports.log(`Orchon could not read the runs that need you: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (mine !== generation) return
        inFlight = false
        safetyTimer = ports.timers.set(() => {
          safetyTimer = undefined
          readNow()
        }, SNAPSHOT_SAFETY_MS)
        if (queued) {
          queued = false
          readSoon()
        }
      })
  }

  /** A read once the gap since the last one has passed. */
  function readSoon(): void {
    if (server === null || gapTimer !== undefined) return
    if (inFlight) {
      queued = true
      return
    }
    const wait = lastStart === undefined ? 0 : lastStart + SNAPSHOT_GAP_MS - ports.now()
    if (wait <= 0) readNow()
    else
      gapTimer = ports.timers.set(() => {
        gapTimer = undefined
        readNow()
      }, wait)
  }

  function halt(): void {
    generation += 1
    controller.abort()
    controller = new AbortController()
    inFlight = false
    queued = false
    gapTimer = clear(gapTimer)
    safetyTimer = clear(safetyTimer)
  }

  function scoped(codebaseId: string | undefined): Entry[] | null {
    if (held?.kind !== 'counted') return null
    return codebaseId === undefined ? held.entries : held.entries.filter((entry) => entry.codebaseId === codebaseId)
  }

  return {
    connected(next) {
      if (server !== null && server.storeId !== next.storeId) held = undefined
      server = next
      halt()
      readNow()
    },
    disconnected() {
      halt()
      server = null
      if (held !== undefined) {
        held = undefined
        ports.changed()
      }
    },
    hint(hint) {
      if (hint.types.includes('workflow_status')) readSoon()
    },
    counts() {
      if (held === undefined) return undefined
      return held.kind === 'unavailable' ? held : { kind: 'counted', needsYou: held.entries.length, running: held.running }
    },
    view(codebaseId) {
      const entries = scoped(codebaseId)
      if (entries === null) return { kind: 'unavailable' }
      return { kind: 'ready', total: entries.length, rows: entries.slice(0, CALLOUT_CAP).map((entry) => entry.row) }
    },
    rows(count, codebaseId) {
      const entries = scoped(codebaseId)
      return entries === null ? null : entries.slice(0, Math.min(count, ROWS_CAP)).map((entry) => entry.row)
    },
    waiting(runId) {
      return held?.kind === 'counted' ? held.entries.find((entry) => entry.row.id === runId)?.row.waiting : undefined
    },
    stop() {
      halt()
      server = null
    }
  }
}
