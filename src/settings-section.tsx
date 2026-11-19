// The Settings section: its groups in their fixed order, under one line saying that every value
// here is install-wide. It takes no scope: the values apply to the whole install.
import { Code, Stack, Text, type OrcaNode } from 'orca'
import { accessGroup } from './access-group'
import { connectionGroup } from './connection-group'
import type { ConnectionView } from './connection-view'
import { formGroups } from './form-groups'
import { notificationsGroup } from './notifications-group'
import { systemGroup } from './system-group'
import type { SystemView } from './system-view'
import { searchingBanner } from './view-notices'

export type SettingsActions = {
  /** Reads health, the update check, the config and the providers again. */
  refresh(): void
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
      {notificationsGroup()}
      {accessGroup()}
      <Text muted>Provider keys and logins are set up in Archon itself.</Text>
    </Stack>
  )
}
