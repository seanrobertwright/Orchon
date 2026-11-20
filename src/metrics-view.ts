// The Metrics section as a frame gets it: the request a panel sends and the trimmed view model
// the worker answers. It is types and constants only, so the panel and the worker read one
// contract and none of Archon's report crosses to the panel.
import type { ConnectionAnswer } from './connection-view'
import type { OverviewView } from './overview-view'

/** The windows the section offers, as Archon's `since` names them. */
export const METRICS_WINDOWS = ['7d', '30d', '90d'] as const
export type MetricsWindow = (typeof METRICS_WINDOWS)[number]

/** The window the section opens on until the person chooses another. */
export const DEFAULT_WINDOW: MetricsWindow = '7d'

/** How many days each window covers, for the words the section says. */
export const WINDOW_DAYS: Readonly<Record<MetricsWindow, number>> = { '7d': 7, '30d': 30, '90d': 90 }

/** How old the data on screen may be before a return to the section reads Archon again. */
export const METRICS_MAX_AGE_MS = 5 * 60_000

/** How many rows the Details table holds at most, by name. */
export const DETAILS_ROWS_CAP = 200

/** How many refusals the view model keeps at most, in Archon's order. */
export const REFUSALS_CAP = 20

/**
 * How long the panel waits for the worker's answer: the card declarations' `TIMEOUT_MS.read` and
 * the report's `TIMEOUT_MS.report` in `client.ts`, with room for the worker itself.
 */
export const METRICS_REQUEST_TIMEOUT_MS = 45_000

/**
 * What a panel sends. Under "This project" it sends the Archon project's id; under "All projects"
 * it leaves it out. A `window` is the person's choice, which the worker keeps; without one the
 * worker uses the kept choice. `refresh` reads Archon whatever the worker holds; without it the
 * worker answers from the report it holds for the scope and window while that is at most
 * `METRICS_MAX_AGE_MS` old.
 */
export type MetricsRequest = { codebaseId?: string; window?: MetricsWindow; refresh?: true }

/** One row of the Details table: one metric, with its headline judge version's figures. */
export type MetricRow =
  | {
      /** The dotted name, Archon's own. */
      name: string
      /** The plain name a pack declares for it, or the dotted name when none does. */
      label: string
      state: 'shown'
      /** The window's value with its unit, such as "4 items" or "70%". */
      value: string
      /** How many records the value is based on. */
      records: number
      /** "≥ $1.42", or "none recorded" when no run recorded a cost. */
      knownCost: string
      /** The latest record's value in the metric's unit. */
      latest: string
    }
  /** A metric of a kind this version of Orchon does not know: it keeps its row, without figures. */
  | { name: string; label: string; state: 'unknown-kind' }

/** One node output whose records Archon would not store. Shown by a later version of the section. */
export type RefusalRow = { reason: string; runId: string; workflowName: string; nodeId: string }

export type MetricsView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /** The server has no metrics: its path list lacks them, or it answered with its HTML page. */
  | { kind: 'missing'; message: string }
  | {
      kind: 'ready'
      window: MetricsWindow
      /** The project the report covers, left out under "All projects". */
      codebaseId?: string
      /** The window Archon reports, in milliseconds since the epoch: from `since` up to `until`. */
      since: number
      until: number
      /** When the worker read the report from Archon. */
      fetchedAt: number
      /** By name, calibrations left out, at most `DETAILS_ROWS_CAP`. */
      rows: MetricRow[]
      /** How many rows past the cap are not shown. */
      more: number
      /** The first `REFUSALS_CAP` refusals, in Archon's order. */
      refused: RefusalRow[]
      /** How many refusals Archon reported in all, the ones past the cap and unreadable ones included. */
      refusedTotal: number
      /** The cards packs declare, finished by the console's rules. */
      overview: OverviewView
      /**
       * The calibrations in the window's report whose metric has no records in it, for the lines
       * under the Details table, at most `CALIBRATION_LINES_CAP`, in Archon's order.
       */
      unmatchedCalibrations: string[]
      /** How many of those past the cap are not listed. */
      unmatchedMore: number
    }
  /**
   * The read failed and shows nothing partial. `timeout` and `too-large` have their own words;
   * `failed` carries Archon's message or the reason the plugin could not read it.
   */
  | { kind: 'timeout' }
  | { kind: 'too-large' }
  | { kind: 'unreadable' }
  | { kind: 'failed'; message: string }

export type MetricsAnswer = ConnectionAnswer & {
  /** The window the request was for: the kept choice when it named none. */
  window: MetricsWindow
  metrics: MetricsView
}
