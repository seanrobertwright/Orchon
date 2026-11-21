// The System group of the Settings section: a read-only list of what Archon's health reported,
// the range of releases Orchon is tested with, and the update check. A value the server did not
// send shows a dash. Updates is the last row; a release link the worker kept sits on its own line
// under the list, because a row's value is text only. Its controls are Refresh, which reads both again, and "Try again" beside a
// failed read, which does the same.
import { Button, Callout, Collapsible, env, Link, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { TESTED_RANGE } from './connection-words'
import { formatClock } from './dates'
import { factList, type FactItem } from './fact-list'
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

function rows(health: HealthFacts, updates: Updates): FactItem[] {
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
    { label: 'Platforms', value: platformsText(health.platforms) },
    { label: 'Updates', value: updatesText(updates) }
  ]
}

/** The update check in words. */
function updatesText(updates: Updates): string {
  switch (updates.kind) {
    case 'checking':
      return 'Checking'
    case 'up-to-date':
      return updates.version === null ? 'Up to date' : `Up to date (${updates.version})`
    case 'available':
      return `${updates.version} available`
    case 'unavailable':
      return 'Update check unavailable'
  }
}

/** The latest version as a link, only when the worker kept a release link. */
function releaseLine(updates: Updates): OrcaNode {
  if (updates.kind !== 'available' || updates.releaseUrl === null) return null
  return (
    <Text>
      Release notes: <Link href={updates.releaseUrl}>{updates.version}</Link>
    </Text>
  )
}

/** A failed read, in words, with "Try again". */
function failureCallout(sentence: string, refresh: () => void): OrcaNode {
  return (
    <Callout tone="warning">
      <Stack gap="sm">
        <Text>{sentence}</Text>
        <Button onPress={refresh}>Try again</Button>
      </Stack>
    </Callout>
  )
}

/** The list, or what stands in its place before an answer. */
function content(system: SystemView | null, refresh: () => void): OrcaNode {
  const health = system?.health ?? null
  const failure = system?.failure ?? null
  if (health === null) {
    return failure === null ? <Skeleton lines={4} label="Reading Archon's status" /> : failureCallout(failure, refresh)
  }
  const readAt = system?.readAt ?? null
  const at = readAt === null ? '' : formatClock(readAt, env.locale)
  const updates = system?.updates ?? { kind: 'checking' }
  return (
    <>
      {failure === null ? null : failureCallout(at === '' ? failure : `${failure} These values are from ${at}.`, refresh)}
      {factList('System', rows(health, updates))}
      {releaseLine(updates)}
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
