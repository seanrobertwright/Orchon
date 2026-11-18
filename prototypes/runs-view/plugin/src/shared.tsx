// PROTOTYPE. The few pieces every variant uses: status words, the worktree action, the detail stub.
import {
  Badge,
  Box,
  Button,
  Callout,
  Code,
  Heading,
  KeyValue,
  RelativeTime,
  Row,
  set,
  Stack,
  Text,
  type Tone
} from 'orca'
import type { RunRow, StatusFilter } from './protocol'
import { note, openRun } from './state'

export const FILTERS: StatusFilter[] = [
  'all',
  'attention',
  'running',
  'paused',
  'pending',
  'failed',
  'completed',
  'cancelled'
]

/** A word and a glyph for each state, so colour never carries the meaning alone. */
export const STATUS: Record<StatusFilter, { word: string; glyph: string; tone: Tone }> = {
  all: { word: 'All', glyph: '', tone: 'neutral' },
  attention: { word: 'Needs you', glyph: '!', tone: 'warning' },
  running: { word: 'Running', glyph: '●', tone: 'accent' },
  paused: { word: 'Paused', glyph: '‖', tone: 'warning' },
  pending: { word: 'Queued', glyph: '○', tone: 'neutral' },
  completed: { word: 'Completed', glyph: '✓', tone: 'success' },
  failed: { word: 'Failed', glyph: '✕', tone: 'danger' },
  cancelled: { word: 'Cancelled', glyph: '⊘', tone: 'neutral' }
}

export function statusOf(row: RunRow): { word: string; glyph: string; tone: Tone } {
  return STATUS[row.attention ? 'attention' : row.status]
}

export function statusText(row: RunRow): string {
  const status = statusOf(row)
  return `${status.glyph} ${status.word}`
}

export function StatusBadge(row: RunRow) {
  const status = statusOf(row)
  return (
    <Badge tone={status.tone}>
      {status.glyph} {status.word}
    </Badge>
  )
}

export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function cost(row: RunRow): string {
  return row.costUsd === null ? '' : `$${row.costUsd.toFixed(2)}`
}

export function shortId(row: RunRow): string {
  return row.id.slice(0, 8)
}

/** The three worktree cases from the workspace mapping decision. */
export function WorktreeAction(row: RunRow) {
  const { path, state } = row.worktree
  if (state === 'in-orca') {
    return (
      <Button size="sm" variant="outline" icon="open-external" onPress={() => note(`workspace.open for ${path}`)}>
        Open in Orca
      </Button>
    )
  }
  if (state === 'on-disk') {
    return (
      <Stack gap="xs">
        <Code>{path}</Code>
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="outline" icon="copy" onPress={() => note(`copy ${path} (Orca has no clipboard method for a panel)`)}>
            Copy path
          </Button>
          <Text muted size="xs">
            Orca can show Archon's worktrees: Non-Orca worktrees, in the project's menu.
          </Text>
        </Row>
      </Stack>
    )
  }
  return (
    <Text muted size="xs">
      Worktree removed: {path}
    </Text>
  )
}

/** Run detail belongs to its own ticket; this only lets the drill-in and Back be felt. */
export function RunDetailStub(row: RunRow) {
  return (
    <Stack gap="sm">
      <Row>
        <Button size="sm" variant="ghost" onPress={() => set(openRun, null)}>
          ‹ Back to runs
        </Button>
      </Row>
      <Heading level={2}>{row.workflow}</Heading>
      <Row gap="xs" align="center" wrap>
        {StatusBadge(row)}
        <Text muted size="xs">
          {row.project} · {shortId(row)}
        </Text>
      </Row>
      <Text size="sm">{row.message}</Text>
      {row.attention ? (
        <Callout tone="warning" title="Waiting on you">
          <Text size="sm">{row.attention.question}</Text>
        </Callout>
      ) : null}
      <KeyValue
        label="Run facts"
        items={[
          { label: 'Step', value: row.step ? `${row.step.name} (${row.step.done} of ${row.step.total})` : 'not started' },
          { label: 'Ran for', value: row.endedAt ? duration(row.endedAt - row.startedAt) : 'still going' },
          { label: 'Cost', value: cost(row) || 'none yet' }
        ]}
      />
      <Text muted size="xs">
        Started <RelativeTime at={row.startedAt} />
      </Text>
      {WorktreeAction(row)}
      <Box border padding="sm" radius="md">
        <Text muted size="xs">
          Stub. What run detail shows is decided in its own ticket.
        </Text>
      </Box>
    </Stack>
  )
}
