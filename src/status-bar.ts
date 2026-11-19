// The status bar item: what it reads in each connection state, and a sender that calls Orca
// only when something differs and never more than once a second. Orca puts no limit on
// `statusBar.update`, so the worker limits itself.
import type { Timers } from './client'
import type { ConnectionView } from './connection-view'
import { statusSentence } from './connection-words'

/** The manifest id of the item. */
export const STATUS_ITEM_ID = 'status'

/** The least time between two updates. */
export const STATUS_GAP_MS = 1_000

export type StatusItem = {
  text: string
  icon: 'bot' | 'warning'
  tone: 'neutral' | 'warning'
  /** One full sentence. */
  tooltip: string
}

const TEXT: Record<ConnectionView['kind'], string> = {
  connected: 'Archon',
  searching: 'Archon…',
  'not-found': 'Archon off',
  'bad-setting': 'Archon setup',
  unsupported: 'Archon setup'
}

/**
 * What the item shows for a connection state. A stopped Archon is ordinary, so it is neutral; a
 * refused setting and an unsupported server need the person, so they warn.
 */
export function statusItem(view: ConnectionView): StatusItem {
  const warns = view.kind === 'bad-setting' || view.kind === 'unsupported'
  return {
    text: TEXT[view.kind],
    icon: warns ? 'warning' : 'bot',
    tone: warns ? 'warning' : 'neutral',
    tooltip: statusSentence(view)
  }
}

function same(first: StatusItem, second: StatusItem): boolean {
  return (
    first.text === second.text &&
    first.icon === second.icon &&
    first.tone === second.tone &&
    first.tooltip === second.tooltip
  )
}

export type StatusBar = {
  /** Asks for the item to read this. The newest ask wins when several fall inside the gap. */
  show(item: StatusItem): void
  stop(): void
}

export function createStatusBar(ports: { update(item: StatusItem): void; now(): number; timers: Timers }): StatusBar {
  let wanted: StatusItem | undefined
  let sent: StatusItem | undefined
  let sentAt: number | undefined
  let timer: unknown

  function send(): void {
    timer = undefined
    if (wanted === undefined || (sent !== undefined && same(sent, wanted))) return
    sent = wanted
    sentAt = ports.now()
    ports.update(wanted)
  }

  return {
    show(item) {
      wanted = item
      if (timer !== undefined) return
      const wait = sentAt === undefined ? 0 : sentAt + STATUS_GAP_MS - ports.now()
      if (wait <= 0) send()
      else timer = ports.timers.set(send, wait)
    },
    stop() {
      if (timer !== undefined) ports.timers.clear(timer)
      timer = undefined
      wanted = undefined
    }
  }
}
