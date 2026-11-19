// The snapshot of runs that need you: the worker's own copy of the whole install's runs that only a
// person's action will move, and the count of running runs. It is built from two reads,
// `GET /api/runs/attention` (its `runs` and each row's `attention`, never `items`) and
// `GET /api/dashboard/runs?limit=1` (the `running` count), and it answers the status bar item,
// the "runs need you" callout, the "Needs you" filter and notifications, so those cannot disagree.
import type { Client, Timers } from './client'
import type { Connected } from './connection-view'
import { cutAt } from './cutter'
import { DASHBOARD_RUNS_PATH, parseDashboardRunsPage, parseRun } from './dashboard-runs'
import type { RunsHint, ShowRuns } from './hint-view'
import type { Notice } from './notifications'
import { isRecord, own, ownRecord } from './records'
import { CALLOUT_CAP, ROWS_CAP, type NeedsYouView, type RunRow, type Waiting } from './runs-view'
import type { SnapshotCounts } from './status-bar'

export const ATTENTION_PATH = '/api/runs/attention'
/** The running count: one row is the least Archon sends, and the counts come with any page. */
export const RUNNING_PATH = `${DASHBOARD_RUNS_PATH}?limit=1`

/** On a `workflow_status` hint the snapshot is read at most this often. */
export const SNAPSHOT_GAP_MS = 2_000
/** The safety read, whether or not a panel is open. */
export const SNAPSHOT_SAFETY_MS = 30_000
/** What the "Needs you" filter says when the waiting runs could not be read. */
export const NEEDS_YOU_UNAVAILABLE = 'Orchon could not read the runs that need you from Archon.'
/** How long a press of "Orchon: Show runs" is remembered for a panel that mounts after it. */
export const SHOW_RUNS_MEMORY_MS = 60_000
/** How much of a question the snapshot keeps: one line of a callout row or a preview. */
export const QUESTION_CAP = 200

/**
 * One run that needs you, with the Archon project it belongs to for the panel's scope switch, and
 * what tells this question from the next for notifications: null when Archon's row does not say.
 */
type Entry = { row: RunRow & { waiting: Waiting }; codebaseId: string | null; identity: string | null }

/** Text on one line: every run of white space, line breaks included, becomes one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** What a row's `attention` says: the run needs you and why, it does not, or the field cannot be read. */
type Attention = { kind: 'needs-you'; waiting: Waiting; identity: string | null } | { kind: 'not-needed' } | { kind: 'unread' }

/** A text field, or null when it is missing, empty or not text. */
function textOf(record: Record<string, unknown>, key: string): string | null {
  const value = own(record, key)
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * What tells one question from the next, held in memory for notifications only: a gate by its run,
 * node and pause id, an attention wait by its run and `occurrence`, an unreadable run by its run
 * and `reason`. A gate's pause id is the run's `metadata.approval.pauseId`, or the row's
 * `occurrence` when that is missing. Null when the parts that name the question are missing.
 */
function identityOf(run: Record<string, unknown>, attention: Record<string, unknown>, kind: string): string | null {
  const runId = textOf(run, 'id')
  if (runId === null) return null
  if (kind === 'unreadable') return JSON.stringify(['unreadable', runId, textOf(attention, 'reason') ?? ''])
  const occurrence = textOf(attention, 'occurrence')
  if (kind === 'attention') return occurrence === null ? null : JSON.stringify(['wait', runId, occurrence])
  const approval = ownRecord(ownRecord(run, 'metadata'), 'approval')
  const nodeId = textOf(ownRecord(attention, 'respondTo'), 'nodeId') ?? textOf(approval, 'nodeId')
  const pauseId = textOf(approval, 'pauseId') ?? occurrence
  return nodeId === null || pauseId === null ? null : JSON.stringify(['gate', runId, nodeId, pauseId])
}

const NOT_NEEDED: Attention = { kind: 'not-needed' }
const UNREAD: Attention = { kind: 'unread' }

/**
 * What a row's `attention` says the person must do. A gate (`awaiting_response`), an attention
 * wait (`attention`, legacy waits included) and an unreadable run need you; a usage-limit pause, a
 * parent waiting on sub-runs, stalled tool calls and any other kind do not. A question with no
 * message text cannot be shown, so the field cannot be read.
 */
function parseAttention(run: Record<string, unknown>): Attention {
  const attention = own(run, 'attention')
  if (!isRecord(attention)) return attention === null || attention === undefined ? NOT_NEEDED : UNREAD
  const kind = own(attention, 'kind')
  if (kind === 'unreadable') return { kind: 'needs-you', waiting: { kind: 'unreadable' }, identity: identityOf(run, attention, kind) }
  if (kind !== 'awaiting_response' && kind !== 'attention') return typeof kind === 'string' ? NOT_NEEDED : UNREAD
  const message = own(attention, 'message')
  if (typeof message !== 'string') return UNREAD
  const question = cutAt(oneLine(message), QUESTION_CAP)
  return { kind: 'needs-you', waiting: { kind: kind === 'attention' ? 'wait' : 'gate', question }, identity: identityOf(run, attention, kind) }
}

/**
 * The Archon project of a row Archon queued for attention that cannot be read: its id, null for
 * none, or undefined when the project cannot be read either, so the row counts in every scope.
 */
type Unread = string | null | undefined

/** The Archon project a row of the attention answer names: none is null, one that cannot be read undefined. */
function projectOf(run: unknown): Unread {
  if (!isRecord(run)) return undefined
  const id = own(run, 'codebase_id')
  if (id === undefined || id === null) return null
  return typeof id === 'string' ? id : undefined
}

/**
 * The runs that need you in Archon's answer, in the order it gave them, or null when the answer
 * as a whole cannot be read. A row that cannot be read is left out, and its project kept in
 * `unread` so the callout and the "Needs you" filter can say it is not shown.
 */
export function parseAttentionRuns(value: unknown): { entries: Entry[]; unread: Unread[] } | null {
  if (!isRecord(value)) return null
  const runs = own(value, 'runs')
  if (!Array.isArray(runs)) return null
  const entries: Entry[] = []
  const unread: Unread[] = []
  for (const run of runs as unknown[]) {
    const row = parseRun(run)
    const attention = isRecord(run) ? parseAttention(run) : UNREAD
    const codebaseId = projectOf(run)
    if (row === null || attention.kind === 'unread' || codebaseId === undefined) unread.push(codebaseId)
    else if (attention.kind === 'needs-you') entries.push({ row: { ...row, waiting: attention.waiting }, codebaseId, identity: attention.identity })
  }
  return { entries, unread }
}

/** The runs that need you as notifications name them; a run whose question has no identity is left out. */
function noticesOf(entries: readonly Entry[]): Notice[] {
  const notices: Notice[] = []
  for (const { row, identity } of entries) {
    if (identity !== null) notices.push({ identity, kind: row.waiting.kind, workflow: row.workflow, project: row.project })
  }
  return notices
}

/** The snapshot. `running` is null when only the running count could not be read. */
type Held = { kind: 'counted'; entries: Entry[]; unread: Unread[]; running: number | null } | { kind: 'unavailable' }

export type NeedsYouPorts = {
  client: Client
  now(): number
  timers: Timers
  /** The snapshot now says something else. */
  changed(): void
  /** A read that could be counted, on this store: the runs that need you as notifications name them. */
  counted?(storeId: string | null, notices: Notice[]): void
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
  counts(): SnapshotCounts | undefined
  /** The runs that need you in one Archon project, or the whole install when none is named. */
  view(codebaseId?: string): NeedsYouView
  /**
   * The "Needs you" filter's list in the scope: rows 0 to N in Archon's order, how many need you
   * and how many waiting runs could not be read. Null while the snapshot is unavailable or unread.
   */
  list(count: number, codebaseId?: string): { total: number; rows: RunRow[]; unreadable: number } | null
  /** The rows with what each run that needs you waits for, so a preview can show its question. */
  annotate(rows: readonly RunRow[]): RunRow[]
  /** Waits for a read in flight, so a frame's first answer after connecting has the snapshot. */
  settled(): Promise<void>
  /** Remembers a press of "Orchon: Show runs" and returns it. */
  press(): ShowRuns
  /** The last press, while it is remembered. */
  pressed(): ShowRuns | undefined
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
  let lastPress: ShowRuns | undefined
  let current: Promise<void> = Promise.resolve()

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
    // Only the waiting runs make the snapshot unavailable; a failed running count is said apart.
    if (parsed === null) return { kind: 'unavailable' }
    return { kind: 'counted', entries: parsed.entries, unread: parsed.unread, running: page === null ? null : page.counts.running }
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
    current = readOnce(target, controller.signal)
      .then((next) => {
        if (mine !== generation) return
        keep(next)
        if (next.kind === 'counted') ports.counted?.(target.storeId, noticesOf(next.entries))
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

  /** How many waiting runs in the scope could not be read; one whose project is unknown counts in every scope. */
  function unreadIn(codebaseId: string | undefined): number {
    if (held?.kind !== 'counted') return 0
    return codebaseId === undefined ? held.unread.length : held.unread.filter((id) => id === undefined || id === codebaseId).length
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
      return held.kind === 'unavailable'
        ? held
        : { kind: 'counted', needsYou: held.entries.length, running: held.running, unread: held.unread.length }
    },
    view(codebaseId) {
      const entries = scoped(codebaseId)
      if (entries === null) return { kind: 'unavailable' }
      return {
        kind: 'ready',
        total: entries.length,
        rows: entries.slice(0, CALLOUT_CAP).map((entry) => entry.row),
        unreadable: unreadIn(codebaseId)
      }
    },
    list(count, codebaseId) {
      const entries = scoped(codebaseId)
      if (entries === null) return null
      const rows = entries.slice(0, Math.min(count, ROWS_CAP)).map((entry) => entry.row)
      return { total: entries.length, rows, unreadable: unreadIn(codebaseId) }
    },
    annotate(rows) {
      if (held?.kind !== 'counted' || held.entries.length === 0) return [...rows]
      const byId = new Map(held.entries.map((entry) => [entry.row.id, entry.row.waiting]))
      return rows.map((row) => {
        const waiting = byId.get(row.id)
        return waiting === undefined ? row : { ...row, waiting }
      })
    },
    settled() {
      return current
    },
    press() {
      lastPress = { at: ports.now(), needsYou: held?.kind === 'counted' && held.entries.length > 0 }
      return lastPress
    },
    pressed() {
      return lastPress !== undefined && ports.now() < lastPress.at + SHOW_RUNS_MEMORY_MS ? lastPress : undefined
    },
    stop() {
      halt()
      server = null
    }
  }
}
