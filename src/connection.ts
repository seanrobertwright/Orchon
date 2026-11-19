// The connection state: the worker's one record of whether Archon is reachable, shared by every
// frame. This file owns the state and when discovery runs; `startConnection` ties it to Orca
// (the settings, the frames' requests, the posts and the status bar item) and holds the
// dashboard stream while Connected.
import type { OrcaWorkerApi } from 'orca/worker'
import { createClient, type Client, type ClientFailure, type FetchLike, type Timers } from './client'
import { parseConnectionSettings, shown, type ParsedSettings, type TypedSettings } from './connection-settings'
import type { ConnectionView, SettingsView } from './connection-view'
import type { Disk } from './disk'
import { checkHealth, discover } from './discovery'
import { createLive } from './live'
import { createNeedsYou, type NeedsYou } from './needs-you'
import {
  createNotifications,
  DEFAULT_LEVEL,
  NOTIFICATIONS_KEY,
  parseNotificationSetting,
  TEST_NOTIFICATION,
  type NotificationSetting
} from './notifications'
import type { NotificationsTestAnswer } from './notifications-view'
import { checkPaths } from './path-check'
import { createRunEndings } from './run-endings'
import { isRecord, own, refuseRequest } from './records'
import { createStatusBar, showRunsSentence, STATUS_ITEM_ID, statusItem, type SnapshotCounts } from './status-bar'
import { createSystem } from './system'

/** What the worker reaches outside itself: the real things in Orca, scripted ones in the tests. */
export type WorkerPorts = {
  fetch: FetchLike
  /** Opens the disk module for the given roots. */
  openDisk(roots: readonly string[]): Disk
  /** The person's home folder, which a leading `~` stands for. */
  homeDir: string
  /** `process.platform`: the WSL share test of #25 runs on Windows only. */
  platform: string
  now(): number
  timers: Timers
}

/** In Not found, discovery runs again after this long, then twice as long each time, up to the last. */
export const FIRST_RETRY_MS = 2_000
export const LAST_RETRY_MS = 30_000
/** In Unsupported, discovery runs again this often, with no doubling. */
export const UNSUPPORTED_RETRY_MS = 30_000
/** From Connected, a lost server stays Searching this long before it is Not found. */
export const GRACE_MS = 20_000
/** During the grace, discovery runs again this long after each pass that found nothing. */
export const GRACE_RETRY_MS = 2_000

/** A state before it is stamped with the time it was entered. */
type Entering = ConnectionView extends infer View ? (View extends ConnectionView ? Omit<View, 'since'> : never) : never

/**
 * Not found and Unsupported wait on a timer for discovery to run again. They keep their screen
 * while it runs, and "Try again" runs it at once.
 */
function waitsToLookAgain(view: ConnectionView): boolean {
  return view.kind === 'not-found' || view.kind === 'unsupported'
}

const NO_SETTINGS: SettingsView = { baseUrl: '', archonHome: '', homeFolder: null }

/** A JSON value as text with its keys in order, so two values with the same content compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([first], [second]) => (first < second ? -1 : 1)))
      : inner
  )
}

/** Compares the stored values, never the text cut for display: the cut can hide a change. */
const sameStored = (first: TypedSettings, second: TypedSettings): boolean =>
  first.baseUrl === second.baseUrl && first.archonHome === second.archonHome

export type Connection = {
  /** Begins the first discovery pass. */
  start(): void
  /** The state, once the settings were first read: what a frame's `connection.read` answers. */
  read(): Promise<ConnectionView>
  /** The state, once the settings were first read. Data requests carry it. */
  current(): Promise<ConnectionView>
  /**
   * A call to Archon failed. While Connected to that base URL, a refused connection moves the
   * state to Searching, and a timeout sends one health check, at most one in flight: when
   * health answers as the same store the state stays Connected, otherwise it moves to Searching.
   */
  callFailed(baseUrl: string, failure: ClientFailure): void
  /**
   * "Try again": in Not found and Unsupported, runs discovery at once. In any other state it
   * changes nothing.
   */
  retry(): Promise<ConnectionView>
  /** A setting changed: parses both again, and runs discovery at once when either one differs. */
  settingsChanged(): Promise<void>
  /** While Connected, records whether the dashboard stream is open, or not yet found down. */
  setLive(live: boolean): void
  /**
   * While Connected, the dashboard stream found nothing taking its connection: Searching with the
   * grace, as `callFailed` does for a refused call, and discovery after one grace retry.
   */
  refused(): void
  stop(): void
}

export type ConnectionPorts = {
  /** What `settings.get` answers. */
  readSettings(): Promise<unknown>
  homeDir: string
  client: Client
  openDisk(roots: readonly string[]): Disk
  now(): number
  timers: Timers
  /** Called with every state entered after the first. */
  changed(view: ConnectionView): void
  log(message: string): void
}

export function createConnection(ports: ConnectionPorts): Connection {
  let view: ConnectionView = { kind: 'searching', since: ports.now(), settings: NO_SETTINGS }
  /** The settings as last stored, uncut, or null before the first read. */
  let stored: TypedSettings | null = null
  /** Rises whenever a new pass begins, so an older pass still in flight changes nothing. */
  let generation = 0
  let inFlight = new AbortController()
  let retryTimer: unknown
  let retryDelay = FIRST_RETRY_MS
  /** Whether a health check sent after a timeout is in flight. */
  let checking = false
  /** When a server was lost from Connected, while its grace runs; null otherwise. */
  let graceStart: number | null = null
  let settingsRead = (): void => {}
  const ready = new Promise<void>((resolve) => {
    settingsRead = resolve
  })

  /** Enters a state. A state with the same content as the current one is not a change. */
  function enter(next: Entering): void {
    if (canonical({ ...view, since: 0 }) === canonical({ ...next, since: 0 })) return
    view = { ...next, since: Math.max(ports.now(), view.since + 1) }
    ports.changed(view)
  }

  function clearRetry(): void {
    if (retryTimer !== undefined) ports.timers.clear(retryTimer)
    retryTimer = undefined
  }

  function lookAfter(wait: number): void {
    retryTimer = ports.timers.set(() => {
      retryTimer = undefined
      void look()
    }, wait)
  }

  const inGrace = (): boolean => graceStart !== null && ports.now() < graceStart + GRACE_MS

  /**
   * A pass found no server to connect to. During the grace the state stays Searching and
   * discovery runs again soon; once the grace is over, `otherwise` decides.
   */
  function foundNothing(otherwise: () => void): void {
    if (inGrace()) {
      lookAfter(GRACE_RETRY_MS)
      return
    }
    graceStart = null
    otherwise()
  }

  /** The connected server was lost: Searching, with the grace, and discovery at once. */
  function lose(): void {
    if (view.kind !== 'connected') return
    graceStart = ports.now()
    enter({ kind: 'searching', settings: view.settings })
    void look()
  }

  /** The next wait of the Not found backoff. */
  function retryLater(): void {
    const wait = retryDelay
    retryDelay = Math.min(retryDelay * 2, LAST_RETRY_MS)
    lookAfter(wait)
  }

  /**
   * One pass: parse the settings (read now unless given), then discover. It supersedes any pass
   * in flight. Refused settings end it in Bad setting. Otherwise Not found and Unsupported stay
   * on screen while their own timer looks again, and any other pass shows Searching until it has
   * an answer. A confirmed server's path list is read before it counts as Connected.
   */
  async function look(known?: ParsedSettings): Promise<void> {
    generation += 1
    const mine = generation
    inFlight.abort()
    inFlight = new AbortController()
    const { signal } = inFlight
    clearRetry()
    try {
      const parsed = known ?? parseConnectionSettings(await ports.readSettings(), { homeDir: ports.homeDir })
      if (mine !== generation) return
      stored = parsed.stored
      const settings: SettingsView = { ...parsed.typed, homeFolder: parsed.home === null ? null : shown(parsed.home) }
      if (!parsed.ok) {
        // Nothing is repaired and nothing is called until the setting changes.
        enter({ kind: 'bad-setting', settings, refused: parsed.refused })
        return
      }
      if (!waitsToLookAgain(view) || canonical(view.settings) !== canonical(settings)) {
        enter({ kind: 'searching', settings })
      }
      settingsRead()
      const found = await discover(parsed, { client: ports.client, disk: ports.openDisk([parsed.home]), signal })
      if (mine !== generation) return
      if (found.kind === 'not-found') {
        foundNothing(() => {
          enter({ ...found, settings })
          retryLater()
        })
        return
      }
      const paths = await checkPaths(ports.client, found.baseUrl, signal)
      if (mine !== generation) return
      if (paths.kind !== 'unreachable') graceStart = null
      if (paths.kind === 'supported') {
        // The stream opens once Connected is entered. It counts as live until it is found down, so
        // the panel does not say live updates are off while the stream is still opening.
        enter({ ...found, settings, features: paths.features, live: true })
        retryDelay = FIRST_RETRY_MS
      } else if (paths.kind === 'unsupported') {
        const { baseUrl, source, version } = found
        enter({ kind: 'unsupported', settings, baseUrl, source, version })
        // A server lost from here goes to Not found, whose backoff starts over.
        retryDelay = FIRST_RETRY_MS
        lookAfter(UNSUPPORTED_RETRY_MS)
      } else {
        // The server answered health, then the document did not arrive: that says nothing about
        // its paths, so the state is Searching and discovery runs again on the backoff.
        enter({ kind: 'searching', settings })
        foundNothing(retryLater)
      }
    } catch (error) {
      if (mine !== generation) return
      ports.log(`Orchon could not look for Archon: ${error instanceof Error ? error.message : String(error)}`)
      foundNothing(retryLater)
    } finally {
      settingsRead()
    }
  }

  /** After a timeout: one health check, at most one in flight, decides whether the server is lost. */
  async function checkAfterTimeout(): Promise<void> {
    if (checking || view.kind !== 'connected') return
    checking = true
    const mine = generation
    const { baseUrl, storeId } = view
    try {
      const health = await checkHealth(ports.client, baseUrl, inFlight.signal)
      // The version string decides nothing; another store at the address is another server.
      if (mine === generation && (health === null || health.storeId !== storeId)) lose()
    } catch (error) {
      // Nothing waits for a check, so a failure here must not go unhandled.
      ports.log(`Orchon could not check on Archon: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      checking = false
    }
  }

  return {
    start() {
      void look()
    },

    async read() {
      await ready
      return view
    },

    callFailed(baseUrl, failure) {
      if (view.kind !== 'connected' || view.baseUrl !== baseUrl) return
      if (failure.kind === 'refused') lose()
      else if (failure.kind === 'timeout') void checkAfterTimeout()
    },

    async current() {
      await ready
      return view
    },

    async retry() {
      await ready
      if (waitsToLookAgain(view)) {
        retryDelay = FIRST_RETRY_MS
        enter({ kind: 'searching', settings: view.settings })
        void look()
      }
      return view
    },

    async settingsChanged() {
      const mine = generation
      let parsed: ParsedSettings
      try {
        parsed = parseConnectionSettings(await ports.readSettings(), { homeDir: ports.homeDir })
      } catch (error) {
        ports.log(`Orchon could not read its settings: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      // A pass that began meanwhile has read the settings itself.
      if (mine !== generation || (stored !== null && sameStored(parsed.stored, stored))) return
      // A new setting is a new question, not a lost server: it has no grace.
      graceStart = null
      retryDelay = FIRST_RETRY_MS
      await look(parsed)
    },

    setLive(live) {
      if (view.kind === 'connected') enter({ ...view, live })
    },

    refused() {
      if (view.kind !== 'connected') return
      // The server is lost as for a refused call, with the grace, but discovery waits one grace
      // retry first. The stream opens at once after it, so a server that answers health and
      // refuses the stream is asked at that pace, not in a loop.
      graceStart = ports.now()
      enter({ kind: 'searching', settings: view.settings })
      clearRetry()
      lookAfter(GRACE_RETRY_MS)
    },

    stop() {
      generation += 1
      inFlight.abort()
      clearRetry()
    }
  }
}

/** A frame sends these requests with no input. Anything else is refused. */
function refuseInput(input: unknown): void {
  if (input === undefined || input === null) return
  refuseRequest('This request takes no input.')
}

/** A started connection: what the data requests read through, and what stops it. */
export type StartedConnection = {
  /** The one client every call to Archon goes through. */
  client: Client
  current(): Promise<ConnectionView>
  /** The snapshot of runs that need you, read while Connected. */
  needsYou: NeedsYou
  /** The status bar sentence now, as the "Orchon: Show runs" command returns it. */
  showRunsSentence(): string
  /** The Notifications setting as last read. */
  notificationSetting(): NotificationSetting
  stop(): void
}

/**
 * Starts the connection on Orca: discovery begins at once, every change is posted to the frames
 * and shown in the status bar item, and the frames' requests are answered.
 */
export function startConnection(orca: OrcaWorkerApi, ports: WorkerPorts): StartedConnection {
  const statusBar = createStatusBar({
    now: ports.now,
    timers: ports.timers,
    update(item) {
      orca.host.call('statusBar.update', { id: STATUS_ITEM_ID, ...item }).catch((error: unknown) => {
        orca.log(`Orchon could not update its status bar item: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
  // Every call's failure is reported to the connection, which decides whether the server is lost.
  const client = createClient({
    fetch: ports.fetch,
    timers: ports.timers,
    failed: (call, failure) => connection.callFailed(call.baseUrl, failure)
  })
  /** The Notifications setting, as the settings were last read. */
  let setting: NotificationSetting = { level: DEFAULT_LEVEL, recognised: true }
  const connection = createConnection({
    // The one read of the settings also gives the Notifications setting; a failed read keeps its last value.
    async readSettings() {
      const all = await orca.settings.get()
      const next = parseNotificationSetting(isRecord(all) ? own(all, NOTIFICATIONS_KEY) : undefined)
      if (next.level !== setting.level || next.recognised !== setting.recognised) {
        setting = next
        orca.panels.post('notifications.changed', next)
      }
      return all
    },
    homeDir: ports.homeDir,
    client,
    openDisk: ports.openDisk,
    now: ports.now,
    timers: ports.timers,
    log: (message) => orca.log(message),
    changed(view) {
      const before = held
      held = view
      orca.panels.post('connection.changed', view)
      system.connectionChanged()
      // The stream is held while Connected, and opened at once whenever discovery connects. The
      // snapshot is read on every reconnect.
      if (view.kind !== 'connected') {
        live.close()
        needsYou.disconnected()
        endings.disconnected()
      } else if (before?.kind !== 'connected') {
        live.open(view.baseUrl)
        needsYou.connected(view)
        endings.connected(view)
      }
      showStatus()
    }
  })
  let held: ConnectionView | undefined
  const notifications = createNotifications({
    now: ports.now,
    timers: ports.timers,
    level: () => setting.level,
    show(notification) {
      orca.host.call('notifications.show', notification).catch((error: unknown) => {
        orca.log(`Orchon could not show a notification: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
  const needsYou = createNeedsYou({
    client,
    now: ports.now,
    timers: ports.timers,
    changed() {
      showStatus()
      orca.panels.post('needs-you.changed', null)
    },
    counted: (storeId, notices) => notifications.waiting(storeId, notices),
    log: (message) => orca.log(message)
  })
  const endings = createRunEndings({
    client,
    now: ports.now,
    optedIn: () => setting.level === 'needs-you-and-ended',
    ended: (storeId, notice) => notifications.ended(storeId, notice),
    log: (message) => orca.log(message)
  })
  /** The snapshot's counts while Connected; in any other state the item reads without them. */
  const countsFor = (view: ConnectionView): SnapshotCounts | undefined => (view.kind === 'connected' ? needsYou.counts() : undefined)
  /** The item for the state now and, while Connected, the snapshot's counts. */
  function showStatus(): void {
    if (held !== undefined) statusBar.show(statusItem(held, countsFor(held)))
  }
  const live = createLive({
    client,
    now: ports.now,
    timers: ports.timers,
    hint(hint) {
      orca.panels.post('runs.changed', hint)
      needsYou.hint(hint)
    },
    status: (runId) => endings.status(runId),
    live: (open) => connection.setLive(open),
    refused: () => connection.refused(),
    log: (message) => orca.log(message)
  })

  const system = createSystem({
    client,
    connection: () => connection.current(),
    now: ports.now,
    timers: ports.timers,
    changed: (view) => orca.panels.post('system.changed', view)
  })

  const subscriptions = [
    orca.settings.onDidChange(() => void connection.settingsChanged()),
    orca.panels.handle('connection.read', async (input) => {
      refuseInput(input)
      const view = await connection.read()
      // A press remembered for a panel that mounts after it.
      const showRuns = needsYou.pressed()
      return showRuns === undefined ? { connection: view } : { connection: view, showRuns }
    }),
    orca.panels.handle('connection.retry', async (input) => {
      refuseInput(input)
      return { connection: await connection.retry() }
    }),
    orca.panels.handle('system.open', async (input) => {
      refuseInput(input)
      const view = await system.open()
      return { connection: await connection.current(), system: view }
    }),
    orca.panels.handle('system.refresh', async (input) => {
      refuseInput(input)
      const view = await system.refresh()
      return { connection: await connection.current(), system: view }
    }),
    orca.panels.handle('notifications.read', async (input) => {
      refuseInput(input)
      // Answered once the settings were first read, so a panel that mounts early never sees the default in place of the stored value.
      await connection.current()
      return setting
    }),
    orca.panels.handle('notifications.test', async (input): Promise<NotificationsTestAnswer> => {
      refuseInput(input)
      try {
        const { delivered } = await orca.host.call('notifications.show', { ...TEST_NOTIFICATION })
        return delivered ? { kind: 'delivered' } : { kind: 'blocked' }
      } catch (error) {
        orca.log(`Orchon could not send the test notification: ${error instanceof Error ? error.message : String(error)}`)
        return { kind: 'failed' }
      }
    }),
    orca.panels.handle('system.close', (input) => {
      refuseInput(input)
      system.close()
      return null
    })
  ]
  statusBar.show(statusItem({ kind: 'searching', since: ports.now(), settings: NO_SETTINGS }))
  connection.start()

  return {
    client,
    current: () => connection.current(),
    needsYou,
    showRunsSentence() {
      const view = held ?? { kind: 'searching', since: ports.now(), settings: NO_SETTINGS }
      return showRunsSentence(view, countsFor(view))
    },
    notificationSetting: () => setting,
    stop() {
      for (const subscription of subscriptions) subscription.dispose()
      connection.stop()
      live.close()
      needsYou.stop()
      endings.stop()
      notifications.stop()
      system.close()
      statusBar.stop()
    }
  }
}
