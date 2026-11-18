// PROTOTYPE, variant A: tables. Plain Back buttons, facts as a key-value block, the Steps and
// Artifacts switch as tabs, and every list a table whose selected row gets a preview under it.
// Activity is newest first: the table's own load-more is "Show earlier".
import {
  Button,
  Callout,
  Card,
  Code,
  CodeView,
  Heading,
  Input,
  KeyValue,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Tab,
  Tabs,
  Table,
  Text,
  type TableColumn,
  type TableRow
} from 'orca'
import type { RunDetail, RunTab, StepRow, StepView } from './protocol'
import {
  activity,
  artifact,
  artifactPath,
  artifacts,
  backToRun,
  filter,
  focus,
  goRuns,
  goStep,
  item,
  itemKey,
  note,
  pickArtifact,
  pickedStep,
  pickItem,
  setFilter,
  setTab,
  showEarlier,
  tab
} from './state'
import {
  ActionRow,
  AnswerBlock,
  ArtifactBodyView,
  bytes,
  clock,
  hiddenLine,
  ItemBody,
  KIND,
  marks,
  runFacts,
  STATE,
  StateBadge,
  stepFacts,
  took
} from './shared'

const STEP_COLUMNS: TableColumn[] = [
  { key: 'step', label: 'Step', minWidth: 'xs' },
  { key: 'state', label: 'State', hideBelow: 'sm' },
  { key: 'took', label: 'Took', width: 'xs', align: 'end' }
]

// A cell is text only, so an inner step is marked with an arrow and a repeat with a count; the
// State column spells both out once the panel is wide enough to show it.
function stepRow(step: StepRow): TableRow {
  const state = STATE[step.state]
  return {
    key: step.id,
    cells: {
      step: `${state.glyph} ${step.parent ? '↳ ' : ''}${step.name}${step.ran > 1 ? ` ×${step.ran}` : ''}`,
      state: [state.word, ...marks(step)].join(', '),
      took:
        step.state === 'running' && step.startedAt !== null
          ? { type: 'relative', at: step.startedAt, format: 'duration' }
          : took(step)
    }
  }
}

function Steps(run: RunDetail) {
  const chosen = run.steps.find((step) => step.id === read(pickedStep)) ?? null
  return (
    <Stack gap="sm">
      {read(focus) === 'preview' ? null : (
      <Table
        label="Steps"
        columns={STEP_COLUMNS}
        rows={run.steps.map(stepRow)}
        selectionMode="single"
        selected={chosen ? [chosen.id] : []}
        maxHeight="lg"
        onSelectionChange={({ keys }) => set(pickedStep, keys[0] ?? null)}
        onRowAction={({ key }) => goStep(key)}
      />
      )}
      <Text muted size="xs">
        {run.steps.length} steps. Enter or a double click opens a step.
      </Text>
      {chosen ? (
        <Card title={chosen.name} description={[chosen.kind, ...marks(chosen)].join(' · ')}>
          <Row gap="xs" align="center" wrap>
            {StateBadge(chosen.state)}
            <Text muted size="xs">
              {took(chosen)}
            </Text>
            <Button size="sm" onPress={() => goStep(chosen.id)}>
              Open step
            </Button>
          </Row>
        </Card>
      ) : null}
    </Stack>
  )
}

const FILE_COLUMNS: TableColumn[] = [
  { key: 'path', label: 'Path', minWidth: 'sm' },
  { key: 'size', label: 'Size', width: 'xs', align: 'end' },
  { key: 'modified', label: 'Modified', width: 'xs', align: 'end', hideBelow: 'sm' }
]

function Artifacts() {
  const list = read(artifacts)
  const body = read(artifact)
  const chosen = read(artifactPath)
  return (
    <Stack gap="sm">
      <Input label="Filter files by name" labelHidden type="search" placeholder="Filter files by name" value={read(filter)} onChange={setFilter} />
      {read(focus) === 'preview' ? null : (
      <Table
        label="Artifacts"
        columns={FILE_COLUMNS}
        rows={(list?.rows ?? []).map((file) => ({
          key: file.path,
          cells: { path: file.path, size: bytes(file.size), modified: { type: 'relative', at: file.modifiedAt, format: 'short' } }
        }))}
        selectionMode="single"
        selected={chosen ? [chosen] : []}
        loading={!list || list.loading}
        emptyText="No file matches."
        maxHeight="md"
        onSelectionChange={({ keys }) => void pickArtifact(keys[0] ?? null)}
      />
      )}
      {list ? (
        <Text muted size="xs">
          {list.matching === list.total ? `${list.total.toLocaleString('en-US')} files.` : `${list.matching.toLocaleString('en-US')} of ${list.total.toLocaleString('en-US')} files match.`}
          {list.matching > list.rows.length ? ` The first ${list.rows.length} are shown; ${(list.matching - list.rows.length).toLocaleString('en-US')} are not. Narrow the filter to reach them.` : ''}
        </Text>
      ) : null}
      {body ? (
        <Card title={body.path} description={bytes(body.size)}>
          {ArtifactBodyView(body)}
        </Card>
      ) : null}
    </Stack>
  )
}

export function RunDetailA(run: RunDetail) {
  return (
    <Stack gap="sm">
      {read(focus) === 'all' ? (
      <Stack gap="sm">
      <Row>
        <Button size="sm" variant="ghost" onPress={goRuns}>
          {'‹'} Back to runs
        </Button>
      </Row>
      <Heading level={2}>{run.workflow}</Heading>
      {AnswerBlock(run)}
      {ActionRow(run)}
      <KeyValue label="Run facts" items={runFacts(run)} />
      <Text muted size="xs">
        Started <RelativeTime at={run.startedAt} />. Worktree removed: {run.worktree}
      </Text>
      <Text size="sm">{run.message}</Text>
      {run.messageCut ? (
        <Text muted size="xs">
          The launch message is cut at 2,000 characters.
        </Text>
      ) : null}
      <Row gap="xs" wrap>
        <Button size="sm" variant="outline" icon="branch" onPress={() => note('open the run graph tab')}>
          Open graph
        </Button>
        <Button size="sm" variant="outline" icon="edit" onPress={() => note('open the workflow in the builder tab')}>
          Open workflow in builder
        </Button>
        {run.hasConversation ? (
          <Button size="sm" variant="outline" icon="bot" onPress={() => note('switch to Chat on this run’s conversation')}>
            Open conversation
          </Button>
        ) : null}
      </Row>
      </Stack>
      ) : null}
      <Tabs label="Run contents" value={read(tab)} onChange={(value) => setTab(value as RunTab)}>
        <Tab value="steps" label="Steps">
          {Steps(run)}
        </Tab>
        <Tab value="artifacts" label="Artifacts">
          {Artifacts()}
        </Tab>
      </Tabs>
    </Stack>
  )
}

const ITEM_COLUMNS: TableColumn[] = [
  { key: 'item', label: 'Item', minWidth: 'sm' },
  { key: 'kind', label: 'Kind', width: 'sm', hideBelow: 'sm' },
  { key: 'at', label: 'At', width: 'xs', align: 'end' }
]

/** Newest first. A divider row, which cannot be selected, marks where each attempt starts. */
function activityRows(): TableRow[] {
  const rows: TableRow[] = []
  for (const row of [...read(activity).rows].reverse()) {
    rows.push({
      key: row.key,
      cells: { item: `${KIND[row.kind].glyph} ${row.title}`, kind: row.state ? `${KIND[row.kind].word}, ${row.state}` : KIND[row.kind].word, at: clock(row.at) }
    })
    if (row.firstOfAttempt) {
      rows.push({ key: `attempt-${row.attempt}`, disabled: true, cells: { item: `── Attempt ${row.attempt} started`, kind: '', at: clock(row.at) } })
    }
  }
  return rows
}

export function StepViewA(run: RunDetail, view: StepView) {
  const { rows, earlier, loading } = read(activity)
  const preview = read(item)
  const chosen = read(itemKey)
  const { step } = view
  return (
    <Stack gap="sm">
      {read(focus) === 'all' ? (
      <Stack gap="sm">
      <Row>
        <Button size="sm" variant="ghost" onPress={backToRun}>
          {'‹'} Back to run
        </Button>
      </Row>
      <Heading level={2}>{step.name}</Heading>
      <Text muted size="xs">
        {[`Step ${view.index} of ${view.total} in ${run.workflow}`, ...marks(step)].join(' · ')}
      </Text>
      <KeyValue label="Step facts" items={stepFacts(view)} />
      {view.error ? (
        <Callout tone="danger" title="This step failed">
          <Code block>{view.error}</Code>
        </Callout>
      ) : null}

      <Heading level={3}>Output</Heading>
      {view.output.length === 0 ? (
        <Text muted size="sm">
          {step.state === 'running' ? 'No output yet.' : 'This step has no output.'}
        </Text>
      ) : (
        view.output.map((block, index) => <CodeView key={`o${index}`} label={view.output.length > 1 ? `Output, part ${index + 1} of ${view.output.length}` : 'Output'} code={block} wrap maxHeight="sm" />)
      )}
      {view.outputCut ? (
        <Text muted size="xs">
          The output is {bytes(view.outputBytes)}. The first 256 KB are shown.
        </Text>
      ) : null}
      </Stack>
      ) : null}

      <Heading level={3}>Activity</Heading>
      {view.items === 0 ? (
        <Text muted size="sm">
          {step.kind === 'prompt' ? 'No agent activity.' : `A ${step.kind} step has no agent activity.`}
        </Text>
      ) : (
        <Stack gap="xs">
          {read(focus) === 'preview' ? null : (
          <Table
            label="Activity, newest first"
            columns={ITEM_COLUMNS}
            rows={activityRows()}
            selectionMode="single"
            selected={chosen ? [chosen] : []}
            hasMore={earlier > 0}
            loading={loading}
            maxHeight="lg"
            onSelectionChange={({ keys }) => void pickItem(keys[0] ?? null)}
            onLoadMore={() => void showEarlier()}
          />
          )}
          <Text muted size="xs">
            Newest first. {rows.length} of {view.items} items loaded{earlier > 0 ? '; scroll to the end for earlier ones' : ''}. {hiddenLine(view)}
          </Text>
          {preview ? <Card title={preview.title.slice(0, 120)}>{ItemBody(preview)}</Card> : null}
        </Stack>
      )}
    </Stack>
  )
}
