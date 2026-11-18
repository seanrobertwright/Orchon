// PROTOTYPE, variant A: one dense table, native to Orca. A status select filters it, scrolling
// loads more, a selected row gets a preview strip under the table.
import {
  Callout,
  Card,
  IconButton,
  List,
  ListItem,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Stack,
  Table,
  Text,
  Button,
  type TableColumn,
  type TableRow
} from 'orca'
import type { RunRow, StatusFilter } from './protocol'
import { attention, filter, loadMore, meta, openRun, page, picked, reload, scope, setFilter } from './state'
import { cost, duration, FILTERS, STATUS, StatusBadge, statusOf, WorktreeAction } from './shared'


// Under 360 px only the run and when it started fit, so the glyph rides in the run cell and the
// status word, project and duration appear as the panel widens.
function columns(showProject: boolean): TableColumn[] {
  const list: TableColumn[] = [
    { key: 'run', label: 'Run', minWidth: 'xs' },
    { key: 'status', label: 'Status', width: 'sm', hideBelow: 'sm' }
  ]
  if (showProject) list.push({ key: 'project', label: 'Project', hideBelow: 'md' })
  list.push(
    { key: 'started', label: 'Started', width: 'xs', align: 'end' },
    { key: 'ran', label: 'Ran for', width: 'xs', align: 'end', hideBelow: 'md' }
  )
  return list
}

function toRow(row: RunRow): TableRow {
  const status = statusOf(row)
  return {
    key: row.id,
    cells: {
      run: `${status.glyph} ${row.workflow}`,
      status: status.word,
      project: row.project,
      started: { type: 'relative', at: row.startedAt, format: 'short' },
      ran: row.endedAt
        ? duration(row.endedAt - row.startedAt)
        : { type: 'relative', at: row.startedAt, format: 'duration' }
    }
  }
}

export function VariantA() {
  const { rows, total, loading } = read(page)
  const { counts } = read(meta)
  const waiting = read(attention)
  const current = read(filter)
  const chosen = read(picked)
  const byId = (key: string) => rows.find((row) => row.id === key) ?? null

  return (
    <Stack gap="sm">
      <Row gap="xs" align="end">
        <Select
          label="Status"
          labelHidden
          value={current}
          options={FILTERS.map((key) => ({
            value: key,
            label: counts ? `${STATUS[key].word} (${counts[key]})` : STATUS[key].word
          }))}
          onChange={(value) => setFilter(value as StatusFilter)}
        />
        <IconButton icon="refresh" label="Refresh runs" variant="ghost" onPress={() => void reload()} />
      </Row>

      {waiting.length > 0 && current !== 'attention' ? (
        <Callout tone="warning" title={waiting.length === 1 ? '1 run needs you' : `${waiting.length} runs need you`}>
          <List label="Runs waiting on you">
            {waiting.map((row) => (
              <ListItem
                key={row.id}
                title={row.workflow}
                description={row.attention?.question}
                onPress={() => set(openRun, row)}
              />
            ))}
          </List>
        </Callout>
      ) : null}

      <Table
        label="Runs"
        columns={columns(read(scope) === 'all')}
        rows={rows.map(toRow)}
        selectionMode="single"
        selected={chosen ? [chosen.id] : []}
        hasMore={rows.length < total}
        loading={loading}
        emptyText="No runs match."
        maxHeight="lg"
        onSelectionChange={({ keys }) => set(picked, keys[0] ? byId(keys[0]) : null)}
        onRowAction={({ key }) => set(openRun, byId(key))}
        onLoadMore={() => void loadMore()}
      />
      <Text muted size="xs">
        {rows.length} of {total} loaded. Scroll for more; Enter or a double click opens a run.
      </Text>

      {chosen ? (
        <Card title={chosen.workflow} description={chosen.message}>
          <Stack gap="xs">
            <Row gap="xs" align="center" wrap>
              {StatusBadge(chosen)}
              <Text muted size="xs">
                {chosen.project} · <RelativeTime at={chosen.startedAt} format="short" /> · {cost(chosen)}
              </Text>
            </Row>
            <Row gap="xs" wrap>
              <Button size="sm" onPress={() => set(openRun, chosen)}>
                Open run
              </Button>
            </Row>
            {WorktreeAction(chosen)}
          </Stack>
        </Card>
      ) : null}
    </Stack>
  )
}
