// The connection state: the worker's one record of whether Archon is reachable, shared by every
// frame. This file owns the state and when discovery runs; `startConnection` ties it to Orca
// (the settings, the frames' requests, the posts and the status bar item).
import type { OrcaWorkerApi } from 'orca/worker'
import { createClient, type Client, type FetchLike, type Timers } from './client'
import { parseConnectionSettings, shown, type ParsedSettings, type TypedSettings } from './connection-settings'
import type { ConnectionView, SettingsView } from './connection-view'
import type { Disk } from './disk'
import { checkHealth, discover } from './discovery'
import { checkPaths } from './path-check'
import { createStatusBar, STATUS_ITEM_ID, statusItem } from './status-bar'
import { createSystem } from './system'

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
/** In Unsupported, discovery runs again this often, with no doubling. */
export const UNSUPPORTED_RETRY_MS = 30_000

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
  /**
   * The state, once the settings were first read. While Connected it also sends one health
   * check, at most one in flight: a server that no longer answers moves the state to Searching.
   */
  read(): Promise<ConnectionView>
  /**
   * "Try again": in Not found and Unsupported, runs discovery at once. In any other state it
   * changes nothing.
   */
  retry(): Promise<ConnectionView>
  /** A setting changed: parses both again, and runs discovery at once when either one differs. */
  settingsChanged(): Promise<void>
  /** The state as it is now, with nothing checked or waited for. */
  current(): ConnectionView
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

  function lookAfter(wait: number): void {
    retryTimer = ports.timers.set(() => {
      retryTimer = undefined
      void look()
    }, wait)
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
        enter({ ...found, settings })
        retryLater()
        return
      }
      const paths = await checkPaths(ports.client, found.baseUrl, signal)
      if (mine !== generation) return
      if (paths.kind === 'supported') {
        enter({ ...found, settings, features: paths.features })
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
        retryLater()
      }
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
      retryDelay = FIRST_RETRY_MS
      await look(parsed)
    },

    current() {
      return view
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
  const client = createClient({ fetch: ports.fetch, timers: ports.timers })
  const connection = createConnection({
    readSettings: () => orca.settings.get(),
    homeDir: ports.homeDir,
    client,
    openDisk: ports.openDisk,
    now: ports.now,
    timers: ports.timers,
    log: (message) => orca.log(message),
    changed(view) {
      orca.panels.post('connection.changed', view)
      statusBar.show(statusItem(view))
    }
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
      return { connection: await connection.read() }
    }),
    orca.panels.handle('connection.retry', async (input) => {
      refuseInput(input)
      return { connection: await connection.retry() }
    }),
    orca.panels.handle('system.open', async (input) => {
      refuseInput(input)
      const view = await system.open()
      return { connection: connection.current(), system: view }
    }),
    orca.panels.handle('system.refresh', async (input) => {
      refuseInput(input)
      const view = await system.refresh()
      return { connection: connection.current(), system: view }
    }),
    orca.panels.handle('system.close', (input) => {
      refuseInput(input)
      system.close()
      return null
    })
  ]
  statusBar.show(statusItem({ kind: 'searching', since: ports.now(), settings: NO_SETTINGS }))
  connection.start()

  return () => {
    for (const subscription of subscriptions) subscription.dispose()
    connection.stop()
    system.stop()
    statusBar.stop()
  }
}
