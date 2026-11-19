// The connection state: the worker's one record of whether Archon is reachable, shared by every
// frame. This file owns the state and when discovery runs; `startConnection` ties it to Orca
// (the settings, the frames' requests, the posts and the status bar item).
import type { OrcaWorkerApi } from 'orca/worker'
import { createClient, type Client, type FetchLike, type Timers } from './client'
import { parseConnectionSettings, shown, type ParsedSettings, type TypedSettings } from './connection-settings'
import type { ConnectionView, SettingsView } from './connection-view'
import type { Disk } from './disk'
import { checkHealth, discover } from './discovery'
import { createStatusBar, STATUS_ITEM_ID, statusItem } from './status-bar'

/** What the worker reaches outside itself: the real things in Orca, scripted ones in the tests. */
export type WorkerPorts = {
  fetch: FetchLike
  /** Opens the disk module for the given roots. */
  openDisk(roots: readonly string[]): Disk
  /** The person's home folder, which a leading `~` stands for. */
  homeDir: string
  now(): number
  timers: Timers
}

/** In Not found, discovery runs again after this long, then twice as long each time, up to the last. */
export const FIRST_RETRY_MS = 2_000
export const LAST_RETRY_MS = 30_000

/** A state before it is stamped with the time it was entered. */
type Entering = ConnectionView extends infer View ? (View extends ConnectionView ? Omit<View, 'since'> : never) : never

const NO_SETTINGS: SettingsView = { baseUrl: '', archonHome: '', homeFolder: null }

/** A JSON value as text with its keys in order, so two values with the same content compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([first], [second]) => (first < second ? -1 : 1)))
      : inner
  )
}

const sameTyped = (first: TypedSettings, second: TypedSettings): boolean =>
  first.baseUrl === second.baseUrl && first.archonHome === second.archonHome

export type Connection = {
  /** Begins the first discovery pass. */
  start(): void
  /**
   * The state, once the settings were first read. While Connected it also sends one health
   * check, at most one in flight: a server that no longer answers moves the state to Searching.
   */
  read(): Promise<ConnectionView>
  /** "Try again": in Not found, runs discovery at once. In any other state it changes nothing. */
  retry(): Promise<ConnectionView>
  /** A setting changed: parses both again, and runs discovery at once when either one differs. */
  settingsChanged(): Promise<void>
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
  /** The settings as last parsed, or null before the first read. */
  let typed: TypedSettings | null = null
  /** Rises whenever a new pass begins, so an older pass still in flight changes nothing. */
  let generation = 0
  let inFlight = new AbortController()
  let retryTimer: unknown
  let retryDelay = FIRST_RETRY_MS
  let verifying = false
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

  function retryLater(): void {
    const wait = retryDelay
    retryDelay = Math.min(retryDelay * 2, LAST_RETRY_MS)
    retryTimer = ports.timers.set(() => {
      retryTimer = undefined
      void look()
    }, wait)
  }

  /**
   * One pass: parse the settings (read now unless given), then discover. It supersedes any pass
   * in flight. Refused settings end it in Bad setting. Otherwise Not found stays on screen while
   * its own timer looks again, and any other pass shows Searching until it has an answer.
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
      typed = parsed.typed
      const settings: SettingsView = { ...parsed.typed, homeFolder: parsed.home === null ? null : shown(parsed.home) }
      if (!parsed.ok) {
        // Nothing is repaired and nothing is called until the setting changes.
        enter({ kind: 'bad-setting', settings, refused: parsed.refused })
        return
      }
      if (view.kind !== 'not-found' || canonical(view.settings) !== canonical(settings)) {
        enter({ kind: 'searching', settings })
      }
      settingsRead()
      const found = await discover(parsed, { client: ports.client, disk: ports.openDisk([parsed.home]), signal })
      if (mine !== generation) return
      enter({ ...found, settings })
      if (found.kind === 'connected') retryDelay = FIRST_RETRY_MS
      else retryLater()
    } catch (error) {
      if (mine !== generation) return
      ports.log(`Orchon could not look for Archon: ${error instanceof Error ? error.message : String(error)}`)
      retryLater()
    } finally {
      settingsRead()
    }
  }

  /** Checks that the connected server still answers as the same store. */
  async function verify(): Promise<void> {
    if (verifying || view.kind !== 'connected') return
    verifying = true
    const mine = generation
    const { baseUrl, storeId, version } = view
    try {
      const health = await checkHealth(ports.client, baseUrl, inFlight.signal)
      if (mine !== generation) return
      if (health === null || health.storeId !== storeId || health.version !== version) {
        enter({ kind: 'searching', settings: view.settings })
        void look()
      }
    } catch (error) {
      // Nothing waits for a check, so a failure here must not go unhandled.
      ports.log(`Orchon could not check on Archon: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      verifying = false
    }
  }

  return {
    start() {
      void look()
    },

    async read() {
      await ready
      void verify()
      return view
    },

    async retry() {
      await ready
      if (view.kind === 'not-found') {
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
      if (mine !== generation || (typed !== null && sameTyped(parsed.typed, typed))) return
      retryDelay = FIRST_RETRY_MS
      await look(parsed)
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
  throw Object.assign(new Error('This request takes no input.'), { code: 'invalid_params' })
}

/**
 * Starts the connection on Orca: discovery begins at once, every change is posted to the frames
 * and shown in the status bar item, and the frames' requests are answered. Returns what stops it.
 */
export function startConnection(orca: OrcaWorkerApi, ports: WorkerPorts): () => void {
  const statusBar = createStatusBar({
    now: ports.now,
    timers: ports.timers,
    update(item) {
      orca.host.call('statusBar.update', { id: STATUS_ITEM_ID, ...item }).catch((error: unknown) => {
        orca.log(`Orchon could not update its status bar item: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
  const connection = createConnection({
    readSettings: () => orca.settings.get(),
    homeDir: ports.homeDir,
    client: createClient({ fetch: ports.fetch, timers: ports.timers }),
    openDisk: ports.openDisk,
    now: ports.now,
    timers: ports.timers,
    log: (message) => orca.log(message),
    changed(view) {
      orca.panels.post('connection.changed', view)
      statusBar.show(statusItem(view))
    }
  })

  const subscriptions = [
    orca.settings.onDidChange(() => void connection.settingsChanged()),
    orca.panels.handle('connection.read', async (input) => {
      refuseInput(input)
      return { connection: await connection.read() }
    }),
    orca.panels.handle('connection.retry', async (input) => {
      refuseInput(input)
      return { connection: await connection.retry() }
    })
  ]
  statusBar.show(statusItem({ kind: 'searching', since: ports.now(), settings: NO_SETTINGS }))
  connection.start()

  return () => {
    for (const subscription of subscriptions) subscription.dispose()
    connection.stop()
    statusBar.stop()
  }
}
