// PROTOTYPE. Three variants of the Orchon runs view inside one components panel, switched from
// the bar at the top. The section bar, the scope switch and the unmatched-project notice are
// the chrome every variant sits in; only the part under them changes.
import {
  atom,
  Box,
  Button,
  Callout,
  EmptyState,
  plugin,
  RadioGroup,
  read,
  Row,
  Select,
  set,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { Scenario, Scope } from './protocol'
import {
  attention,
  filter,
  lastAction,
  meta,
  note,
  openRun,
  page,
  picked,
  reload,
  scenario,
  scope,
  section,
  setScenario,
  setScope,
  variant,
  VARIANTS
} from './state'
import { RunDetailStub } from './shared'
import { VariantA } from './variant-a'
import { VariantB } from './variant-b'
import { VariantC } from './variant-c'

const tabIcons = atom('proto.tabIcons', true)

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('proto.set', (remote) => {
      if (remote.variant) set(variant, remote.variant)
      if (remote.scenario) set(scenario, remote.scenario)
      if (remote.scope) set(scope, remote.scope)
      if (remote.filter) set(filter, remote.filter)
      set(openRun, null)
      if (remote.tabIcons !== undefined) set(tabIcons, remote.tabIcons)
      void reload().then(() => {
        const run = read(attention)[0] ?? read(page).rows[0] ?? null
        if (remote.detail) set(openRun, run)
        if (remote.pick) set(picked, run)
      })
    })
  )
  void reload()
}

function cycle(by: number): void {
  const index = VARIANTS.findIndex((entry) => entry.key === read(variant))
  const next = VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length]
  if (!next) return
  set(variant, next.key)
  set(filter, 'all')
  void reload()
}

/** Not part of the design being judged: flips the variant and the fixture. */
function Switcher() {
  const current = VARIANTS.find((entry) => entry.key === read(variant)) ?? VARIANTS[0]
  return (
    <Box border="accent" background="muted" padding="xs" radius="md">
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Button size="xs" variant="outline" onPress={() => cycle(-1)}>
            ‹ Prev
          </Button>
          <Text size="xs" weight="semibold">
            PROTOTYPE {current?.key}: {current?.name}
          </Text>
          <Button size="xs" variant="outline" onPress={() => cycle(1)}>
            Next ›
          </Button>
        </Row>
        <Select
          label="Fixture"
          labelHidden
          value={read(scenario)}
          options={[
            { value: 'matched', label: 'Fixture: project matched, 353 runs' },
            { value: 'unmatched', label: 'Fixture: project not known to Archon' },
            { value: 'empty', label: 'Fixture: no runs yet' }
          ]}
          onChange={(value) => setScenario(value as Scenario)}
        />
      </Stack>
    </Box>
  )
}

function RunsSection() {
  const run = read(openRun)
  if (run) return RunDetailStub(run)
  const { matchedProject, counts } = read(meta)
  const which = read(variant)
  const empty = counts !== null && counts.all === 0

  return (
    <Stack gap="sm">
      <RadioGroup
        label="Runs shown"
        labelHidden
        orientation="horizontal"
        value={matchedProject ? read(scope) : 'all'}
        options={[
          { value: 'project', label: 'This project', description: matchedProject ?? undefined, disabled: !matchedProject },
          { value: 'all', label: 'All projects' }
        ]}
        onChange={(value) => setScope(value as Scope)}
      />
      {counts !== null && !matchedProject ? (
        <Callout tone="warning" title="This Orca project is not known to Archon">
          <Stack gap="xs">
            <Text size="sm">Runs from every project are shown. Launching from here is off until the project is linked.</Text>
            <Row gap="xs" wrap>
              <Button size="sm" variant="outline" icon="link" onPress={() => note('link to an existing Archon project')}>
                Link to an existing Archon project
              </Button>
              <Button size="sm" variant="outline" icon="add" onPress={() => note('register with Archon')}>
                Register with Archon
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {empty ? (
        <EmptyState title="No runs yet" description="Runs started from Launch, the CLI or Archon's console show up here." icon="activity" />
      ) : which === 'A' ? (
        VariantA()
      ) : which === 'B' ? (
        VariantB()
      ) : (
        VariantC()
      )}
    </Stack>
  )
}

function Elsewhere(name: string) {
  return <EmptyState title={name} description="Not part of this prototype." icon="blocks" />
}

export default function Panel() {
  const { rows, total } = read(page)
  const icons = read(tabIcons)
  return (
    <Stack gap="sm">
      {Switcher()}
      <Tabs label="Orchon sections" value={read(section)} onChange={(value) => set(section, value)}>
        <Tab value="runs" label="Runs" icon={icons ? 'activity' : undefined}>
          {RunsSection()}
        </Tab>
        <Tab value="launch" label="Launch" icon={icons ? 'rocket' : undefined}>
          {Elsewhere('Launch')}
        </Tab>
        <Tab value="chat" label="Chat" icon={icons ? 'bot' : undefined}>
          {Elsewhere('Chat')}
        </Tab>
        <Tab value="metrics" label="Metrics" icon={icons ? 'bar-chart-3' : undefined}>
          {Elsewhere('Metrics')}
        </Tab>
        <Tab value="settings" label="Settings" icon={icons ? 'settings' : undefined}>
          {Elsewhere('Settings')}
        </Tab>
      </Tabs>
      <Text muted size="xs">
        State: variant {read(variant)} · fixture {read(scenario)} · scope {read(scope)} · filter {read(filter)} ·{' '}
        {rows.length}/{total} loaded · last press: {read(lastAction)}
      </Text>
    </Stack>
  )
}
