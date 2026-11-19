// The connection as the run graph tab draws it, in its own HTML (#22): the Searching banner and
// label, and each state screen as plain text. The words are those of the panel's state screens,
// from `connection-words.ts`; the tab has no Settings section to open, so it says where the
// settings are. A word between backticks is drawn as code. It is pure logic.
import type { AddressSource, ConnectionView } from './connection-view'
import {
  BAD_SETTING_TITLE,
  FLOOR_RELEASE,
  INSTALL_URL,
  isHomeMissing,
  NO_HOME_TITLE,
  NOT_RUNNING_TITLE,
  SEARCHING_LABEL,
  SETTING_LABELS,
  UNSUPPORTED_TITLE
} from './connection-words'
import { formatClock } from './dates'
import type { TabConnection, TabScreen } from '../editors/run-graph/graph-view'

/** A value shown as code: a backtick in it would end the code early, so it becomes a quote. */
const code = (value: string): string => `\`${value.replaceAll('`', "'")}\``

function addressFrom(source: AddressSource, homeFolder: string | null): string {
  switch (source) {
    case 'setting':
      return '(from the Base URL setting)'
    case 'server-json':
      return homeFolder === null ? `(from ${code('server.json')})` : `(from ${code('server.json')} in ${code(homeFolder)})`
    case 'default':
      return '(the default address)'
  }
}

const screen = (title: string, lines: string[], rest: Partial<TabScreen> = {}): TabScreen => ({
  title,
  lines,
  command: null,
  after: [],
  tryAgain: true,
  install: null,
  ...rest
})

/** The tab's connection for a state, with the Searching time in the tab's language. */
export function tabConnection(view: ConnectionView, locale: string): TabConnection {
  switch (view.kind) {
    case 'connected':
      return { kind: 'connected', live: view.live }
    case 'searching': {
      const at = formatClock(view.since, locale)
      const stopped = at === '' ? 'Archon stopped answering.' : `Archon stopped answering at ${at}.`
      return { kind: 'searching', banner: `${stopped} Reconnecting…`, label: SEARCHING_LABEL }
    }
    case 'not-found': {
      if (isHomeMissing(view)) {
        const fromSetting = view.settings.archonHome === '' ? '' : ' (from the Archon home folder setting)'
        const line = `There is no Archon home folder at ${code(view.settings.homeFolder ?? '')}${fromSetting}. Archon may not be installed, or it may keep its home somewhere else.`
        return { kind: 'screen', screen: screen(NO_HOME_TITLE, [line], { install: INSTALL_URL }) }
      }
      const line = `Nothing answered at ${code(view.address)} ${addressFrom(view.source, view.settings.homeFolder)}. Start it in a terminal:`
      return {
        kind: 'screen',
        screen: screen(NOT_RUNNING_TITLE, [line], { command: 'archon serve', after: ['Orchon checks again by itself, at least every 30 seconds.'] })
      }
    }
    case 'bad-setting': {
      const lines = view.refused.map((refused) => `${SETTING_LABELS[refused.key]}: ${code(refused.value)} ${refused.reason}`)
      lines.push("Change it in Orca's Settings, under Orchon. Orchon checks again as soon as the setting changes.")
      return { kind: 'screen', screen: screen(BAD_SETTING_TITLE, lines, { tryAgain: false }) }
    }
    case 'unsupported': {
      const reports = view.version === null ? '' : `reports Archon ${view.version} and `
      const line = `The server at ${code(view.baseUrl)} ${addressFrom(view.source, view.settings.homeFolder)} ${reports}lacks parts of Archon's API that Orchon needs. Orchon works with Archon ${FLOOR_RELEASE} or newer. Checking again every 30 seconds.`
      return { kind: 'screen', screen: screen(UNSUPPORTED_TITLE, [line]) }
    }
  }
}
