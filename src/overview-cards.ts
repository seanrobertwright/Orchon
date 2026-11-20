// The Overview cards, worked in the worker: the card declarations of `GET /api/metric-views`,
// validated by hand, the counts the cards read of the window's report as `parseReport` in
// `metrics.ts` validated it, and the finished `OverviewView` the panel draws.
//
// The declarations' shape is `metricViewSchema` and `metricViewsListingSchema` in
// `packages/workflows/src/schemas/metric-view.ts`; the rules are `countCard`, `ratioCard` and
// `costPerCard`, and the words are those of `MetricsOverview.tsx`, in the console's metrics
// folder of Archon 0.14.0 (commit 8def159a6b2c23e832a5283b4131cfffd9af9344). Every figure on a
// card comes from records of one judge version: the headline's of the metric the card is about.
// A calibration on a ratio card is read by a later version, and so are the refusals and the
// packs whose declarations could not be read.
import { cutAt } from './cutter'
import { formatNumber, formatShare, isMetricName, METRICS_TEXT_CAP, need, readable, sameIdentity } from './metric-figures'
import type { Instrument, Report } from './metrics'
import { isRecord, isText, own } from './records'
import type { MetricsWindow } from './metrics-view'
import {
  NO_FIGURE,
  OVERVIEW_PACKS_CAP,
  PACK_CARDS_CAP,
  type MetricsCardsPost,
  type OverviewCard,
  type OverviewPack,
  type OverviewView
} from './overview-view'

/** The most breakdown entries a count card declares in Archon's schema. */
const BREAKDOWN_CAP = 4

export const NO_RECORDS_TEXT = 'no records in this window'
export const NOTHING_COUNTED_TEXT = 'nothing counted'

type Declared =
  | { shape: 'count'; title: string; metric: string; breakdown: { metric: string; label: string }[] }
  | { shape: 'ratio'; title: string; numerator: string; denominator: string; denominatorLabel: string }
  | { shape: 'cost_per'; title: string; metric: string; costOf: string | null }
  | { shape: 'unknown'; title: string }

type DeclaredPack = { key: string; name: string; cards: Declared[] }

/** The card declarations as the worker reads them, and how many cards of an unknown shape they hold. */
export type CardDeclarations = { packs: DeclaredPack[]; unknownShapes: number }

const text = (record: Record<string, unknown>, key: string): string => {
  const value = own(record, key)
  need(isText(value))
  return cutAt(value, METRICS_TEXT_CAP)
}
const metricName = (record: Record<string, unknown>, key: string): string => {
  const value = own(record, key)
  need(isMetricName(value))
  return value
}

function parseCard(value: unknown): Declared {
  need(isRecord(value))
  const shape = own(value, 'shape')
  need(isText(shape))
  const title = text(value, 'title')
  switch (shape) {
    case 'count': {
      const breakdown = own(value, 'breakdown')
      need(breakdown === undefined || Array.isArray(breakdown))
      const entries = ((breakdown ?? []) as unknown[]).slice(0, BREAKDOWN_CAP).map((entry) => {
        need(isRecord(entry))
        return { metric: metricName(entry, 'metric'), label: text(entry, 'label') }
      })
      return { shape, title, metric: metricName(value, 'metric'), breakdown: entries }
    }
    case 'ratio':
      return {
        shape,
        title,
        numerator: metricName(value, 'numerator'),
        denominator: metricName(value, 'denominator'),
        denominatorLabel: text(value, 'denominator_label')
      }
    case 'cost_per': {
      const costOf = own(value, 'cost_of')
      need(costOf === undefined || isMetricName(costOf))
      return { shape, title, metric: metricName(value, 'metric'), costOf: costOf ?? null }
    }
    default:
      return { shape: 'unknown', title }
  }
}

/** The packs and their cards, in Archon's order, or null when any part the plugin reads fails. */
export function parseCardDeclarations(value: unknown): CardDeclarations | null {
  return readable(() => {
    need(isRecord(value))
    const packs = own(value, 'packs')
    need(Array.isArray(packs))
    let unknownShapes = 0
    const parsed = (packs as unknown[]).map((pack): DeclaredPack => {
      need(isRecord(pack))
      const cards = own(pack, 'cards')
      need(Array.isArray(cards))
      const declared = (cards as unknown[]).map(parseCard)
      unknownShapes += declared.filter((card) => card.shape === 'unknown').length
      const name = text(pack, 'pack')
      return { key: `${text(pack, 'source')}:${name}`, name, cards: declared }
    })
    return { packs: parsed, unknownShapes }
  })
}

type Count = { headline: Instrument; instruments: Instrument[] }

/** The counts of a report by name, and how many metrics of a kind the plugin does not know it holds. */
export type CardReport = { counts: Map<string, Count>; unknownKinds: number }

/** What the cards read of the window's report: its counts, the first of a name winning. Scores count nothing. */
export function cardReportOf(report: Report): CardReport {
  const counts = new Map<string, Count>()
  let unknownKinds = 0
  for (const metric of report.metrics) {
    if (metric.kind === 'unknown') unknownKinds += 1
    else if (metric.kind === 'count' && !counts.has(metric.name)) counts.set(metric.name, { headline: metric.headline, instruments: metric.instruments })
  }
  return { counts, unknownKinds }
}

/** A count's figures at the judge version of a card's main figure, as the console's `instrumentAt`. */
const countAt = (report: CardReport, name: string, main: Instrument): Instrument | undefined =>
  report.counts.get(name)?.instruments.find((each) => sameIdentity(each, main))

type Figure = { figure: string; line: string | null; percent?: number }
const NOT_RECORDED: Figure = { figure: NO_FIGURE, line: NO_RECORDS_TEXT }

function countFigure(card: Extract<Declared, { shape: 'count' }>, report: CardReport, names: ReadonlyMap<string, string>): Figure {
  const main = report.counts.get(card.metric)?.headline
  if (main === undefined) return NOT_RECORDED
  const breakdown = card.breakdown.map(({ metric, label }) => {
    const value = countAt(report, metric, main)?.value
    return value === undefined ? `no records of ${names.get(metric) ?? label}` : `${formatNumber(value)} ${label}`
  })
  return { figure: formatNumber(main.value), line: breakdown.length === 0 ? null : breakdown.join(' · ') }
}

function ratioFigure(card: Extract<Declared, { shape: 'ratio' }>, report: CardReport): Figure {
  const numerator = report.counts.get(card.numerator)?.headline
  const denominator = numerator === undefined ? undefined : countAt(report, card.denominator, numerator)
  if (numerator === undefined || denominator === undefined) return NOT_RECORDED
  if (denominator.value === 0) return { figure: NO_FIGURE, line: `${formatNumber(denominator.value)} ${card.denominatorLabel}` }
  const share = numerator.value / denominator.value
  return {
    figure: formatShare(share),
    percent: Math.round(Math.min(Math.max(share, 0), 1) * 100),
    line: `${formatNumber(numerator.value)} of ${formatNumber(denominator.value)} ${card.denominatorLabel}`
  }
}

function costPerFigure(card: Extract<Declared, { shape: 'cost_per' }>, report: CardReport): Figure {
  const counted = report.counts.get(card.metric)?.headline
  if (counted === undefined) return NOT_RECORDED
  const costed = card.costOf === null ? counted : countAt(report, card.costOf, counted)
  if (costed === undefined) return NOT_RECORDED
  if (counted.value === 0) return { figure: NO_FIGURE, line: NOTHING_COUNTED_TEXT }
  const runsWithCost = costed.runs - costed.runsWithoutCost
  const line = `${String(runsWithCost)} of ${String(costed.runs)} runs record cost`
  // Half or fewer of the producing runs recorded a cost, so a figure per item would mislead.
  if (costed.usd === null || runsWithCost * 2 <= costed.runs) return { figure: NO_FIGURE, line }
  return { figure: `≥ $${formatNumber(costed.usd / counted.value)}`, line }
}

/** The metric a card's Details link opens Details at, as the console's `cardMetric`. */
const cardMetric = (card: Exclude<Declared, { shape: 'unknown' }>): string => (card.shape === 'ratio' ? card.numerator : card.metric)

/** Ids unique within a pack, from what each card is about rather than where it sits. */
function cardIds(cards: Declared[]): string[] {
  const seen = new Map<string, number>()
  return cards.map((card) => {
    const base = `${card.shape}:${card.shape === 'unknown' ? card.title : cardMetric(card)}`
    const times = (seen.get(base) ?? 0) + 1
    seen.set(base, times)
    return times === 1 ? base : `${base}#${String(times)}`
  })
}

function overview(declarations: CardDeclarations, card: (declared: Declared, id: string) => OverviewCard): OverviewView {
  const declaring = declarations.packs.filter((pack) => pack.cards.length > 0)
  const keys = new Map<string, number>()
  const packs = declaring.slice(0, OVERVIEW_PACKS_CAP).map((pack): OverviewPack => {
    const times = (keys.get(pack.key) ?? 0) + 1
    keys.set(pack.key, times)
    const shown = pack.cards.slice(0, PACK_CARDS_CAP)
    const ids = cardIds(shown)
    return {
      key: times === 1 ? pack.key : `${pack.key}#${String(times)}`,
      name: pack.name,
      cards: shown.map((declared, index) => card(declared, ids[index] ?? declared.shape)),
      more: pack.cards.length - shown.length
    }
  })
  return { packs, morePacks: declaring.length - packs.length }
}

/** The cards before the window's report answers: each title over a skeleton. */
export function pendingOverview(declarations: CardDeclarations): OverviewView {
  return overview(declarations, (declared, id) =>
    declared.shape === 'unknown'
      ? { id, title: declared.title, kind: 'unknown-shape' }
      : { id, title: declared.title, kind: 'pending', metric: cardMetric(declared) }
  )
}

/** The finished cards of the window's report, by the console's rules, with the plain names the packs declare. */
export function overviewOf(declarations: CardDeclarations, report: CardReport, names: ReadonlyMap<string, string>): OverviewView {
  return overview(declarations, (declared, id): OverviewCard => {
    if (declared.shape === 'unknown') return { id, title: declared.title, kind: 'unknown-shape' }
    const figure =
      declared.shape === 'count' ? countFigure(declared, report, names) : declared.shape === 'ratio' ? ratioFigure(declared, report) : costPerFigure(declared, report)
    return { id, title: declared.title, kind: 'figure', shape: declared.shape, metric: cardMetric(declared), ...figure }
  })
}

/** The post that carries the titles before the window's report answers, for the scope and window it is for. */
export function cardsPost(codebaseId: string | undefined, window: MetricsWindow, declarations: CardDeclarations): MetricsCardsPost {
  const post: MetricsCardsPost = { window, overview: pendingOverview(declarations) }
  if (codebaseId !== undefined) post.codebaseId = codebaseId
  return post
}

/** The worker's log line of what it does not know in one read, or null when it knew everything. */
export function unknownsLine(declarations: CardDeclarations, report: CardReport): string | null {
  const { unknownShapes } = declarations
  const { unknownKinds } = report
  if (unknownShapes === 0 && unknownKinds === 0) return null
  return `Orchon saw ${String(unknownShapes)} overview cards of a shape and ${String(unknownKinds)} metrics of a kind it does not know.`
}
