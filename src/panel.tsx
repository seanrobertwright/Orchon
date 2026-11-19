// The one sidebar panel. Orca draws it with its own components: no DOM, and state lives in atoms.
import { atom, EmptyState, plugin, read, set, Stack, Tab, Tabs, update, type OrcaNode, type PanelContext } from 'orca'
import type { Connected, ConnectionAnswer, ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { now } from './dates'
import { clearRuns, restartRuns, runsHaveData, runsSection, startRunsSection } from './runs-section'
import { DEFAULT_SECTION, parseSection, SECTIONS, type SectionId } from './sections'
import { settingsSection } from './settings-section'
import { stateScreen, type StateScreenActions } from './state-screen'
import type { SystemView } from './system-view'
import { createViewFetch, nextTrouble, SAFETY_REFETCH_MS, type ViewFetch, type WorkerTrouble } from './view-fetch'
import { frameTimers, searchingBanner, troubleLine } from './view-notices'

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

/**
 * The last Connected state, kept through every other state: Searching draws the data it loaded
 * under its banner, and a return with another store id clears what the sections held.
 */
const lastConnected = atom<Connected | null>(null)

/** Keeps the newest state: an answer and a post can arrive in either order. */
function keepNewest(next: ConnectionView): void {
  const held = read(connection)
  if (held !== null && next.since <= held.since) return
  if (next.kind === 'connected') {
    const before = read(lastConnected)
    if (before !== null && before.storeId !== next.storeId) clearRuns()
    set(lastConnected, next)
  }
  set(connection, next)
  // On return to Connected every view that is showing fetches again.
  if (next.kind === 'connected' && held?.kind !== 'connected') restartRuns()
}

/** Worker unreachable for the connection reads: null while the worker answers them. */
const connectionTrouble = atom<WorkerTrouble | null>(null)

/** The connection read's fetch rules for this panel run: it is a view like any other. */
let connectionFetch: ViewFetch | undefined

/** Reads the connection state again at once: the "Try again" of Worker unreachable. */
function readConnection(): void {
  connectionFetch?.restart()
}

/** "Try again" on a state screen. Its failure is Worker unreachable, like a failed read. */
function retryConnection(): void {
  plugin.request('connection.retry').then(
    (answer) => {
      set(connectionTrouble, null)
      keepNewest(answer.connection)
    },
    (error: unknown) => update(connectionTrouble, (held) => nextTrouble(held, error))
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
  if (next === 'runs') restartRuns()
  if (before === next) return
  if (next === 'settings') askSystem('system.open')
  if (before === 'settings') closeSystem()
}

/** The least time between two connection reads that no person asked for. */
const CONNECTION_GAP_MS = 1_000

const actions: StateScreenActions = {
  tryAgain: retryConnection,
  openSettings: () => show('settings')
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  startRunsSection(ctx, {
    connection: () => read(connection),
    showing: () => parseSection(read(section)) === 'runs',
    keep: keepNewest
  })
  ctx.subscriptions.push(plugin.on('show-runs', () => show('runs')))
  ctx.subscriptions.push(plugin.on('connection.changed', keepNewest))
  ctx.subscriptions.push(plugin.on('system.changed', keepSystem))
  // The first read, then one on the safety refetch: a worker that did not answer is tried again.
  const fetch = createViewFetch<ConnectionAnswer>({
    load: (signal) => plugin.request('connection.read', undefined, { signal }),
    apply(answer) {
      set(connectionTrouble, null)
      keepNewest(answer.connection)
    },
    fail(_error, trouble) {
      if (trouble !== null) set(connectionTrouble, trouble)
    },
    minGapMs: CONNECTION_GAP_MS,
    safetyMs: SAFETY_REFETCH_MS,
    now,
    timers: frameTimers
  })
  connectionFetch = fetch
  ctx.subscriptions.push({
    dispose() {
      fetch.stop()
      if (connectionFetch === fetch) connectionFetch = undefined
    }
  })
  fetch.restart()
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
  // Searching keeps what a section loaded on screen, under the banner, with nothing that writes.
  const kept = read(lastConnected)
  if (id === 'runs' && state?.kind === 'searching' && kept !== null && runsHaveData()) {
    return (
      <Stack gap="sm">
        {searchingBanner(state.since)}
        {runsSection(kept)}
      </Stack>
    )
  }
  const screen = stateScreen(state, actions)
  if (screen !== null || state?.kind !== 'connected') return screen
  return id === 'runs' ? runsSection(state) : placeholder
}

/**
 * A section's body under the Worker unreachable line of the connection reads, when it has one.
 * With no state known a data section has nothing else to show, and Settings keeps its Connection
 * group. Once a state is known the Runs section says it in its own view, so it is said once.
 */
function withTrouble(id: SectionId, body: OrcaNode, state: ConnectionView | null): OrcaNode {
  const trouble = read(connectionTrouble)
  if (trouble === null) return body
  const line = troubleLine(trouble, readConnection)
  if (state === null && id !== 'settings') return line
  if (state !== null && id === 'runs') return body
  return (
    <Stack gap="sm">
      {line}
      {body}
    </Stack>
  )
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
          {withTrouble(id, sectionBody(id, label, state), state)}
        </Tab>
      ))}
    </Tabs>
  )
}
