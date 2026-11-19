// The status bar item: what it reads in each connection state, and a sender that calls Orca
// only when something differs and never more than once a second. Orca puts no limit on
// `statusBar.update`, so the worker limits itself.
import type { Timers } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { statusSentence } from './connection-words'

/** The manifest id of the item. */
export const STATUS_ITEM_ID = 'status'

/** The least time between two updates. */
export const STATUS_GAP_MS = 1_000

export type StatusItem = {
  text: string
  icon: 'bot' | 'bell' | 'warning'
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
 * What the snapshot of runs that need you says to the item: the two counts, or that the waiting
 * runs could not be read. Before the first read there is none, and the item reads as for no runs.
 */
export type StatusCounts = { kind: 'counted'; needsYou: number; running: number } | { kind: 'unavailable' }

/** The most a figure shows before it reads "99+". */
export const FIGURE_CAP = 99

const figure = (count: number): string => (count > FIGURE_CAP ? `${String(FIGURE_CAP)}+` : String(count))

/** Where the counts were taken, in the words of the Connected sentence. */
const archonAt = (view: Connected): string =>
  view.version === null ? `Archon at ${view.baseUrl}` : `Archon ${view.version} at ${view.baseUrl}`

const runs = (count: number): string => (count === 1 ? '1 run' : `${String(count)} runs`)

/** The one full sentence of the tooltip while Connected. */
function connectedSentence(view: Connected, counts: StatusCounts | undefined): string {
  if (counts === undefined) return statusSentence(view)
  if (counts.kind === 'unavailable') return `The count of runs that need you is unavailable from ${archonAt(view)}.`
  const { needsYou, running } = counts
  if (needsYou > 0) {
    const need = `${runs(needsYou)} ${needsYou === 1 ? 'needs' : 'need'} you`
    const also = running === 0 ? '' : ` and ${String(running)} ${running === 1 ? 'is' : 'are'} running`
    return `${need}${also} on ${archonAt(view)}.`
  }
  if (running > 0) return `${runs(running)} ${running === 1 ? 'is' : 'are'} running on ${archonAt(view)}.`
  return statusSentence(view)
}

/**
 * What the item shows for a connection state and, while Connected, the snapshot's counts. A
 * stopped Archon is ordinary, so it is neutral; a refused setting and an unsupported server need
 * the person, so they warn. One figure at a time: runs that need you take the text, with the bell
 * and the warning tone, and the running count moves to the tooltip. The text always carries the
 * meaning; the icon and the tone only repeat it.
 */
export function statusItem(view: ConnectionView, counts?: StatusCounts): StatusItem {
  if (view.kind === 'connected') {
    const tooltip = connectedSentence(view, counts)
    if (counts?.kind === 'counted' && counts.needsYou > 0) {
      const text = `${figure(counts.needsYou)} ${counts.needsYou === 1 ? 'needs' : 'need'} you`
      return { text, icon: 'bell', tone: 'warning', tooltip }
    }
    const text = counts?.kind === 'counted' && counts.running > 0 ? `${figure(counts.running)} running` : TEXT.connected
    return { text, icon: 'bot', tone: 'neutral', tooltip }
  }
  const warns = view.kind === 'bad-setting' || view.kind === 'unsupported'
  return {
    text: TEXT[view.kind],
    icon: warns ? 'warning' : 'bot',
    tone: warns ? 'warning' : 'neutral',
    tooltip: statusSentence(view)
  }
}

/** Where the person goes after a press, since the worker cannot show the panel itself. */
export const WHERE_TO_GO = 'Open the Orchon panel in the right sidebar.'

/**
 * What the "Orchon: Show runs" command returns: while Connected, the status sentence and where to
 * go; in any other state, that state's sentence.
 */
export function showRunsSentence(view: ConnectionView, counts?: StatusCounts): string {
  return view.kind === 'connected' ? `${connectedSentence(view, counts)} ${WHERE_TO_GO}` : statusSentence(view)
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
