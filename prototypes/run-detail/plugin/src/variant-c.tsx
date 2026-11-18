// PROTOTYPE, variant C: an outline. The header is one compact bar, facts and the launch message
// fold away so the steps show without scrolling at 220 px, the Steps and Artifacts switch is a
// select, and steps, files and activity are trees: a loop holds its inner steps, a folder its
// files, an attempt its items. The step view adds Previous and Next, so moving between steps
// does not need a trip back to run detail.
import {
  Badge,
  Button,
  Callout,
  Code,
  Collapsible,
  Input,
  KeyValue,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Stack,
  Text,
  Tree,
  type TreeItem
} from 'orca'
import type { ArtifactRow, ItemRow, RunDetail, RunTab, StepRow, StepView } from './protocol'
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
import { ActionRow, AnswerBlock, ArtifactBodyView, bytes, clock, duration, hiddenLine, ItemBody, KIND, marks, runFacts, STATE, StateBadge, stepFacts, took } from './shared'

function stepItem(step: StepRow, all: StepRow[]): TreeItem {
  const inner = all.filter((entry) => entry.parent === step.id)
  const detail = [took(step), step.ran > 1 ? `ran ${step.ran} times` : ''].filter(Boolean).join(' · ')
  return {
    key: step.id,
    label: `${STATE[step.state].glyph} ${step.name}`,
    description: detail || undefined,
    children: inner.length > 0 ? inner.map((entry) => stepItem(entry, all)) : undefined
  }
}

/** Steps not yet reached fold into one branch, so a run that has just started stays short. */
function stepTree(run: RunDetail): TreeItem[] {
  const top = run.steps.filter((step) => step.parent === null)
  const reached = top.filter((step) => step.state !== 'pending')
  const pending = top.filter((step) => step.state === 'pending')
  const items = reached.map((step) => stepItem(step, run.steps))
  if (pending.length > 0) {
    items.push({ key: 'group:pending', label: `${STATE.pending.glyph} Not reached (${pending.length})`, children: pending.map((step) => stepItem(step, run.steps)) })
  }
  return items
}

function Steps(run: RunDetail) {
  const chosen = run.steps.find((step) => step.id === read(pickedStep)) ?? null
  const loops = run.steps.filter((step) => step.kind === 'loop').map((step) => step.id)
  const open = (key: string) => (key.startsWith('group:') ? undefined : goStep(key))
  return (
    <Stack gap="xs">
      <Tree
        label="Steps"
        items={stepTree(run)}
        selected={chosen?.id}
        defaultExpanded={loops}
        maxHeight="lg"
        onSelect={({ key }) => set(pickedStep, key.startsWith('group:') ? null : key)}
        onAction={({ key }) => open(key)}
      />
      {chosen ? (
        <Row gap="xs" align="center" wrap>
          {StateBadge(chosen.state)}
          <Text size="xs">{[chosen.name, chosen.kind, ...marks(chosen)].join(' · ')}</Text>
          <Button size="xs" onPress={() => goStep(chosen.id)}>
            Open step
          </Button>
        </Row>
      ) : (
        <Text muted size="xs">
          Select a step, then Enter or a double click opens it.
        </Text>
      )}
    </Stack>
  )
}

/** Files grouped by folder. A key is `dir:<path>` for a folder and the path for a file. */
function fileTree(rows: ArtifactRow[]): TreeItem[] {
  type Folder = { files: TreeItem[]; folders: Map<string, Folder> }
  const root: Folder = { files: [], folders: new Map() }
  for (const file of rows) {
    const parts = file.path.split('/')
    const name = parts.pop() as string
    let folder = root
    for (const part of parts) {
      let next = folder.folders.get(part)
      if (!next) {
        next = { files: [], folders: new Map() }
        folder.folders.set(part, next)
      }
      folder = next
    }
    folder.files.push({ key: file.path, label: name, description: bytes(file.size), icon: 'file' })
  }
  const count = (folder: Folder): number => folder.files.length + [...folder.folders.values()].reduce((sum, entry) => sum + count(entry), 0)
  const build = (folder: Folder, prefix: string): TreeItem[] => [
    ...[...folder.folders.entries()].map(([name, entry]) => ({
      key: `dir:${prefix}${name}`,
      label: name,
      description: `${count(entry)} files`,
      icon: 'folder' as const,
      children: build(entry, `${prefix}${name}/`)
    })),
    ...folder.files
  ]
  return build(root, '')
}

function Artifacts() {
  const list = read(artifacts)
  const body = read(artifact)
  return (
    <Stack gap="xs">
      <Input label="Filter files by name" labelHidden type="search" placeholder="Filter files by name" value={read(filter)} onChange={setFilter} />
      {read(focus) === 'preview' ? null : (
      <Tree
        label="Artifacts"
        items={fileTree(list?.rows ?? [])}
        selected={read(artifactPath) ?? undefined}
        maxHeight="md"
        onSelect={({ key }) => void pickArtifact(key.startsWith('dir:') ? null : key)}
      />
      )}
      {list ? (
        <Text muted size="xs">
          {list.matching.toLocaleString('en-US')} of {list.total.toLocaleString('en-US')} files
          {list.matching > list.rows.length ? `. Only the first ${list.rows.length} by path are in the tree; narrow the filter to reach the rest.` : '.'}
        </Text>
      ) : null}
      {body ? (
        <Stack gap="xs">
          <Text size="sm" weight="semibold">
            {body.path} <Text muted size="xs">{bytes(body.size)}</Text>
          </Text>
          {ArtifactBodyView(body)}
        </Stack>
      ) : null}
    </Stack>
  )
}

export function RunDetailC(run: RunDetail) {
  return (
    <Stack gap="sm">
      {read(focus) === 'all' ? (
      <Stack gap="sm">
      <Row justify="between" align="center" gap="xs">
        <Button size="xs" variant="ghost" onPress={goRuns}>
          {'‹'} Runs
        </Button>
        <Text size="sm" weight="semibold" truncate>
          {run.workflow}
        </Text>
        <Badge tone={STATE[run.status].tone}>{run.status === 'paused' ? 'Paused' : STATE[run.status].word}</Badge>
      </Row>
      {AnswerBlock(run)}
      {ActionRow(run)}
      <Collapsible
        title="Run facts"
        description={`${run.endedAt ? duration(run.endedAt - run.startedAt) : 'still going'} · $${run.costUsd.toFixed(2)} · ${run.project}`}
      >
        <Stack gap="xs">
          <KeyValue label="Run facts" items={runFacts(run)} />
          <Text muted size="xs">
            Started <RelativeTime at={run.startedAt} />. Worktree removed: {run.worktree}
          </Text>
        </Stack>
      </Collapsible>
      <Collapsible title="Launch message" description={`${run.message.slice(0, 60)}…`}>
        <Stack gap="xs">
          <Text size="sm">{run.message}</Text>
          {run.messageCut ? (
            <Text muted size="xs">
              The launch message is cut at 2,000 characters.
            </Text>
          ) : null}
        </Stack>
      </Collapsible>
      <Row gap="xs" wrap>
        <Button size="xs" variant="ghost" icon="branch" onPress={() => note('open the run graph tab')}>
          Open graph
        </Button>
        <Button size="xs" variant="ghost" icon="edit" onPress={() => note('open the workflow in the builder tab')}>
          Open workflow in builder
        </Button>
        {run.hasConversation ? (
          <Button size="xs" variant="ghost" icon="bot" onPress={() => note('switch to Chat on this run’s conversation')}>
            Open conversation
          </Button>
        ) : null}
      </Row>
      </Stack>
      ) : null}
      <Select
        label="Show"
        labelHidden
        value={read(tab)}
        options={[
          { value: 'steps', label: `Steps (${run.steps.length})` },
          { value: 'artifacts', label: 'Artifacts' }
        ]}
        onChange={(value) => setTab(value as RunTab)}
      />
      {read(tab) === 'steps' ? Steps(run) : Artifacts()}
    </Stack>
  )
}

/** Newest attempt first, and inside an attempt newest item first. Only loaded items are here. */
function activityTree(rows: ItemRow[]): { items: TreeItem[]; newest: string | null } {
  const byAttempt = new Map<number, ItemRow[]>()
  for (const row of [...rows].reverse()) {
    const list = byAttempt.get(row.attempt)
    if (list) list.push(row)
    else byAttempt.set(row.attempt, [row])
  }
  const items: TreeItem[] = [...byAttempt.entries()].map(([attempt, list]) => {
    const oldest = list[list.length - 1] as ItemRow
    return {
      key: `attempt:${attempt}`,
      label: `Attempt ${attempt}`,
      description: oldest.firstOfAttempt ? `started ${clock(oldest.at)} · ${list.length} items` : `${list.length} items loaded`,
      children: list.map((row) => ({
        key: row.key,
        label: row.title,
        description: [clock(row.at), row.state].filter(Boolean).join(' · '),
        icon: KIND[row.kind].icon
      }))
    }
  })
  return { items, newest: items[0]?.key ?? null }
}

export function StepViewC(run: RunDetail, view: StepView) {
  const { rows, earlier, loading } = read(activity)
  const preview = read(item)
  const { step } = view
  const tree = activityTree(rows)
  const summary = [took(step), view.costUsd !== null ? `$${view.costUsd.toFixed(2)}` : '', view.turns !== null ? `${view.turns} turns` : ''].filter(Boolean).join(' · ')
  return (
    <Stack gap="sm">
      {read(focus) === 'all' ? (
      <Stack gap="sm">
      <Row justify="between" align="center" gap="xs">
        <Button size="xs" variant="ghost" onPress={backToRun}>
          {'‹'} Run
        </Button>
        <Row gap="xs">
          <Button size="xs" variant="outline" disabled={!view.prev} onPress={() => (view.prev ? goStep(view.prev) : undefined)}>
            {'‹'} Previous
          </Button>
          <Button size="xs" variant="outline" disabled={!view.next} onPress={() => (view.next ? goStep(view.next) : undefined)}>
            Next {'›'}
          </Button>
        </Row>
      </Row>
      <Row gap="xs" align="center" wrap>
        <Text weight="semibold">{step.name}</Text>
        {StateBadge(step.state)}
      </Row>
      <Text muted size="xs">
        {[`Step ${view.index} of ${view.total} in ${run.workflow}`, ...marks(step)].join(' · ')}
      </Text>
      {view.error ? (
        <Callout tone="danger" title="This step failed">
          <Code block>{view.error}</Code>
        </Callout>
      ) : null}
      <Collapsible title="Facts" description={summary || step.kind}>
        <KeyValue label="Step facts" items={stepFacts(view)} />
      </Collapsible>
      <Collapsible title="Output" description={view.output.length === 0 ? 'none' : `${bytes(view.outputBytes)}${view.outputCut ? ', first 256 KB shown' : ''}`}>
        <Stack gap="xs">
          {view.output.map((block, index) => (
            <Code key={`o${index}`} block>
              {block}
            </Code>
          ))}
        </Stack>
      </Collapsible>
      </Stack>
      ) : null}
      <Collapsible title="Activity" description={view.items === 0 ? 'none' : `${view.items} items in ${view.attempts} ${view.attempts === 1 ? 'attempt' : 'attempts'}`} defaultOpen>
        {view.items === 0 ? (
          <Text muted size="sm">
            {step.kind === 'prompt' ? 'No agent activity.' : `A ${step.kind} step has no agent activity.`}
          </Text>
        ) : (
          <Stack gap="xs">
            {read(focus) === 'preview' ? null : (
            <Tree
              label="Activity, newest first"
              items={tree.items}
              selected={read(itemKey) ?? undefined}
              defaultExpanded={tree.newest ? [tree.newest] : []}
              maxHeight="lg"
              onSelect={({ key }) => void pickItem(key.startsWith('attempt:') ? null : key)}
            />
            )}
            <Row gap="xs" align="center" wrap>
              {earlier > 0 ? (
                <Button size="xs" variant="outline" disabled={loading} onPress={() => void showEarlier()}>
                  Show earlier ({earlier} more)
                </Button>
              ) : null}
              <Text muted size="xs">
                {rows.length} of {view.items} loaded. {hiddenLine(view)}
              </Text>
            </Row>
            {preview ? (
              <Stack gap="xs">
                <Text size="sm" weight="semibold">
                  {preview.title.slice(0, 120)}
                </Text>
                {ItemBody(preview)}
              </Stack>
            ) : null}
          </Stack>
        )}
      </Collapsible>
    </Stack>
  )
}
