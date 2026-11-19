// The System group of the Settings section: the worker's reads of Archon's health and its update
// check, trimmed to the view model the panel draws. Health is read when the section opens, on
// Refresh and every 30 seconds while the section shows; the update check on open and Refresh only.
import type { Client, ClientFailure, Timers } from './client'
import type { ConnectionView } from './connection-view'
import { HEALTH_PATH } from './discovery'
import { isRecord, own } from './records'
import type { HealthFacts, Platforms, SystemView, Updates } from './system-view'

/** While the section shows, health is read again this often. */
export const SYSTEM_REFRESH_MS = 30_000

/** Platforms past this many are counted, not named. */
export const PLATFORMS_SHOWN = 20

/** Outside text is shown cut to this length. */
const TEXT_LENGTH = 100

export const UPDATE_CHECK_PATH = '/api/update-check'

/** A release link longer than this is not one Archon wrote. */
const RELEASE_URL_LENGTH = 2_048

/** A non-empty string cut for display, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, TEXT_LENGTH) : null
}

/** A whole number of zero or more, or null. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function platforms(value: unknown): Platforms | null {
  if (!Array.isArray(value)) return null
  const names = value.map(text).filter((name): name is string => name !== null)
  return { names: names.slice(0, PLATFORMS_SHOWN), more: Math.max(0, names.length - PLATFORMS_SHOWN) }
}

/**
 * Validates a health answer for the System rows. Every field is optional: one that is absent or
 * not the shape expected reads as null and is shown as a dash. Null when it is not an object.
 */
export function parseHealthFacts(value: unknown): HealthFacts | null {
  if (!isRecord(value)) return null
  const concurrency = own(value, 'concurrency')
  const active = isRecord(concurrency) ? count(own(concurrency, 'active')) : null
  const max = isRecord(concurrency) ? count(own(concurrency, 'maxConcurrent')) : null
  return {
    status: text(own(value, 'status')),
    adapter: text(own(value, 'adapter')),
    database: text(own(value, 'database')),
    version: text(own(value, 'version')),
    storeId: text(own(value, 'storeId')),
    concurrency: active === null || max === null ? null : { active, max },
    runningWorkflows: count(own(value, 'runningWorkflows')),
    platforms: platforms(own(value, 'activePlatforms'))
  }
}

/**
 * The release link, only when it parses as an `https` address on `github.com` with no
 * credentials and no port of its own. Anything else is no link at all.
 */
function releaseLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > RELEASE_URL_LENGTH || !URL.canParse(value)) return null
  const url = new URL(value)
  const plain = url.username === '' && url.password === '' && url.port === ''
  return url.protocol === 'https:' && url.hostname === 'github.com' && plain ? url.href : null
}

/** Validates an update check answer. One that cannot be read is "Update check unavailable". */
export function parseUpdates(value: unknown): Updates {
  if (!isRecord(value)) return { kind: 'unavailable' }
  const available = own(value, 'updateAvailable')
  const latest = text(own(value, 'latestVersion'))
  if (available === true && latest !== null) {
    return { kind: 'available', version: latest, releaseUrl: releaseLink(own(value, 'releaseUrl')) }
  }
  if (available === false) return { kind: 'up-to-date', version: text(own(value, 'currentVersion')) }
  return { kind: 'unavailable' }
}

/** An answer that does not validate. */
const UNREADABLE = "Orchon could not read Archon's answer."

/** Why a read gave no answer, in the words of the failed-read table. */
function failureText(failure: ClientFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return `Archon did not answer within ${failure.timeoutMs / 1_000} seconds.`
    case 'too-large':
      return "Archon's answer was too large to read."
    case 'status':
      return `Archon answered with an error (${failure.status}).`
    case 'not-json':
      return 'This Archon does not have this feature.'
    case 'refused':
    case 'not-loopback':
    case 'cancelled':
      return 'Archon did not answer.'
  }
}

export type SystemPorts = {
  client: Client
  /** The connection state, once the settings were first read. */
  connection(): Promise<ConnectionView>
  now(): number
  timers: Timers
  /** Called with each view made by a read that no request waits for. */
  changed(view: SystemView): void
}

export type System = {
  /** The section began to show: reads both, or, while not Connected, as soon as it connects. */
  open(): Promise<SystemView>
  /** Refresh: the same reads as open. Kept as its own request because the panel sends it for another reason. */
  refresh(): Promise<SystemView>
  /** The connection state changed. The first Connected after an open that could not read reads both. */
  connectionChanged(): void
  /** The section stopped showing, or the worker stops: no timer and no read waiting to connect. */
  close(): void
}

export function createSystem(ports: SystemPorts): System {
  let view: SystemView = { since: ports.now(), health: null, readAt: null, failure: null, updates: { kind: 'checking' } }

  function change(next: Omit<SystemView, 'since'>): SystemView {
    view = { ...next, since: Math.max(ports.now(), view.since + 1) }
    return view
  }

  /** Rises with every update check, so an older one still in flight changes nothing. */
  let checks = 0

  async function checkUpdates(baseUrl: string): Promise<void> {
    checks += 1
    const mine = checks
    const answer = await ports.client.request({ baseUrl, path: UPDATE_CHECK_PATH, timeout: 'read' })
    if (mine !== checks) return
    ports.changed(change({ ...view, updates: answer.ok ? parseUpdates(answer.value) : { kind: 'unavailable' } }))
  }

  /** The 30 second timer, set only while the section shows. */
  let timer: unknown
  /** Whether the section shows, so the timer is to be set again after each timed read. */
  let watching = false
  /** Whether the section opened while not Connected, so both are read once it connects. */
  let waitingToConnect = false

  function clearTimer(): void {
    if (timer !== undefined) ports.timers.clear(timer)
    timer = undefined
  }

  /** Waits 30 seconds, then reads health and posts what it found, and waits again. */
  function readLater(): void {
    clearTimer()
    timer = ports.timers.set(() => {
      timer = undefined
      void readHealth().then((next) => {
        if (next !== null) ports.changed(next)
        if (watching && timer === undefined) readLater()
      })
    }, SYSTEM_REFRESH_MS)
  }

  /**
   * Health and the update check, as on open and on Refresh, and the timer starts over. The answer
   * waits for health only.
   */
  async function readBoth(): Promise<SystemView> {
    watching = true
    readLater()
    const connection = await ports.connection()
    waitingToConnect = connection.kind !== 'connected'
    if (connection.kind !== 'connected') return view
    change({ ...view, updates: { kind: 'checking' } })
    void checkUpdates(connection.baseUrl)
    return (await readHealth()) ?? view
  }

  function close(): void {
    watching = false
    waitingToConnect = false
    clearTimer()
  }

  /** The health read in flight, so a second one waits for it instead of starting its own. */
  let reading: Promise<SystemView | null> | undefined

  /** Reads health while Connected. Null when not Connected, and nothing was read. */
  function readHealth(): Promise<SystemView | null> {
    reading ??= (async () => {
      const connection = await ports.connection()
      if (connection.kind !== 'connected') return null
      const answer = await ports.client.request({ baseUrl: connection.baseUrl, path: HEALTH_PATH, timeout: 'read' })
      if (!answer.ok) return change({ ...view, failure: failureText(answer.failure) })
      const health = parseHealthFacts(answer.value)
      return health === null
        ? change({ ...view, failure: UNREADABLE })
        : change({ ...view, health, readAt: ports.now(), failure: null })
    })().finally(() => {
      reading = undefined
    })
    return reading
  }

  return {
    open: readBoth,
    refresh: readBoth,
    connectionChanged() {
      if (!watching || !waitingToConnect) return
      void ports.connection().then(async (connection) => {
        if (!watching || !waitingToConnect || connection.kind !== 'connected') return
        ports.changed(await readBoth())
      })
    },
    close
  }
}
