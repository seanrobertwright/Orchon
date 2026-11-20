// Calibrations in the Metrics section: the cards the worker posts again once its year-long report
// for calibrations answered, which replace those of the report on screen and of no other; the
// lines under the Details table for calibrations whose metric has no records in the window; and
// the calibration lines of a metric's view, with the sentence that explains "rough", said only
// there. It draws words only; the worker read the calibrations.
import { atom, plugin, read, set, Stack, Text, type OrcaNode, type PanelContext } from 'orca'
import type { MetricCalibrations, MetricsCalibrationsPost } from './calibration-view'
import type { MetricsView } from './metrics-view'
import { moreLine } from './overview-section'
import type { OverviewView } from './overview-view'

type Ready = Extract<MetricsView, { kind: 'ready' }>

export const CALIBRATIONS_HEADING = 'Calibrations'
export const CALIBRATIONS_LOADING_TEXT = 'Calibrations are loading.'
export const CALIBRATIONS_UNAVAILABLE_TEXT = 'Calibrations unavailable.'
export const CALIBRATIONS_UNREAD_TEXT = 'Calibrations were not read. Refresh reads them.'

/** The newest cards the worker posted with their calibration markers. */
const posted = atom<MetricsCalibrationsPost | null>(null)

/** Keeps the cards the worker posts and tells `arrived` of each. They stop when the panel closes. */
export function startCalibrationSection(ctx: PanelContext, arrived: (post: MetricsCalibrationsPost) => void): void {
  ctx.subscriptions.push(
    plugin.on('metrics.calibrations', (post) => {
      set(posted, post)
      arrived(post)
    })
  )
}

/** A different Archon store: the cards belong to the old one. */
export function clearCalibrations(): void {
  set(posted, null)
}

/** Whether a post follows the read of the report on screen: the same scope, window and read. */
export const followsReport = (post: MetricsCalibrationsPost, report: { window: string; codebaseId?: string; fetchedAt: number }): boolean =>
  post.window === report.window && post.codebaseId === report.codebaseId && post.fetchedAt === report.fetchedAt

/** The cards of the report on screen, with their calibration markers once the worker posted them. */
export function calibratedOverview(report: Ready): OverviewView {
  const post = read(posted)
  return post !== null && followsReport(post, report) ? post.overview : report.overview
}

/** Muted lines, keyed by their text: each names a different metric. */
const lines = (texts: readonly string[]): OrcaNode[] =>
  texts.map((text) => (
    <Text key={text} muted size="sm">
      {text}
    </Text>
  ))

/** The calibrations whose metric has no records in the window, under the Details table, or nothing. */
export function unmatchedLines(report: Ready): OrcaNode {
  if (report.unmatchedCalibrations.length === 0) return null
  return (
    <Stack gap="xs">
      {lines(report.unmatchedCalibrations)}
      {moreLine(report.unmatchedMore)}
    </Stack>
  )
}

/** A metric's calibrations in its view, or nothing when none calibrates it and no pack declares one. */
export function calibrationsBlock(calibrations: MetricCalibrations): OrcaNode {
  let body: OrcaNode
  switch (calibrations.state) {
    case 'loading':
      body = <Text muted size="sm">{CALIBRATIONS_LOADING_TEXT}</Text>
      break
    case 'unavailable':
      body = <Text muted size="sm">{`${CALIBRATIONS_UNAVAILABLE_TEXT} ${calibrations.message}`}</Text>
      break
    case 'unread':
      body = <Text muted size="sm">{CALIBRATIONS_UNREAD_TEXT}</Text>
      break
    case 'loaded':
      if (calibrations.lines.length === 0 && calibrations.sentence === null) return null
      body = (
        <>
          {lines(calibrations.lines)}
          {moreLine(calibrations.more)}
          {calibrations.sentence === null ? null : <Text size="sm">{calibrations.sentence}</Text>}
        </>
      )
  }
  return (
    <Stack gap="xs">
      <Text size="sm">{CALIBRATIONS_HEADING}</Text>
      {body}
    </Stack>
  )
}
