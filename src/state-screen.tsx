// The state screen: what a section shows below the section bar in place of its content while
// Orchon is not connected. One message at a time, in Orca's own components, and every state is
// told in words as well as by its icon.
import { Button, Code, EmptyState, Link, Row, Spinner, Stack, Text, type OrcaNode } from 'orca'
import type { AddressSource, BadSetting, ConnectionView, NotFound, Unsupported } from './connection-view'
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

export type StateScreenActions = {
  /** Asks the worker to run discovery at once. */
  tryAgain(): void
  /** Shows the panel's Settings section. */
  openSettings(): void
}

/** A sentence in which each word between backticks is shown as code. */
export function withCode(sentence: string): OrcaNode {
  return sentence
    .split('`')
    .map((part, position) => (position % 2 === 1 ? <Code key={`code ${part}`}>{part}</Code> : part))
}

/** The first line of "not running": the address that did not answer and where it came from. */
function nothingAnswered(view: NotFound): OrcaNode {
  const address = <Code>{view.address}</Code>
  const next = 'Start it in a terminal:'
  if (view.source === 'setting') {
    return (
      <Text>
        Nothing answered at {address} (from the Base URL setting). {next}
      </Text>
    )
  }
  if (view.source === 'server-json' && view.settings.homeFolder !== null) {
    return (
      <Text>
        Nothing answered at {address} (from <Code>server.json</Code> in <Code>{view.settings.homeFolder}</Code>). {next}
      </Text>
    )
  }
  if (view.source === 'server-json') {
    return (
      <Text>
        Nothing answered at {address} (from <Code>server.json</Code>). {next}
      </Text>
    )
  }
  return (
    <Text>
      Nothing answered at {address} (the default address). {next}
    </Text>
  )
}

function notRunning(view: NotFound, actions: StateScreenActions): OrcaNode {
  return (
    <EmptyState title={NOT_RUNNING_TITLE} icon="plug">
      {nothingAnswered(view)}
      <Code block>archon serve</Code>
      <Text>Orchon checks again by itself, at least every 30 seconds.</Text>
      <Row gap="sm" wrap justify="center">
        <Button onPress={actions.tryAgain}>Try again</Button>
        <Button variant="outline" onPress={actions.openSettings}>
          Connection settings
        </Button>
      </Row>
    </EmptyState>
  )
}

function noHome(view: NotFound, actions: StateScreenActions): OrcaNode {
  const fromSetting = view.settings.archonHome === '' ? '' : ' (from the Archon home folder setting)'
  return (
    <EmptyState title={NO_HOME_TITLE} icon="search">
      <Text>
        There is no Archon home folder at <Code>{view.settings.homeFolder ?? ''}</Code>
        {fromSetting}. Archon may not be installed, or it may keep its home somewhere else.
      </Text>
      <Row gap="sm" wrap justify="center" align="center">
        <Button onPress={actions.tryAgain}>Try again</Button>
        <Button variant="outline" onPress={actions.openSettings}>
          Connection settings
        </Button>
        <Link href={INSTALL_URL}>Install Archon</Link>
      </Row>
    </EmptyState>
  )
}

function badSetting(view: BadSetting, actions: StateScreenActions): OrcaNode {
  return (
    <EmptyState title={BAD_SETTING_TITLE} icon="warning">
      {view.refused.map((refused) => (
        <Text key={refused.key}>
          <Text weight="medium">{`${SETTING_LABELS[refused.key]}:`}</Text> <Code>{refused.value}</Code>{' '}
          {withCode(refused.reason)}
        </Text>
      ))}
      <Text>Change it in Orca's Settings, under Orchon. Orchon checks again as soon as the setting changes.</Text>
      <Button onPress={actions.openSettings}>Connection settings</Button>
    </EmptyState>
  )
}

/** Where an address came from, as the words that follow it. */
function addressFrom(source: AddressSource, homeFolder: string | null): OrcaNode {
  switch (source) {
    case 'setting':
      return '(from the Base URL setting)'
    case 'server-json':
      return homeFolder === null ? (
        <>
          (from <Code>server.json</Code>)
        </>
      ) : (
        <>
          (from <Code>server.json</Code> in <Code>{homeFolder}</Code>)
        </>
      )
    case 'default':
      return '(the default address)'
  }
}

/**
 * The server answered, but lacks paths Orchon needs. It never says the server is too old: a fork
 * or a source build can report a release past the floor and still lack one.
 */
function unsupportedScreen(view: Unsupported, actions: StateScreenActions): OrcaNode {
  const reports = view.version === null ? '' : `reports Archon ${view.version} and `
  return (
    <EmptyState title={UNSUPPORTED_TITLE} icon="warning">
      <Text>
        The server at <Code>{view.baseUrl}</Code> {addressFrom(view.source, view.settings.homeFolder)} {reports}lacks
        parts of Archon's API that Orchon needs. Orchon works with Archon {FLOOR_RELEASE} or newer. Checking again
        every 30 seconds.
      </Text>
      <Row gap="sm" wrap justify="center">
        <Button onPress={actions.tryAgain}>Try again</Button>
        <Button variant="outline" onPress={actions.openSettings}>
          Connection settings
        </Button>
      </Row>
    </EmptyState>
  )
}

/**
 * The screen for a connection state, or null when Orchon is connected and the section shows its
 * own content. A panel the worker has not answered yet has no state: it shows the spinner too.
 */
export function stateScreen(view: ConnectionView | null, actions: StateScreenActions): OrcaNode {
  if (view === null || view.kind === 'searching') {
    return (
      <Stack align="center">
        <Spinner label={SEARCHING_LABEL} />
      </Stack>
    )
  }
  switch (view.kind) {
    case 'connected':
      return null
    case 'not-found':
      return isHomeMissing(view) ? noHome(view, actions) : notRunning(view, actions)
    case 'bad-setting':
      return badSetting(view, actions)
    case 'unsupported':
      return unsupportedScreen(view, actions)
  }
}
