// The one sidebar panel. Orca draws it with its own components: no DOM, and state lives in atoms.
import { atom, EmptyState, plugin, read, set, Stack, Tab, Tabs, update, type OrcaNode, type PanelContext } from 'orca'
import type { Connected, ConnectionView } from './connection-view'
import { metricsMissing } from './connection-words'
import { now } from './dates'
import { readForms, startFormGroups } from './form-groups'
import { clearLaunch, launchHasData, launchNotices, launchSection, openLaunch, rerunLaunch, restartLaunch, startLaunchSection } from './launch-section'
import { liveOffLine } from './live-line'
import { startNotificationsGroup } from './notifications-group'
import { hintRunDetail, openRunDetail, startRunDetail } from './run-detail-section'
import {
  clearRuns,
  hintRuns,
  refreshRuns,
  rescopeRuns,
  restartRuns,
  restartRunsView,
  runsHaveData,
  runsSection,
  showNeedsYou,
  startRunsSection
} from './runs-section'
import type { ConnectionReadAnswer, ShowRuns } from './hint-view'
import { scopedProjectId, scopeNotice, scopeSettled, startScope } from './scope-section'
import { DEFAULT_SECTION, parseSection, SECTIONS, type SectionId } from './sections'
import { settingsSection } from './settings-section'
import { stateScreen, type StateScreenActions } from './state-screen'
import type { SystemView } from './system-view'
import { frameTimers } from './frame-timers'
import { createViewFetch, nextTrouble, rejectionOf, SAFETY_REFETCH_MS, type ViewFetch, type WorkerTrouble } from './view-fetch'
import { dataViewBody, troubleLine, underLine, type DataView } from './view-notices'

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
    if (before !== null && before.storeId !== next.storeId) {
      clearRuns()
      clearLaunch()
    }
    set(lastConnected, next)
  }
  set(connection, next)
  if (next.kind !== 'connected') return
  // On return to Connected every view that is showing fetches again.
  if (held?.kind !== 'connected') {
    restartRunsView()
    // The section's own first read is sent when it shows, so only a return to Connected reads again.
    if (held !== null && parseSection(read(section)) === 'settings') readForms()
  } else if (held.live !== next.live) {
    // Only `live` changed: the next read sets the safety timer to the new wait.
    refreshRuns()
  }
}

/** Worker unreachable for the connection reads: null while the worker answers them. */
const connectionTrouble = atom<WorkerTrouble | null>(null)

/** The connection read's fetch rules for this panel run: it is a view like any other. */
let connectionFetch: ViewFetch | undefined

/** Reads the connection state again at once: the "Try again" of Worker unreachable. */
function readConnection(): void {
  connectionFetch?.restart()
}

/**
 * The press of "Orchon: Show runs" this workspace's panel last applied, kept because Orca unmounts
 * a hidden panel and the worker hands a remembered press to every connection read for a minute.
 */
const showRunsApplied = atom<unknown>('showRunsApplied', null, { persist: 'workspace' })

/**
 * A press of "Orchon: Show runs": shows Runs and, when runs needed you, the "Needs you" filter.
 * A press is applied once; one with no time, as an older worker posted, always shows Runs.
 */
function applyShowRuns(press: ShowRuns | null): void {
  if (press !== null) {
    if (read(showRunsApplied) === press.at) return
    set(showRunsApplied, press.at)
    if (press.needsYou) showNeedsYou()
  }
  show('runs')
}

/** A connection read or retry answered: the worker answers, and the state it carries is kept. */
function connectionAnswered(answer: ConnectionReadAnswer): void {
  set(connectionTrouble, null)
  keepNewest(answer.connection)
  if (answer.showRuns !== undefined) applyShowRuns(answer.showRuns)
}

/** A connection read or retry failed. A rate-limited one has no trouble to tell, and changes nothing. */
function connectionFailed(trouble: WorkerTrouble | null): void {
  if (trouble !== null) set(connectionTrouble, trouble)
}

/** "Try again" on a state screen. Its failure is Worker unreachable, like a failed read. */
function retryConnection(): void {
  plugin.request('connection.retry').then(connectionAnswered, (error: unknown) =>
    connectionFailed(nextTrouble(read(connectionTrouble), rejectionOf(error)))
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
  if (next === 'runs') restartRunsView()
  if (before === next) return
  // Opening the Launch section reads Archon's projects and the workflow list again.
  if (next === 'launch') openLaunch()
  if (next === 'settings') {
    readForms()
    askSystem('system.open')
  }
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
    keep: keepNewest,
    newRun: () => show('launch')
  })
  startRunDetail(ctx, {
    connection: () => read(connection),
    showing: () => parseSection(read(section)) === 'runs',
    keep: keepNewest,
    back: restartRuns,
    // Re-run fills the launcher first, so the section opens on the run's draft.
    async rerun(runId) {
      await rerunLaunch(runId)
      show('launch')
    }
  })
  startScope(ctx, {
    connection: () => read(connection),
    // The Launch section's default project is the scope's, so it reads the scope too.
    showing: () => {
      const showing = parseSection(read(section))
      return showing === 'runs' || showing === 'launch'
    },
    keep: keepNewest,
    changed: () => {
      rescopeRuns()
      restartLaunch()
    }
  })
  startLaunchSection(ctx, {
    connection: () => read(connection),
    showing: () => parseSection(read(section)) === 'launch',
    keep: keepNewest,
    project: scopedProjectId,
    settled: scopeSettled,
    openRun(runId) {
      show('runs')
      openRunDetail(runId)
    }
  })
  ctx.subscriptions.push(plugin.on('show-runs', applyShowRuns))
  ctx.subscriptions.push(plugin.on('needs-you.changed', refreshRuns))
  ctx.subscriptions.push(plugin.on('connection.changed', keepNewest))
  ctx.subscriptions.push(plugin.on('runs.changed', hintRuns))
  ctx.subscriptions.push(plugin.on('runs.changed', hintRunDetail))
  ctx.subscriptions.push(plugin.on('system.changed', keepSystem))
  startFormGroups(ctx, { keep: keepNewest })
  startNotificationsGroup(ctx)
  // The first read, then one on the safety refetch: a worker that did not answer is tried again.
  const fetch = createViewFetch<ConnectionReadAnswer>({
    load: (signal) => plugin.request('connection.read', undefined, { signal }),
    apply: connectionAnswered,
    fail: (_error, trouble) => connectionFailed(trouble),
    minGapMs: CONNECTION_GAP_MS,
    safetyMs: () => SAFETY_REFETCH_MS,
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
  if (parseSection(read(section)) === 'settings') {
    readForms()
    askSystem('system.open')
  }
  ctx.subscriptions.push({
    dispose: () => {
      if (parseSection(read(section)) === 'settings') closeSystem()
    }
  })
}

/**
 * The sections that show Archon's data. Each one is drawn through an outage by the shared rules of
 * `dataViewBody`, so a new data view only adds itself here.
 */
const DATA_VIEWS: Partial<Record<SectionId, DataView>> = {
  runs: { hasData: runsHaveData, draw: runsSection },
  launch: { hasData: launchHasData, draw: (state, writable) => launchSection(state, writable, scopeNotice(writable)) }
}

/** What one section shows below the section bar. */
function sectionBody(id: SectionId, label: string, state: ConnectionView | null): OrcaNode {
  const trouble = read(connectionTrouble)
  const view = DATA_VIEWS[id]
  if (view !== undefined) {
    const screen = stateScreen(state, actions)
    return dataViewBody(view, { state, kept: read(lastConnected), screen, trouble, tryAgain: readConnection })
  }
  const line = trouble === null ? null : troubleLine(trouble, readConnection)
  // Settings keeps its Connection group under the line, even with no state known.
  if (id === 'settings') {
    const refresh = (): void => {
      readForms()
      askSystem('system.refresh')
    }
    return underLine(line, settingsSection(state, read(system), { refresh }))
  }
  if (state === null && line !== null) return line
  // Without its paths the Metrics section says which release it needs, and asks Archon nothing.
  if (id === 'metrics' && state?.kind === 'connected' && !state.features.metrics) {
    return underLine(line, <EmptyState title={label} description={metricsMissing(state)} />)
  }
  const screen = stateScreen(state, actions)
  return underLine(line, screen ?? <EmptyState title={label} description="This section is not built yet." />)
}

/** A section's body, under the line saying live updates are off while they are. */
function underLiveLine(body: OrcaNode, state: ConnectionView | null): OrcaNode {
  return underLine(state?.kind === 'connected' ? liveOffLine(state) : null, body)
}

export default function Panel() {
  const state = read(connection)
  const tabs = (
    <Tabs
      label="Orchon sections"
      value={parseSection(read(section))}
      onChange={(value) => show(parseSection(value))}
    >
      {SECTIONS.map(({ id, label }) => (
        <Tab key={id} value={id} label={label}>
          {underLiveLine(sectionBody(id, label, state), state)}
        </Tab>
      ))}
    </Tabs>
  )
  const notices = launchNotices()
  if (notices === null) return tabs
  return (
    <Stack gap="sm">
      {notices}
      {tabs}
    </Stack>
  )
}
