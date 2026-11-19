// The words for each connection state that more than one place shows: the panel's state
// screens, the Settings section and the status bar item. They are copied from the wording table
// of the decision on what the plugin shows when Archon is missing, so they are kept in one file.
// The panel loads this file, so it imports nothing but types.
import type { Connected, ConnectionView, NotFound, SettingKey } from './connection-view'

/** The settings' labels as Orca's Settings shows them. */
export const SETTING_LABELS: Record<SettingKey, string> = {
  baseUrl: 'Base URL',
  archonHome: 'Archon home folder'
}

export const SEARCHING_LABEL = 'Looking for Archon…'
export const NOT_RUNNING_TITLE = 'Archon is not running.'
export const NO_HOME_TITLE = 'Orchon could not find Archon.'
export const BAD_SETTING_TITLE = 'A connection setting is not valid.'
export const CONNECTED_LABEL = 'Connected'
export const UNSUPPORTED_TITLE = 'This Archon is not supported.'

/** The oldest Archon release Orchon works with. It is said to the person, never compared. */
export const FLOOR_RELEASE = '0.12.1'
/** The newest Archon release Orchon has recorded fixtures for. It too is only said, never compared. */
export const NEWEST_TESTED_RELEASE = '0.14.0'
/** The System group's "Tested range" row: the oldest and newest releases with recorded fixtures. */
export const TESTED_RANGE = `Tested with Archon ${FLOOR_RELEASE} to ${NEWEST_TESTED_RELEASE}`

/** The release that first served the metrics paths. It too is only said, never compared. */
export const METRICS_RELEASE = '0.14.0'

/** Archon's installation guide: the plugin's one link to a site outside this computer. */
export const INSTALL_URL = 'https://archon.diy/getting-started/installation/'

/** Whether Not found is the "could not find Archon" wording: the home folder is not there. */
export function isHomeMissing(view: NotFound): boolean {
  return view.home === 'missing'
}

/** The state in a few words, as the Settings section names it. */
export function stateTitle(view: ConnectionView): string {
  switch (view.kind) {
    case 'searching':
      return SEARCHING_LABEL
    case 'connected':
      return CONNECTED_LABEL
    case 'not-found':
      return isHomeMissing(view) ? NO_HOME_TITLE : NOT_RUNNING_TITLE
    case 'bad-setting':
      return BAD_SETTING_TITLE
    case 'unsupported':
      return UNSUPPORTED_TITLE
  }
}

/**
 * The status bar sentence: one full sentence saying what the connection is, or what is wrong
 * with it. It is plain text, with no code marks.
 */
export function statusSentence(view: ConnectionView): string {
  switch (view.kind) {
    case 'searching':
      return 'Looking for Archon.'
    case 'connected':
      return view.version === null
        ? `Connected to Archon at ${view.baseUrl}.`
        : `Connected to Archon ${view.version} at ${view.baseUrl}.`
    case 'not-found':
      return isHomeMissing(view) && view.settings.homeFolder !== null
        ? `No Archon home folder at ${view.settings.homeFolder}.`
        : `Archon is not running at ${view.address}.`
    case 'bad-setting': {
      const [only, ...more] = view.refused
      return only !== undefined && more.length === 0
        ? `The ${SETTING_LABELS[only.key]} setting is not valid.`
        : 'Two connection settings are not valid.'
    }
    case 'unsupported':
      return `The Archon at ${view.baseUrl} is not supported. Orchon needs ${FLOOR_RELEASE} or newer.`
  }
}

/** What the Metrics section says, in place of any request, to a server without the metrics paths. */
export function metricsMissing(view: Connected): string {
  const reports = view.version === null ? 'This server does not report its version.' : `This server reports ${view.version}.`
  return `Metrics needs Archon ${METRICS_RELEASE} or newer. ${reports}`
}
