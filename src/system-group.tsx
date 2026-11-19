// The System group of the Settings section: a read-only list of what Archon's health reported,
// the range of releases Orchon is tested with, and the update check. A value the server did not
// send shows a dash. Its controls are Refresh, which reads both again, and "Try again" beside a
// failed read, which does the same.
import { Button, Callout, Collapsible, env, KeyValue, Link, Skeleton, Stack, Text, type KeyValueItem, type OrcaNode } from 'orca'
import { TESTED_RANGE } from './connection-words'
import { formatClock } from './dates'
import type { HealthFacts, Platforms, SystemView, Updates } from './system-view'

/** What a row shows for a value the server did not send. */
export const DASH = '—'

const orDash = (value: string | number | null): string => (value === null ? DASH : String(value))

function platformsText(platforms: Platforms | null): string {
  if (platforms === null) return DASH
  if (platforms.names.length === 0) return 'None'
  const named = platforms.names.join(', ')
  return platforms.more === 0 ? named : `${named} and ${platforms.more} more`
}

function rows(health: HealthFacts): KeyValueItem[] {
  const { concurrency } = health
  return [
    { label: 'Status', value: orDash(health.status) },
    { label: 'Adapter', value: orDash(health.adapter) },
    { label: 'Database', value: orDash(health.database) },
    { label: 'Version', value: orDash(health.version) },
    { label: 'Tested range', value: TESTED_RANGE },
    { label: 'Store id', value: orDash(health.storeId), ...(health.storeId === null ? {} : { code: true }) },
    { label: 'Concurrency', value: concurrency === null ? DASH : `${concurrency.active} of ${concurrency.max} active` },
    { label: 'Running workflows', value: orDash(health.runningWorkflows) },
    { label: 'Platforms', value: platformsText(health.platforms) }
  ]
}

/** The update check in words. The latest version is a link only when the worker kept one. */
function updatesText(updates: Updates): OrcaNode {
  switch (updates.kind) {
    case 'checking':
      return 'Checking'
    case 'up-to-date':
      return updates.version === null ? 'Up to date' : `Up to date (${updates.version})`
    case 'available':
      return updates.releaseUrl === null ? (
        `${updates.version} available`
      ) : (
        <>
          <Link href={updates.releaseUrl}>{updates.version}</Link> available
        </>
      )
    case 'unavailable':
      return 'Update check unavailable'
  }
}

/** The list, or what stands in its place before an answer. */
function content(system: SystemView | null, refresh: () => void): OrcaNode {
  const health = system?.health ?? null
  const failure = system?.failure ?? null
  if (health === null) {
    return failure === null ? (
      <Skeleton lines={4} label="Reading Archon's status" />
    ) : (
      <Callout tone="warning">
        <Stack gap="sm">
          <Text>{failure}</Text>
          <Button onPress={refresh}>Try again</Button>
        </Stack>
      </Callout>
    )
  }
  const readAt = system?.readAt ?? null
  const at = readAt === null ? '' : formatClock(readAt, env.locale)
  return (
    <>
      {failure === null ? null : (
        <Callout tone="warning">
          <Stack gap="sm">
            <Text>{at === '' ? failure : `${failure} These values are from ${at}.`}</Text>
            <Button onPress={refresh}>Try again</Button>
          </Stack>
        </Callout>
      )}
      <KeyValue label="System" items={rows(health)} />
      <Text>Updates: {updatesText(system?.updates ?? { kind: 'checking' })}</Text>
    </>
  )
}

/** The group. `refresh` is left out while there is no server to ask, and Refresh is then disabled. */
export function systemGroup(system: SystemView | null, refresh: (() => void) | null): OrcaNode {
  const press = refresh ?? ((): void => {})
  return (
    <Collapsible key="System" title="System" defaultOpen>
      <Stack gap="sm">
        {content(system, press)}
        <Button variant="outline" disabled={refresh === null} onPress={press}>
          Refresh
        </Button>
      </Stack>
    </Collapsible>
  )
}
