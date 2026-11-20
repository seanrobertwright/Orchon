// The Overview of the Metrics section as a frame gets it: the cards workflow packs declare,
// finished in the worker by the rules of Archon's console, so the panel only draws words and
// numbers. It is types and constants only, read by the panel and the worker alike.
import type { MetricsWindow } from './metrics-view'

/** How many packs Overview shows at most, in Archon's order. */
export const OVERVIEW_PACKS_CAP = 10

/** How many cards of one pack Overview shows at most: the most one pack file may declare. */
export const PACK_CARDS_CAP = 6

/** The figure a card shows when the records do not support one, as the console writes it. */
export const NO_FIGURE = '—'

export type OverviewCard =
  /** The declarations answered and the window's report has not: the title over a skeleton. */
  | { id: string; title: string; kind: 'pending'; metric: string }
  | {
      id: string
      title: string
      kind: 'figure'
      shape: 'count' | 'ratio' | 'cost_per'
      /** The metric the card's "Details" link opens Details at. */
      metric: string
      /** The main figure, such as "12", "25%", "≥ $1.42" or "—". */
      figure: string
      /** A ratio's share as a whole percent from 0 to 100, for its bar; left out when there is no bar. */
      percent?: number
      /** The muted line under the figure, or null when the card has none. */
      line: string | null
    }
  /** A card of a shape this version of Orchon does not know: its title alone, and no Details link. */
  | { id: string; title: string; kind: 'unknown-shape' }

export type OverviewPack = {
  /** Unique among the packs: the pack's source and name. */
  key: string
  /** The pack's name, Archon's own. */
  name: string
  /** At most `PACK_CARDS_CAP`, in the pack's order. */
  cards: OverviewCard[]
  /** How many of the pack's cards past the cap are not shown. */
  more: number
}

export type OverviewView = {
  /** The packs that declare cards, at most `OVERVIEW_PACKS_CAP`, in Archon's order. */
  packs: OverviewPack[]
  /** How many packs that declare cards are past the cap. */
  morePacks: number
}

/**
 * The worker's post once the card declarations answer and before the window's report does, so
 * a panel can show the card titles over skeletons. It names the scope and window it is for.
 */
export type MetricsCardsPost = { codebaseId?: string; window: MetricsWindow; overview: OverviewView }
