// PROTOTYPE, variant B: close to Archon's console. Filter chips, then three stacked sections:
// runs that need you, active runs as cards with progress, recent runs as a list with a
// "load more" button.
import {
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  List,
  ListItem,
  Progress,
  read,
  RelativeTime,
  Row,
  set,
  Spinner,
  Stack,
  Text
} from 'orca'
import type { RunRow } from './protocol'
import { attention, filter, loadMore, meta, openRun, PAGE, page, scope, setFilter } from './state'
import { cost, duration, FILTERS, STATUS, StatusBadge, WorktreeAction } from './shared'

function ActiveCard(row: RunRow) {
  const step = row.step
  return (
    <Card key={row.id} title={row.workflow} description={row.message}>
      <Stack gap="xs">
        <Row gap="xs" align="center" wrap>
          {StatusBadge(row)}
          <Text muted size="xs">
            {read(scope) === 'all' ? `${row.project} · ` : ''}
            <RelativeTime at={row.startedAt} format="duration" /> · {cost(row) || 'no cost yet'}
          </Text>
        </Row>
        {step ? (
          <Stack gap="xs">
            <Progress label={`Step ${step.done} of ${step.total}`} labelHidden value={(step.done / step.total) * 100} />
            <Text muted size="xs">
              {step.name} · step {step.done} of {step.total}
            </Text>
          </Stack>
        ) : (
          <Text muted size="xs">
            Waiting for a free slot
          </Text>
        )}
        <Row gap="xs" wrap>
          <Button size="sm" onPress={() => set(openRun, row)}>
            Open run
          </Button>
        </Row>
        {WorktreeAction(row)}
      </Stack>
    </Card>
  )
}

function RecentItem(row: RunRow) {
  return (
    <ListItem key={row.id} title={row.workflow} description={row.message} onPress={() => set(openRun, row)}>
      <Row gap="xs" align="center" wrap>
        {StatusBadge(row)}
        <Text muted size="xs">
          <RelativeTime at={row.startedAt} format="short" />
          {row.endedAt ? ` · ${duration(row.endedAt - row.startedAt)}` : ''}
          {cost(row) ? ` · ${cost(row)}` : ''}
          {read(scope) === 'all' ? ` · ${row.project}` : ''}
        </Text>
      </Row>
    </ListItem>
  )
}

export function VariantB() {
  const { rows, total, loading } = read(page)
  const { counts } = read(meta)
  const current = read(filter)
  const waiting = read(attention)
  const sectioned = current === 'all'
  const active = sectioned ? rows.filter((row) => !row.endedAt && !row.attention) : []
  const rest = sectioned ? rows.filter((row) => row.endedAt) : rows

  return (
    <Stack gap="md">
      <Row gap="xs" wrap>
        {FILTERS.filter((key) => key === 'all' || !counts || counts[key] > 0).map((key) => (
          <Button
            key={key}
            size="xs"
            variant={key === current ? 'solid' : 'outline'}
            tone={key === current ? 'accent' : 'neutral'}
            onPress={() => setFilter(key)}
          >
            {STATUS[key].word}
            {counts ? ` ${counts[key]}` : ''}
          </Button>
        ))}
      </Row>

      {sectioned && waiting.length > 0 ? (
        <Stack gap="xs">
          <Heading level={3}>Needs you</Heading>
          {waiting.map((row) => (
            <Callout key={row.id} tone="warning" title={row.workflow}>
              <Stack gap="xs">
                <Text size="sm">{row.attention?.question}</Text>
                <Text muted size="xs">
                  {row.project} · waiting <RelativeTime at={row.startedAt} format="duration" />
                </Text>
                <Row gap="xs" wrap>
                  <Button size="sm" tone="warning" onPress={() => set(openRun, row)}>
                    Answer
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ))}
        </Stack>
      ) : null}

      {active.length > 0 ? (
        <Stack gap="xs">
          <Heading level={3}>Active</Heading>
          {active.map(ActiveCard)}
        </Stack>
      ) : null}

      <Stack gap="xs">
        {sectioned ? <Heading level={3}>Recent</Heading> : null}
        {rest.length > 0 ? (
          <List label={sectioned ? 'Recent runs' : `${STATUS[current].word} runs`}>{rest.map(RecentItem)}</List>
        ) : loading ? (
          <Spinner label="Loading runs" />
        ) : (
          <EmptyState title="No runs here" description="Nothing matches this filter." icon="activity" />
        )}
        {rows.length < total ? (
          <Row gap="sm" align="center" wrap>
            <Button size="sm" variant="outline" disabled={loading} onPress={() => void loadMore()}>
              {loading ? 'Loading' : `Load ${Math.min(PAGE, total - rows.length)} more`}
            </Button>
            <Text muted size="xs">
              {rows.length} of {total} shown
            </Text>
          </Row>
        ) : rows.length > 0 ? (
          <Text muted size="xs">
            All {total} shown
          </Text>
        ) : null}
      </Stack>
    </Stack>
  )
}
