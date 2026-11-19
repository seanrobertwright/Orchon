// Desktop notifications: once per identity, folded into batches, under the one Notifications
// setting. The runs that need you come from the snapshot (`needs-you.ts`); this file never reads
// the attention queue itself. A notification holds the workflow name, a state phrase and the
// project name, and nothing else: never a question, an option label, run output, Archon's error
// text, a path or a run id, because Orca also relays it to paired phones.
import type { Timers } from './client'
import { cutAt } from './cutter'

/** The setting's key in the manifest, and its three values. */
export const NOTIFICATIONS_KEY = 'notifications'
export const NOTIFICATION_LEVELS = ['off', 'needs-you', 'needs-you-and-ended'] as const
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]
export const DEFAULT_LEVEL: NotificationLevel = 'needs-you'

/** How long new events are collected before a batch goes out. */
export const COLLECT_MS = 5_000
/** The least time between two batches. */
export const BATCH_GAP_MS = 10_000
/** A batch of more events than this becomes one notification with the count. */
export const SINGLES_CAP = 3
/** How many identities the seen record holds before it drops the oldest. */
export const SEEN_CAP = 1_000
/** The title is the workflow name cut to this. */
export const TITLE_CAP = 80
/** The project name in a body is cut to this. */
export const PROJECT_CAP = 80

/** The setting as read: one of its values, and whether the stored value was one of them. */
export type NotificationSetting = { level: NotificationLevel; recognised: boolean }

/** The setting's stored value. Missing is the default; any other value is not recognised and reads as the default. */
export function parseNotificationSetting(value: unknown): NotificationSetting {
  if (value === undefined || value === null) return { level: DEFAULT_LEVEL, recognised: true }
  const level = NOTIFICATION_LEVELS.find((known) => known === value)
  return level === undefined ? { level: DEFAULT_LEVEL, recognised: false } : { level, recognised: true }
}

/** Why a run needs you, as a notification says it. */
export type NoticeKind = 'gate' | 'wait' | 'unreadable'
/** How a run ended, as a notification says it. */
export type EndedStatus = 'completed' | 'failed' | 'cancelled'

/**
 * One notifiable event: what tells it from the next (`identity`), the workflow name and the
 * project name. The identity is held in memory only and never shown.
 */
export type Notice = {
  identity: string
  kind: NoticeKind | EndedStatus
  workflow: string
  project: string | null
}

const PHRASES: Record<Notice['kind'], string> = {
  gate: 'Waiting for your decision',
  wait: 'Waiting for your answer',
  unreadable: "Needs a look in Archon's console",
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const isEnding = (kind: Notice['kind']): kind is EndedStatus => kind === 'completed' || kind === 'failed' || kind === 'cancelled'

/** A project name that looks like a folder path is left out, so no path reaches a notification. */
function looksLikePath(name: string): boolean {
  return /[\\/]{2}|\\|^[/~]|^[A-Za-z]:/.test(name)
}

/** The title and body of one event's notification. */
export function noticeText(notice: Notice): { title: string; body: string } {
  const project = notice.project === null || looksLikePath(notice.project) ? '' : cutAt(notice.project.replace(/\s+/g, ' ').trim(), PROJECT_CAP)
  const phrase = PHRASES[notice.kind]
  return { title: cutAt(notice.workflow, TITLE_CAP), body: project === '' ? phrase : `${phrase} · ${project}` }
}

const runs = (count: number): string => (count === 1 ? '1 run' : `${String(count)} runs`)

/** The title of a folded batch: the count of each kind of event, with no body. */
export function foldedTitle(notices: readonly Notice[]): string {
  const ended = notices.filter((notice) => isEnding(notice.kind)).length
  const waiting = notices.length - ended
  const parts: string[] = []
  if (waiting > 0) parts.push(`${runs(waiting)} ${waiting === 1 ? 'needs' : 'need'} you`)
  if (ended > 0) parts.push(`${runs(ended)} ended`)
  return parts.join(', ')
}

/**
 * The identities already met, at most `cap`, the one met longest ago dropped first. Meeting an
 * identity again makes it the newest, so a question still waiting is not dropped by newer ones.
 */
export function createSeenRecord(cap = SEEN_CAP) {
  const seen = new Set<string>()
  return {
    /** Records the identity and says whether it was new. */
    meet(identity: string): boolean {
      const known = seen.delete(identity)
      seen.add(identity)
      if (seen.size > cap) {
        const oldest = seen.values().next()
        if (oldest.done !== true) seen.delete(oldest.value)
      }
      return !known
    },
    clear(): void {
      seen.clear()
    }
  }
}

export type NotificationsPorts = {
  now(): number
  timers: Timers
  /** The setting now. */
  level(): NotificationLevel
  /** Sends one notification to Orca. */
  show(notification: { title: string; body?: string }): void
}

export type Notifications = {
  /**
   * A read of the snapshot that could be counted: the runs that need you now, on this store. The
   * first one after the worker started, and the first after the store id changed, fills the seen
   * record and notifies nothing.
   */
  waiting(storeId: string | null, notices: readonly Notice[]): void
  /**
   * A run ended, on this store. Before the first read of the snapshot, or on a store it has not
   * read yet, the ending is only recorded.
   */
  ended(storeId: string | null, notice: Notice): void
  /** Clears every timer; nothing is sent after. */
  stop(): void
}

export function createNotifications(ports: NotificationsPorts): Notifications {
  const seen = createSeenRecord()
  /** The store the seen record was filled from; undefined before the first read. */
  let store: { id: string | null } | undefined
  let queue: Notice[] = []
  let timer: unknown
  let lastBatch: number | undefined

  function send(): void {
    timer = undefined
    const level = ports.level()
    const batch = queue.filter((notice) => level === 'needs-you-and-ended' || (level === 'needs-you' && !isEnding(notice.kind)))
    queue = []
    if (batch.length === 0) return
    lastBatch = ports.now()
    if (batch.length > SINGLES_CAP) ports.show({ title: foldedTitle(batch) })
    else for (const notice of batch) ports.show(noticeText(notice))
  }

  /** The batch goes out when collection ends, or once the gap since the last batch has passed. */
  function schedule(): void {
    if (timer !== undefined) return
    const end = ports.now() + COLLECT_MS
    const at = lastBatch === undefined ? end : Math.max(end, lastBatch + BATCH_GAP_MS)
    timer = ports.timers.set(send, at - ports.now())
  }

  function add(notice: Notice): void {
    if (!seen.meet(notice.identity)) return
    if (ports.level() === 'off') return
    queue.push(notice)
    schedule()
  }

  return {
    waiting(storeId, notices) {
      if (store === undefined || store.id !== storeId) {
        if (store !== undefined) {
          // Another store: its runs are other runs, and what was collected for the last one is dropped.
          seen.clear()
          queue = []
        }
        store = { id: storeId }
        for (const notice of notices) seen.meet(notice.identity)
        return
      }
      for (const notice of notices) add(notice)
    },
    ended(storeId, notice) {
      if (store === undefined || store.id !== storeId) seen.meet(notice.identity)
      else add(notice)
    },
    stop() {
      if (timer !== undefined) ports.timers.clear(timer)
      timer = undefined
      queue = []
    }
  }
}
