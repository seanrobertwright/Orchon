// Calibrations as a frame gets them: the post that carries the Overview cards again once the
// year-long report for calibrations answered, and the calibration lines a metric's view and the
// Details table hold. It is types and constants only, read by the panel and the worker alike.
import type { MetricsWindow } from './metrics-view'
import type { OverviewView } from './overview-view'

/** How many calibration lines a metric's view lists at most, and the Details table under it. */
export const CALIBRATION_LINES_CAP = 5

/** The words of a ratio card's calibration marker, as the console's `CalibrationPill` writes them. */
export const ROUGH_TEXT = 'rough'
export const NOT_CALIBRATED_TEXT = 'not calibrated'
export const CALIBRATION_LOADING_TEXT = 'calibration loading'
export const CALIBRATION_UNAVAILABLE_TEXT = 'calibration unavailable'

/** Which read of Archon a report is: its scope, its window and when the window's report was read. */
export type ReadIdentity = { codebaseId?: string; window: MetricsWindow; fetchedAt: number }

/**
 * The worker's post once the year-long report for calibrations answered or failed: the Overview
 * cards of the read it follows, with their calibration markers. It names that read, so a panel
 * applies it only to the report it shows.
 */
export type MetricsCalibrationsPost = ReadIdentity & { overview: OverviewView }

/** The calibrations of one metric, for its view. */
export type MetricCalibrations =
  /** The year-long report has not answered yet: the panel asks again when it posts. */
  | { state: 'loading' }
  /** The year-long report failed: the sentence says why. */
  | { state: 'unavailable'; message: string }
  /**
   * The worker holds no report for the scope and window, as after a restart, so it read the one
   * metric by name and no calibrations: a Refresh of the section reads them.
   */
  | { state: 'unread' }
  | {
      state: 'loaded'
      /** One line per score that calibrates the metric, at most `CALIBRATION_LINES_CAP`, in Archon's order. */
      lines: string[]
      /** How many lines past the cap are not listed. */
      more: number
      /** What "rough" means for the metric's share, when a pack declares a calibration for it and one counts. */
      sentence: string | null
    }
