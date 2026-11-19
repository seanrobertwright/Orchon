// The one sidebar panel. Orca draws it with its own components: no DOM, and state lives in atoms.
import { atom, EmptyState, plugin, read, set, Stack, Tab, Tabs, Text, update, type OrcaNode, type PanelContext } from 'orca'
import { connectionGroup } from './connection-group'
import type { ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { runsSection, startRunsSection, type RunsSection } from './runs-section'
import { DEFAULT_SECTION, parseSection, SECTIONS, type SectionId } from './sections'
import { stateScreen, type StateScreenActions } from './state-screen'

/**
 * The section showing, kept per workspace because Orca unmounts a hidden panel. It is stored as
 * whatever was written, so it is parsed on every read.
 */
const section = atom<unknown>('section', DEFAULT_SECTION, { persist: 'workspace' })

/**
 * The connection state, which only the worker decides. It is null until the worker has answered.
 * It is not persisted: a panel that opens asks again.
 */
const connection = atom<ConnectionView | null>(null)

/** The Runs section's fetch rules, for this panel run. */
let runs: RunsSection | undefined

/** Keeps the newest state: an answer and a post can arrive in either order. */
function keepNewest(next: ConnectionView): void {
  const held = read(connection)
  update(connection, (current) => (current === null || next.since > current.since ? next : current))
  // On return to Connected every view that is showing fetches again.
  if (next.kind === 'connected' && held?.kind !== 'connected' && (held === null || next.since > held.since)) runs?.restart()
}

/** Shows a section. Coming back to Runs always reads the table again. */
function show(id: SectionId): void {
  set(section, id)
  if (id === 'runs') runs?.restart()
}

/** Sends a connection request and keeps the state its answer carries. A failed request changes nothing. */
function ask(name: 'connection.read' | 'connection.retry'): void {
  plugin.request(name).then(
    (answer) => keepNewest(answer.connection),
    () => {}
  )
}

const actions: StateScreenActions = {
  tryAgain: () => ask('connection.retry'),
  openSettings: () => set(section, 'settings')
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  runs = startRunsSection(ctx, {
    connection: () => read(connection),
    showing: () => parseSection(read(section)) === 'runs',
    keep: keepNewest
  })
  ctx.subscriptions.push(plugin.on('show-runs', () => show('runs')))
  ctx.subscriptions.push(plugin.on('connection.changed', keepNewest))
  ask('connection.read')
}

/** What one section shows below the section bar. */
function sectionBody(id: SectionId, label: string, state: ConnectionView | null): OrcaNode {
  const placeholder = <EmptyState title={label} description="This section is not built yet." />
  if (id === 'settings') {
    return (
      <Stack gap="md">
        {connectionGroup(state)}
        {state?.kind === 'connected' ? placeholder : <Text>Archon's settings appear here when Orchon is connected.</Text>}
      </Stack>
    )
  }
  // Without its paths the Metrics section says which release it needs, and asks Archon nothing.
  if (id === 'metrics' && state?.kind === 'connected' && !state.features.metrics) {
    return <EmptyState title={label} description={metricsMissing(state)} />
  }
  const screen = stateScreen(state, actions)
  if (screen !== null || state?.kind !== 'connected') return screen
  return id === 'runs' ? runsSection(state) : placeholder
}

export default function Panel() {
  const state = read(connection)
  return (
    <Tabs
      label="Orchon sections"
      value={parseSection(read(section))}
      onChange={(value) => show(parseSection(value))}
    >
      {SECTIONS.map(({ id, label }) => (
        <Tab key={id} value={id} label={label}>
          {sectionBody(id, label, state)}
        </Tab>
      ))}
    </Tabs>
  )
}
