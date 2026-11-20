// What the Metrics section draws of the refusals and of the packs whose card declarations Archon
// could not read: on Overview a danger callout with the number of refused outputs and a warning
// callout per pack, and on Details a collapsed group of refusals above the table, each leading
// to its run. The words are the console's (`MetricsOverview.tsx` and `MetricsDetails.tsx` in the
// console's metrics folder of Archon 0.14.0, commit 8def159a6b2c23e832a5283b4131cfffd9af9344).
// It draws text only; the worker cut Archon's free text.
import { Callout, Collapsible, Link, Row, Stack, Text, type OrcaNode } from 'orca'
import type { MetricsView } from './metrics-view'
import { moreLine } from './overview-section'

type Ready = Extract<MetricsView, { kind: 'ready' }>

/** "1 metric output refused", or the count of them. */
export const refusedLine = (count: number): string => `${String(count)} metric output${count === 1 ? '' : 's'} refused`

/** The Details group's title: "1 metric output was refused", or the count of them. */
export const refusedTitle = (count: number): string => `${String(count)} metric output${count === 1 ? ' was' : 's were'} refused`

/** "The project pack x declares cards that could not be read: <Archon's message>" */
export const unreadablePackLine = (source: string, pack: string, message: string): string =>
  `The ${source} pack ${pack} declares cards that could not be read: ${message}`

/** Overview's callouts, above the cards: the refused outputs, then each pack that could not be read. */
export function refusalCallouts(report: Ready, openDetails: () => void): OrcaNode {
  if (report.refusedTotal === 0 && report.unreadablePacks.length === 0 && report.moreUnreadablePacks === 0) return null
  return (
    <Stack gap="xs">
      {report.refusedTotal === 0 ? null : (
        <Callout tone="danger">
          <Row gap="sm" wrap align="center">
            <Text>{refusedLine(report.refusedTotal)}</Text>
            <Link onPress={openDetails}>Details</Link>
          </Row>
        </Callout>
      )}
      {report.unreadablePacks.map((pack) => (
        <Callout key={pack.key} tone="warning">
          <Text>{unreadablePackLine(pack.source, pack.pack, pack.message)}</Text>
        </Callout>
      ))}
      {moreLine(report.moreUnreadablePacks)}
    </Stack>
  )
}

/** The link's words: the console's "run" and the first 8 characters of the run id. */
export const openRunText = (runId: string): string => `Open run ${runId.slice(0, 8)}`

/**
 * Details' group of refusals above the table, shut until opened, in Archon's order: the workflow
 * and node, why in the console's words, and a link that opens the run's detail in the panel.
 */
export function refusalsGroup(report: Ready, openRun: (runId: string) => void): OrcaNode {
  if (report.refusedTotal === 0) return null
  return (
    <Collapsible title={refusedTitle(report.refusedTotal)}>
      <Stack gap="sm">
        {report.refused.map((refusal) => (
          <Stack key={refusal.key} gap="xs">
            <Text>{`${refusal.workflowName}/${refusal.nodeId}`}</Text>
            <Text muted size="sm">
              {refusal.text}
            </Text>
            <Row>
              <Link onPress={() => openRun(refusal.runId)}>{openRunText(refusal.runId)}</Link>
            </Row>
          </Stack>
        ))}
        {moreLine(report.refusedTotal - report.refused.length)}
      </Stack>
    </Collapsible>
  )
}
