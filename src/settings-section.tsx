// The Settings section: its groups in their fixed order, under one line saying that every value
// here is install-wide. It takes no scope: the values apply to the whole install.
import { Callout, Code, Collapsible, env, Stack, Text, type OrcaNode } from 'orca'
import { accessGroup } from './access-group'
import { connectionGroup } from './connection-group'
import type { ConnectionView } from './connection-view'
import { formatClock } from './dates'
import { formGroups } from './form-groups'
import { systemGroup } from './system-group'
import type { SystemView } from './system-view'

export type SettingsActions = {
  /** Reads health, the update check, the config and the providers again. */
  refresh(): void
}

/** A group whose content another ticket builds, in its place in the order. */
function notBuilt(title: string): OrcaNode {
  return (
    <Collapsible key={title} title={title}>
      <Text muted>This group is not built yet.</Text>
    </Collapsible>
  )
}

/** The Searching banner over data, with the time Archon stopped answering. */
function searchingBanner(since: number): OrcaNode {
  const at = formatClock(since, env.locale)
  const stopped = at === '' ? 'Archon stopped answering.' : `Archon stopped answering at ${at}.`
  return (
    <Callout tone="warning">
      <Text>{`${stopped} Reconnecting… Changes are turned off until it answers.`}</Text>
    </Callout>
  )
}

/**
 * The groups that hold Archon's own values. Connected shows them; Searching keeps them, under its
 * banner, once they hold an answer; every other state has one line in their place.
 */
function archonGroups(connection: ConnectionView | null, system: SystemView | null, actions: SettingsActions): OrcaNode {
  const groups = (refresh: (() => void) | null): OrcaNode => (
    <>
      {systemGroup(system, refresh)}
      {formGroups(refresh !== null)}
      {notBuilt('Aliases')}
    </>
  )
  if (connection?.kind === 'connected') return groups(actions.refresh)
  if (connection?.kind === 'searching' && system?.health != null) {
    return (
      <>
        {searchingBanner(connection.since)}
        {groups(null)}
      </>
    )
  }
  return <Text>Archon's settings appear here when Orchon is connected.</Text>
}

export function settingsSection(connection: ConnectionView | null, system: SystemView | null, actions: SettingsActions): OrcaNode {
  return (
    <Stack gap="md">
      <Text muted>
        These values are install-wide: they apply to every project on this computer. A project's own{' '}
        <Code>.archon/config.yaml</Code> can override them for that project.
      </Text>
      {connectionGroup(connection)}
      {archonGroups(connection, system, actions)}
      {notBuilt('Notifications')}
      {accessGroup()}
      <Text muted>Provider keys and logins are set up in Archon itself.</Text>
    </Stack>
  )
}
