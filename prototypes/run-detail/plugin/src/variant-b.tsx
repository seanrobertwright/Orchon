// PROTOTYPE, variant B: cards and lists, closest to Archon's console. A breadcrumb is the way
// back, facts are one wrapped line in a header card, the Steps and Artifacts switch is a pair
// of buttons, and steps and activity are lists of rows with badges. A loop's inner steps are an
// indented list of their own. Activity reads oldest to newest with Show earlier on top.
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Collapsible,
  Heading,
  Input,
  Link,
  List,
  ListItem,
  read,
  RelativeTime,
  Row,
  Stack,
  Text
} from 'orca'
import type { ItemRow, RunDetail, StepRow, StepView } from './protocol'
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
  pickItem,
  setFilter,
  setTab,
  showEarlier,
  tab
} from './state'
import { ActionRow, AnswerBlock, ArtifactBodyView, bytes, clock, duration, hiddenLine, ItemBody, KIND, marks, STATE, StateBadge, took } from './shared'

function Crumbs(run: RunDetail, step: StepRow | null) {
  return (
    <Text size="sm">
      <Link onPress={goRuns}>Runs</Link> {'›'} {step ? <Link onPress={backToRun}>{run.workflow}</Link> : run.workflow}
      {step ? ` › ${step.parent ? `${step.parent} › ` : ''}${step.name}` : ''}
    </Text>
  )
}

function StepItem(step: StepRow) {
  return (
    <ListItem key={step.id} title={step.name} description={[took(step), ...marks(step).filter((mark) => mark.startsWith('ran'))].filter(Boolean).join(' · ')} onPress={() => goStep(step.id)}>
      {StateBadge(step.state)}
    </ListItem>
  )
}

/** Top-level steps are one list each side of a loop; the loop's inner steps sit indented under it. */
function Steps(run: RunDetail) {
  const groups: { key: string; inner: boolean; steps: StepRow[] }[] = []
  for (const step of run.steps) {
    const inner = step.parent !== null
    const last = groups[groups.length - 1]
    if (last && last.inner === inner) last.steps.push(step)
    else groups.push({ key: step.id, inner, steps: [step] })
  }
  return (
    <Stack gap="xs">
      {groups.map((group) =>
        group.inner ? (
          <Box key={group.key} paddingX="md">
            <List label={`Inner steps of ${group.steps[0]?.parent}`}>{group.steps.map(StepItem)}</List>
          </Box>
        ) : (
          <List key={group.key} label="Steps">
            {group.steps.map(StepItem)}
          </List>
        )
      )}
    </Stack>
  )
}

function Artifacts() {
  const list = read(artifacts)
  const body = read(artifact)
  const chosen = read(artifactPath)
  return (
    <Stack gap="sm">
      <Input label="Filter files by name" labelHidden type="search" placeholder="Filter files by name" value={read(filter)} onChange={setFilter} />
      {list ? (
        <Text muted size="xs">
          {list.matching.toLocaleString('en-US')} of {list.total.toLocaleString('en-US')} files
          {list.matching > list.rows.length ? `, first ${list.rows.length} shown` : ''}
        </Text>
      ) : null}
      {read(focus) === 'preview' ? null : (
      <Box scroll="y" maxHeight={260} border radius="md">
        <List label="Artifacts">
          {(list?.rows ?? []).map((file) => (
            <ListItem key={file.path} title={file.path} icon="file" current={file.path === chosen} onPress={() => void pickArtifact(file.path)}>
              <Text muted size="xs">
                {bytes(file.size)} {'·'} <RelativeTime at={file.modifiedAt} format="short" />
              </Text>
            </ListItem>
          ))}
        </List>
      </Box>
      )}
      {body ? (
        <Card title={body.path} description={bytes(body.size)}>
          {ArtifactBodyView(body)}
        </Card>
      ) : null}
    </Stack>
  )
}

export function RunDetailB(run: RunDetail) {
  const current = read(tab)
  return (
    <Stack gap="sm">
      {read(focus) === 'all' ? (
      <Stack gap="sm">
      {Crumbs(run, null)}
      {AnswerBlock(run)}
      {ActionRow(run)}
      <Card title={run.workflow}>
        <Stack gap="xs">
          <Row gap="xs" align="center" wrap>
            <Badge tone={STATE[run.status].tone}>{run.status === 'paused' ? 'Paused' : STATE[run.status].word}</Badge>
            <Text muted size="xs">
              {run.project} {'·'} started <RelativeTime at={run.startedAt} format="short" /> {'·'}{' '}
              {run.endedAt ? duration(run.endedAt - run.startedAt) : 'still going'} {'·'} ${run.costUsd.toFixed(2)} {'·'} {run.id.slice(0, 8)}
            </Text>
          </Row>
          <Text muted size="xs">
            Worktree removed: {run.worktree}
          </Text>
        </Stack>
      </Card>
      <Collapsible title="Launch message" description={`${run.message.slice(0, 70)}…`}>
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
      <Row gap="xs">
        <Button size="sm" variant={current === 'steps' ? 'solid' : 'outline'} onPress={() => setTab('steps')}>
          Steps ({run.steps.length})
        </Button>
        <Button size="sm" variant={current === 'artifacts' ? 'solid' : 'outline'} onPress={() => setTab('artifacts')}>
          Artifacts
        </Button>
      </Row>
      {current === 'steps' ? Steps(run) : Artifacts()}
    </Stack>
  )
}

function ActivityItem(row: ItemRow, chosen: string | null) {
  return (
    <ListItem
      key={row.key}
      title={row.title}
      description={[clock(row.at), KIND[row.kind].word, row.state].filter(Boolean).join(' · ')}
      icon={KIND[row.kind].icon}
      current={row.key === chosen}
      onPress={() => void pickItem(row.key)}
    />
  )
}

/** One list per attempt, oldest first, each under a line saying when the attempt started. */
function ActivityLists(rows: ItemRow[], chosen: string | null) {
  const groups: ItemRow[][] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && !row.firstOfAttempt) last.push(row)
    else groups.push([row])
  }
  return groups.map((group) => {
    const first = group[0] as ItemRow
    return (
      <Stack key={first.key} gap="xs">
        <Text muted size="xs" weight="semibold">
          {first.firstOfAttempt ? `Attempt ${first.attempt} started ${clock(first.at)}` : `Attempt ${first.attempt}, continued`}
        </Text>
        <List label={`Attempt ${first.attempt}`}>{group.map((row) => ActivityItem(row, chosen))}</List>
      </Stack>
    )
  })
}

export function StepViewB(run: RunDetail, view: StepView) {
  const { rows, earlier, loading } = read(activity)
  const preview = read(item)
  const { step } = view
  const facts = [
    took(step),
    view.costUsd !== null ? `$${view.costUsd.toFixed(2)}` : '',
    view.turns !== null ? `${view.turns} turns` : '',
    view.model ? `${view.model} (${view.provider})` : '',
    view.tokensIn !== null && view.tokensOut !== null ? `${view.tokensIn.toLocaleString('en-US')} in, ${view.tokensOut.toLocaleString('en-US')} out` : '',
    view.stopReason ? `stopped: ${view.stopReason}` : ''
  ].filter(Boolean)
  return (
    <Stack gap="sm">
      {read(focus) === 'all' ? (
      <Stack gap="sm">
      {Crumbs(run, step)}
      <Card title={step.name} description={[`${step.kind} step`, ...marks(step)].join(' · ')}>
        <Stack gap="xs">
          <Row gap="xs" align="center" wrap>
            {StateBadge(step.state)}
            <Text muted size="xs">
              {facts.join(' · ')}
            </Text>
          </Row>
          {step.startedAt !== null ? (
            <Text muted size="xs">
              {clock(step.startedAt)} to {step.endedAt !== null ? clock(step.endedAt) : 'now'}
            </Text>
          ) : null}
          {view.skipReason ? <Text size="sm">{view.skipReason}</Text> : null}
        </Stack>
      </Card>
      {view.error ? (
        <Callout tone="danger" title="This step failed">
          <Code block>{view.error}</Code>
        </Callout>
      ) : null}

      <Collapsible title="Output" description={view.output.length === 0 ? 'none' : bytes(view.outputBytes)} defaultOpen={view.output.length > 0}>
        <Stack gap="xs">
          <Box scroll="y" maxHeight={220} border radius="md" padding="xs">
            {view.output.map((block, index) => (
              <Code key={`o${index}`} block>
                {block}
              </Code>
            ))}
          </Box>
          {view.outputCut ? (
            <Text muted size="xs">
              The first 256 KB are shown.
            </Text>
          ) : null}
        </Stack>
      </Collapsible>
      </Stack>
      ) : null}

      <Row justify="between" align="center">
        <Heading level={3}>Activity</Heading>
        <Text muted size="xs">
          {rows.length} of {view.items} items
        </Text>
      </Row>
      {view.items === 0 ? (
        <Text muted size="sm">
          {step.kind === 'prompt' ? 'No agent activity.' : `A ${step.kind} step has no agent activity.`}
        </Text>
      ) : (
        <Stack gap="xs">
          {earlier > 0 ? (
            <Row>
              <Button size="sm" variant="outline" disabled={loading} onPress={() => void showEarlier()}>
                Show earlier ({earlier} more)
              </Button>
            </Row>
          ) : null}
          {read(focus) === 'preview' ? null : (
          <Box scroll="y" maxHeight={360} border radius="md" padding="xs">
            <Stack gap="sm">{ActivityLists(rows, read(itemKey))}</Stack>
          </Box>
          )}
          {hiddenLine(view) ? (
            <Text muted size="xs">
              {hiddenLine(view)}
            </Text>
          ) : null}
          {preview ? <Card title={preview.title.slice(0, 120)}>{ItemBody(preview)}</Card> : null}
        </Stack>
      )}
    </Stack>
  )
}
