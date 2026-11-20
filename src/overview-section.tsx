// The Overview tab of the Metrics section: the cards workflow packs declare, as the worker
// finished them, in a grid of one column at 220 px and three at 480 px. Before the window's
// report answers it draws the titles the worker posted as `metrics.cards` over skeletons. It
// draws words and numbers only; the worker did the arithmetic.
import {
  atom,
  Card,
  EmptyState,
  Grid,
  Heading,
  Link,
  plugin,
  Progress,
  read,
  Row,
  set,
  Skeleton,
  Stack,
  Text,
  type OrcaNode,
  type PanelContext
} from 'orca'
import type { MetricsWindow } from './metrics-view'
import type { MetricsCardsPost, OverviewCard, OverviewView } from './overview-view'

export const NO_CARDS_TEXT = 'No pack declares overview cards.'
export const NEWER_SHAPE_TEXT = 'This card needs a newer version of Orchon.'

/** The newest titles the worker posted, for the read in flight. */
const posted = atom<MetricsCardsPost | null>(null)

/** Keeps the titles the worker posts. They stop when the panel closes. */
export function startOverviewSection(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('metrics.cards', (post) => set(posted, post)))
}

/** A different Archon store: the titles belong to the old one. */
export function clearOverview(): void {
  set(posted, null)
}

/** What Overview draws, and where a card's "Details" link leads. */
export type OverviewHooks = {
  /** Opens Details, at the metric a card reads when one is named. */
  openDetails(metric?: string): void
}

/** "and N more in Archon's console" under a capped list, or nothing. */
export const moreLine = (more: number): OrcaNode => (more > 0 ? <Text muted size="sm">{`and ${String(more)} more in Archon's console`}</Text> : null)

function detailsLink(metric: string, hooks: OverviewHooks): OrcaNode {
  return (
    <Row>
      <Link onPress={() => hooks.openDetails(metric)}>Details</Link>
    </Row>
  )
}

function card(shown: OverviewCard, hooks: OverviewHooks): OrcaNode {
  switch (shown.kind) {
    case 'unknown-shape':
      return (
        <Card key={shown.id} title={shown.title}>
          <Text muted size="xs">
            {NEWER_SHAPE_TEXT}
          </Text>
        </Card>
      )
    case 'pending':
      return (
        <Card key={shown.id} title={shown.title}>
          <Stack gap="xs">
            <Skeleton lines={2} label={`Loading ${shown.title}`} />
            {detailsLink(shown.metric, hooks)}
          </Stack>
        </Card>
      )
    case 'figure':
      return (
        <Card key={shown.id} title={shown.title}>
          <Stack gap="xs">
            <Heading level={2}>{shown.figure}</Heading>
            {shown.percent === undefined ? null : <Progress label={shown.title} labelHidden value={shown.percent} />}
            {shown.line === null ? null : (
              <Text muted size="xs">
                {shown.line}
              </Text>
            )}
            {detailsLink(shown.metric, hooks)}
          </Stack>
        </Card>
      )
  }
}

/** The cards of every pack, with a heading per pack when more than one declares cards. */
export function overviewCards(overview: OverviewView, hooks: OverviewHooks): OrcaNode {
  if (overview.packs.length === 0) {
    return (
      <EmptyState title={NO_CARDS_TEXT}>
        <Link onPress={() => hooks.openDetails()}>Details</Link>
      </EmptyState>
    )
  }
  const headed = overview.packs.length + overview.morePacks > 1
  return (
    <Stack gap="md">
      {overview.packs.map((pack) => (
        <Stack key={pack.key} gap="xs">
          {headed ? <Heading level={3}>{pack.name}</Heading> : null}
          <Grid minItemWidth="sm" gap="sm">
            {pack.cards.map((each) => card(each, hooks))}
          </Grid>
          {moreLine(pack.more)}
        </Stack>
      ))}
      {moreLine(overview.morePacks)}
    </Stack>
  )
}

/**
 * The titles over skeletons while the first report for the scope loads, or null when the worker
 * posted none for this scope and window.
 */
export function pendingCards(codebaseId: string | undefined, window: MetricsWindow | null, hooks: OverviewHooks): OrcaNode {
  const post = read(posted)
  if (post === null || window === null || post.window !== window || post.codebaseId !== codebaseId) return null
  return overviewCards(post.overview, hooks)
}
