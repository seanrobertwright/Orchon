// PROTOTYPE. Three variants of Orchon's run detail and step view inside one components panel,
// switched from the bar at the top. The section bar and the runs table are the chrome decided
// earlier; everything from run detail down changes with the variant.
import {
  Box,
  Button,
  Card,
  EmptyState,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Table,
  Text,
  type PanelContext
} from 'orca'
import type { Remote, Scenario } from './protocol'
import {
  artifactPath,
  filter,
  focus,
  goRun,
  goRuns,
  itemKey,
  lastAction,
  openRun,
  openStep,
  pickedRun,
  restore,
  run,
  section,
  showEarlier,
  split,
  stepView,
  tab,
  variant,
  VARIANTS
} from './state'
import { RunDetailA, StepViewA } from './variant-a'
import { RunDetailB, StepViewB } from './variant-b'
import { RunDetailC, StepViewC } from './variant-c'

/** A capture setup says where the panel is; whatever it leaves out goes back to its default. */
function apply(remote: Remote): void {
  if (remote.variant) set(variant, remote.variant)
  set(openRun, remote.run ?? null)
  set(openStep, remote.step ?? null)
  set(tab, remote.tab ?? 'steps')
  set(itemKey, remote.item ?? null)
  set(filter, remote.filter ?? '')
  set(artifactPath, remote.artifact ?? null)
  set(split, remote.split ?? 'lines')
  set(focus, remote.focus ?? 'all')
  void restore().then(async () => {
    for (let page = 0; page < (remote.earlier ?? 0); page++) await showEarlier()
  })
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('proto.set', apply))
  void plugin.request('proto.get').then((remote) => (remote ? apply(remote) : void restore()))
}

function cycle(by: number): void {
  const index = VARIANTS.findIndex((entry) => entry.key === read(variant))
  const next = VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length]
  if (next) set(variant, next.key)
}

/** Not part of the design being judged: flips the variant. */
function Switcher() {
  const current = VARIANTS.find((entry) => entry.key === read(variant)) ?? VARIANTS[0]
  return (
    <Box border="accent" background="muted" padding="xs" radius="md">
      <Row justify="between" align="center">
        <Button size="xs" variant="outline" onPress={() => cycle(-1)}>
          {'‹'} Prev
        </Button>
        <Text size="xs" weight="semibold">
          PROTOTYPE {current?.key}: {current?.name}
        </Text>
        <Button size="xs" variant="outline" onPress={() => cycle(1)}>
          Next {'›'}
        </Button>
      </Row>
    </Box>
  )
}

const RUNS: { key: Scenario; run: string; status: string; ago: number }[] = [
  { key: 'paused', run: '! archon-fix-github-issue', status: 'Needs you', ago: 58 },
  { key: 'running', run: '● archon-fix-github-issue', status: 'Running', ago: 40 },
  { key: 'failed', run: '✕ archon-fix-github-issue', status: 'Failed', ago: 228 },
  { key: 'completed', run: '✓ archon-fix-github-issue', status: 'Completed', ago: 240 }
]

/** The runs table as decided earlier, cut down to four runs: one per state this prototype shows. */
function RunsTable() {
  const chosen = read(pickedRun)
  return (
    <Stack gap="sm">
      <Table
        label="Runs"
        columns={[
          { key: 'run', label: 'Run', minWidth: 'xs' },
          { key: 'status', label: 'Status', width: 'sm', hideBelow: 'sm' },
          { key: 'started', label: 'Started', width: 'xs', align: 'end' }
        ]}
        rows={RUNS.map((row) => ({
          key: row.key,
          cells: { run: row.run, status: row.status, started: { type: 'relative', at: Date.now() - row.ago * 60_000, format: 'short' } }
        }))}
        selectionMode="single"
        selected={chosen ? [chosen] : []}
        onSelectionChange={({ keys }) => set(pickedRun, (keys[0] as Scenario | undefined) ?? null)}
        onRowAction={({ key }) => goRun(key as Scenario)}
      />
      <Text muted size="xs">
        4 of 4 loaded. Enter or a double click opens a run.
      </Text>
      {chosen ? (
        <Card title="archon-fix-github-issue" description="Fix issue #412: the setup wizard marks setup complete before the admin account is written">
          <Row>
            <Button size="sm" onPress={() => goRun(chosen)}>
              Open run
            </Button>
          </Row>
        </Card>
      ) : null}
    </Stack>
  )
}

function RunsSection() {
  if (!read(openRun)) return RunsTable()
  const detail = read(run)
  if (!detail) return <Spinner label="Loading the run" />
  const which = read(variant)
  if (read(openStep)) {
    const view = read(stepView)
    if (!view) {
      return (
        <Stack gap="sm">
          <Row>
            <Button size="sm" variant="ghost" onPress={goRuns}>
              {'‹'} Back to runs
            </Button>
          </Row>
          <Spinner label="Loading the step" />
        </Stack>
      )
    }
    return which === 'A' ? StepViewA(detail, view) : which === 'B' ? StepViewB(detail, view) : StepViewC(detail, view)
  }
  return which === 'A' ? RunDetailA(detail) : which === 'B' ? RunDetailB(detail) : RunDetailC(detail)
}

function Elsewhere(name: string) {
  return <EmptyState title={name} description="Not part of this prototype." icon="blocks" />
}

export default function Panel() {
  return (
    <Stack gap="sm">
      {Switcher()}
      <Tabs label="Orchon sections" value={read(section)} onChange={(value) => set(section, value)}>
        <Tab value="runs" label="Runs">
          {RunsSection()}
        </Tab>
        <Tab value="launch" label="Launch">
          {Elsewhere('Launch')}
        </Tab>
        <Tab value="workflows" label="Workflows">
          {Elsewhere('Workflows')}
        </Tab>
        <Tab value="chat" label="Chat">
          {Elsewhere('Chat')}
        </Tab>
        <Tab value="metrics" label="Metrics">
          {Elsewhere('Metrics')}
        </Tab>
        <Tab value="settings" label="Settings">
          {Elsewhere('Settings')}
        </Tab>
      </Tabs>
      <Text muted size="xs">
        State: variant {read(variant)} {'·'} run {read(openRun) ?? 'none'} {'·'} step {read(openStep) ?? 'none'} {'·'} tab {read(tab)} {'·'} item{' '}
        {read(itemKey) ?? 'none'} {'·'} file {read(artifactPath) ?? 'none'} {'·'} cut {read(split)} {'-'} shown {read(focus)} {'·'} last press: {read(lastAction)}
      </Text>
    </Stack>
  )
}
