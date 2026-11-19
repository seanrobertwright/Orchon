// The one sidebar panel. Orca draws it with its own components: no DOM, and state lives in atoms.
import { atom, EmptyState, plugin, read, set, Tab, Tabs, update, type OrcaNode, type PanelContext } from 'orca'
import type { ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { rescopeRuns, restartRuns, runsSection, startRunsSection } from './runs-section'
import { restartScope, startScope } from './scope-section'
import { DEFAULT_SECTION, parseSection, SECTIONS, type SectionId } from './sections'
import { settingsSection } from './settings-section'
import { stateScreen, type StateScreenActions } from './state-screen'
import type { SystemView } from './system-view'

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

/** Keeps the newest state: an answer and a post can arrive in either order. */
function keepNewest(next: ConnectionView): void {
  const held = read(connection)
  if (held !== null && next.since <= held.since) return
  set(connection, next)
  // On return to Connected every view that is showing fetches again.
  if (next.kind === 'connected' && held?.kind !== 'connected') {
    restartScope()
    restartRuns()
  }
}

/** Sends a connection request and keeps the state its answer carries. A failed request changes nothing. */
function ask(name: 'connection.read' | 'connection.retry'): void {
  plugin.request(name).then(
    (answer) => keepNewest(answer.connection),
    () => {}
  )
}

/** The System group, which the worker reads while the Settings section shows. Null until it answers. */
const system = atom<SystemView | null>(null)

/** Keeps the newest System view: an answer and a post can arrive in either order. */
function keepSystem(next: SystemView): void {
  update(system, (held) => (held === null || next.since > held.since ? next : held))
}

/** Sends a System request and keeps what its answer carries. A failed request changes nothing. */
function askSystem(name: 'system.open' | 'system.refresh'): void {
  plugin.request(name).then(
    (answer) => {
      keepNewest(answer.connection)
      keepSystem(answer.system)
    },
    () => {}
  )
}

/** Tells the worker the Settings section no longer shows. */
function closeSystem(): void {
  plugin.request('system.close').then(
    () => {},
    () => {}
  )
}

/**
 * Shows a section. Coming back to Runs always reads the table again, and the worker is told when
 * the Settings section begins or stops showing.
 */
function show(next: SectionId): void {
  const before = parseSection(read(section))
  set(section, next)
  if (next === 'runs') {
    restartScope()
    restartRuns()
  }
  if (before === next) return
  if (next === 'settings') askSystem('system.open')
  if (before === 'settings') closeSystem()
}

const actions: StateScreenActions = {
  tryAgain: () => ask('connection.retry'),
  openSettings: () => show('settings')
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  startRunsSection(ctx, {
    connection: () => read(connection),
    showing: () => parseSection(read(section)) === 'runs',
    keep: keepNewest
  })
  startScope(ctx, {
    connection: () => read(connection),
    showing: () => parseSection(read(section)) === 'runs',
    keep: keepNewest,
    changed: rescopeRuns
  })
  ctx.subscriptions.push(plugin.on('show-runs', () => show('runs')))
  ctx.subscriptions.push(plugin.on('connection.changed', keepNewest))
  ctx.subscriptions.push(plugin.on('system.changed', keepSystem))
  ask('connection.read')
  // Orca unmounts a hidden panel, so the Settings section shows from setup until it is left or
  // the panel closes.
  if (parseSection(read(section)) === 'settings') askSystem('system.open')
  ctx.subscriptions.push({
    dispose: () => {
      if (parseSection(read(section)) === 'settings') closeSystem()
    }
  })
}

/** What one section shows below the section bar. */
function sectionBody(id: SectionId, label: string, state: ConnectionView | null): OrcaNode {
  const placeholder = <EmptyState title={label} description="This section is not built yet." />
  if (id === 'settings') return settingsSection(state, read(system), { refresh: () => askSystem('system.refresh') })
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
