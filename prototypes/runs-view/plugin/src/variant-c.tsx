// PROTOTYPE, variant C: groups instead of filters. A tree whose top level is the statuses (or
// the projects), each loading its runs when opened, with a preview of the selected run pinned
// under it. Nothing scrolls away to reach an action.
import {
  atom,
  Button,
  KeyValue,
  plugin,
  read,
  Row,
  Select,
  set,
  Stack,
  Text,
  Tree,
  update,
  Box,
  type IconName,
  type TreeItem
} from 'orca'
import type { RunRow, StatusFilter } from './protocol'
import { afterReload, meta, openRun, PAGE, picked, scenario, scope, variant } from './state'
import { cost, duration, FILTERS, STATUS, statusText, StatusBadge, WorktreeAction } from './shared'
import './protocol'

type Group = { rows: RunRow[]; total: number; loading: boolean }

const groupBy = atom<'status' | 'project'>('proto.c.groupBy', 'status')
const groups = atom<Record<string, Group>>({})
const expanded = atom<string[]>([])

const ICONS: Record<string, IconName> = {
  attention: 'bell',
  running: 'play',
  paused: 'pause',
  pending: 'calendar',
  failed: 'error',
  completed: 'check',
  cancelled: 'stop'
}

async function loadGroup(key: string): Promise<void> {
  const current = read(groups)[key] ?? { rows: [], total: 0, loading: false }
  if (current.loading) return
  update(groups, (all) => ({ ...all, [key]: { ...current, loading: true } }))
  const byStatus = read(groupBy) === 'status'
  const answer = await plugin.request('runs.list', {
    scenario: read(scenario),
    scope: read(scope),
    status: byStatus ? (key as StatusFilter) : 'all',
    // Left out, not undefined: a request carries JSON only.
    ...(byStatus ? {} : { project: key }),
    offset: current.rows.length,
    limit: PAGE
  })
  update(groups, (all) => ({
    ...all,
    [key]: { rows: [...current.rows, ...answer.rows], total: answer.total, loading: false }
  }))
}

function reset(): void {
  if (read(variant) !== 'C') return
  const counts = read(meta).counts
  // Open what is live; history stays shut until asked for.
  const open =
    read(groupBy) === 'status'
      ? (['attention', 'running'] as const).filter((key) => counts && counts[key] > 0)
      : read(meta).projects.slice(0, 1).map((project) => project.name)
  set(groups, {})
  set(expanded, [...open])
  set(picked, null)
  for (const key of open) void loadGroup(key)
}
afterReload.push(reset)

function ago(at: number): string {
  // A tree row is plain text, so this cannot tick the way a RelativeTime does.
  return `${duration(Date.now() - at)} ago`
}

function runItem(row: RunRow, byStatus: boolean): TreeItem {
  const facts = [ago(row.startedAt)]
  if (row.endedAt) facts.push(`ran ${duration(row.endedAt - row.startedAt)}`)
  facts.push(byStatus && read(scope) === 'all' ? row.project : byStatus ? cost(row) : statusText(row))
  return { key: row.id, label: row.workflow, description: facts.filter(Boolean).join(' · ') }
}

function items(): TreeItem[] {
  const { counts, projects } = read(meta)
  const loaded = read(groups)
  const byStatus = read(groupBy) === 'status'
  const tops = byStatus
    ? FILTERS.filter((key) => key !== 'all' && counts && counts[key] > 0).map((key) => ({
        key: key as string,
        label: `${STATUS[key].word} (${counts ? counts[key] : 0})`,
        icon: ICONS[key]
      }))
    : projects.map((project) => ({
        key: project.name,
        label: `${project.name} (${project.count})`,
        icon: 'folder' as IconName
      }))

  return tops.map((top) => {
    const group = loaded[top.key]
    if (!group || (group.rows.length === 0 && group.loading)) {
      return { ...top, hasChildren: true }
    }
    const children = group.rows.map((row) => runItem(row, byStatus))
    if (group.rows.length < group.total) {
      children.push({
        key: `more:${top.key}`,
        label: group.loading ? 'Loading' : `Load ${Math.min(PAGE, group.total - group.rows.length)} more`,
        description: `${group.rows.length} of ${group.total} shown`,
        icon: 'add'
      })
    }
    return { ...top, children }
  })
}

function findRun(key: string): RunRow | null {
  for (const group of Object.values(read(groups))) {
    const hit = group.rows.find((row) => row.id === key)
    if (hit) return hit
  }
  return null
}

function onSelect(key: string): void {
  if (key.startsWith('more:')) {
    void loadGroup(key.slice('more:'.length))
    return
  }
  const run = findRun(key)
  if (run) set(picked, run)
}

export function VariantC() {
  const chosen = read(picked)
  return (
    <Stack gap="sm">
      <Select
        label="Group by"
        value={read(groupBy)}
        options={[
          { value: 'status', label: 'Status' },
          { value: 'project', label: 'Project' }
        ]}
        onChange={(value) => {
          set(groupBy, value === 'project' ? 'project' : 'status')
          reset()
        }}
      />
      <Tree
        label="Runs"
        items={items()}
        expanded={read(expanded)}
        selected={chosen?.id}
        maxHeight="md"
        onToggle={({ key, expanded: isOpen }) => {
          update(expanded, (keys) => (isOpen ? [...keys.filter((k) => k !== key), key] : keys.filter((k) => k !== key)))
          if (isOpen && !read(groups)[key]) void loadGroup(key)
        }}
        onSelect={({ key }) => onSelect(key)}
        onAction={({ key }) => {
          const run = findRun(key)
          if (run) set(openRun, run)
        }}
      />
      {chosen ? (
        <Box border padding="sm" radius="md">
          <Stack gap="xs">
            <Row gap="xs" align="center" wrap>
              {StatusBadge(chosen)}
              <Text weight="semibold" size="sm" truncate>
                {chosen.workflow}
              </Text>
            </Row>
            <Text size="sm">{chosen.attention ? chosen.attention.question : chosen.message}</Text>
            <KeyValue
              label="Selected run"
              items={[
                { label: 'Project', value: chosen.project },
                { label: 'Step', value: chosen.step ? `${chosen.step.name}, ${chosen.step.done} of ${chosen.step.total}` : 'not started' },
                { label: 'Cost', value: cost(chosen) || 'none yet' }
              ]}
            />
            <Row gap="xs" wrap>
              <Button size="sm" onPress={() => set(openRun, chosen)}>
                {chosen.attention ? 'Answer' : 'Open run'}
              </Button>
            </Row>
            {WorktreeAction(chosen)}
          </Stack>
        </Box>
      ) : (
        <Text muted size="xs">
          Select a run to see it here. Enter opens it.
        </Text>
      )}
    </Stack>
  )
}
