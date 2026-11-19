// Discovery: the steps that find Archon's base URL. One pass takes the first step that applies
// and tries its one candidate, which counts only once `GET /api/health` there answers JSON with
// `status: "ok"`. Nothing here starts Archon, and nothing but loopback is ever called.
import { join } from 'node:path'
import type { Client } from './client'
import type { AddressSource, HomeFolder } from './connection-view'
import type { Disk } from './disk'
import { isLoopbackHost } from './loopback'

/** Where Archon listens when neither a setting nor `server.json` says otherwise. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3090'
export const HEALTH_PATH = '/api/health'
export const SERVER_RECORD_FILE = 'server.json'

/** `server.json` is a few lines. Anything longer is not Archon's record. */
const SERVER_RECORD_CAP_BYTES = 64 * 1024
/** Outside text is shown cut to these lengths. */
const VERSION_LENGTH = 40
const HOST_LENGTH = 100
const STORE_ID_LENGTH = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A field of its own on a record, or undefined when the record does not have it. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** An id as a store reports it, null when absent, or `false` when it is something else. */
function readStoreId(value: unknown): string | null | false {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && value !== '' && value.length <= STORE_ID_LENGTH ? value : false
}

/** The fields of a health answer that the plugin reads. */
export type Health = {
  /** Shown to the person and never used for a decision. */
  version: string | null
  storeId: string | null
}

/** Validates a health answer. Null means this is not a healthy Archon. */
export function parseHealth(value: unknown): Health | null {
  if (!isRecord(value) || own(value, 'status') !== 'ok') return null
  const storeId = readStoreId(own(value, 'storeId'))
  if (storeId === false) return null
  const version = own(value, 'version')
  return {
    version: typeof version === 'string' && version !== '' ? version.slice(0, VERSION_LENGTH) : null,
    storeId
  }
}

/** The fields of `server.json` that the plugin reads. `pid` is ignored: it can be stale. */
export type ServerRecord = { host: string; port: number; storeId: string | null }

/** Validates the text of `server.json`. Null means the file is not a record to act on. */
export function parseServerRecord(text: string): ServerRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const port = own(value, 'port')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const host = own(value, 'host') ?? '127.0.0.1'
  if (typeof host !== 'string' || host === '') return null
  const storeId = readStoreId(own(value, 'storeId'))
  return storeId === false ? null : { host, port, storeId }
}

/**
 * The address a record names. A server bound to every interface (`0.0.0.0`) is reached on
 * `127.0.0.1`. Any other host that is not loopback is on another machine as far as Orchon can
 * tell, and is never called.
 */
function recordAddress(record: ServerRecord): { baseUrl: string; loopback: boolean } {
  const named = record.host === '0.0.0.0' ? '127.0.0.1' : record.host
  const host = named.includes(':') && !named.startsWith('[') ? `[${named}]` : named
  return { baseUrl: `http://${host.slice(0, HOST_LENGTH)}:${record.port}`, loopback: isLoopbackHost(host) }
}

export type Discovery =
  | { kind: 'connected'; baseUrl: string; source: AddressSource; version: string | null; storeId: string | null }
  | { kind: 'not-found'; address: string; source: AddressSource; home: HomeFolder }

export type DiscoveryPorts = {
  client: Client
  /** Opened for the Archon home folder alone. */
  disk: Disk
  signal: AbortSignal
}

/** Asks one base URL for its health. Null when what answered, if anything, is not a healthy Archon. */
export async function checkHealth(client: Client, baseUrl: string, signal: AbortSignal): Promise<Health | null> {
  const answer = await client.request({ baseUrl, path: HEALTH_PATH, timeout: 'health', signal })
  return answer.ok ? parseHealth(answer.value) : null
}

/**
 * One discovery pass, for settings that passed their parse.
 *
 * 1. The Base URL setting. When set it is the only candidate, and the home folder is not looked at.
 * 2. `server.json` in the home folder, when it holds a record. Its address is the only
 *    candidate. A host on another machine, or a `storeId` that health does not repeat, is not found.
 * 3. The default address.
 */
export async function discover(
  settings: { baseUrl: string | null; home: string },
  ports: DiscoveryPorts
): Promise<Discovery> {
  const { client, disk, signal } = ports

  if (settings.baseUrl !== null) {
    const health = await checkHealth(client, settings.baseUrl, signal)
    return health === null
      ? { kind: 'not-found', address: settings.baseUrl, source: 'setting', home: 'unchecked' }
      : { kind: 'connected', baseUrl: settings.baseUrl, source: 'setting', ...health }
  }

  const file = await disk.readText(join(settings.home, SERVER_RECORD_FILE), SERVER_RECORD_CAP_BYTES)
  const record = file.kind === 'text' ? parseServerRecord(file.text) : null
  if (record !== null) {
    const { baseUrl, loopback } = recordAddress(record)
    const health = loopback ? await checkHealth(client, baseUrl, signal) : null
    const sameStore = health !== null && (record.storeId === null || record.storeId === health.storeId)
    // The record was read from the home folder, so the folder exists.
    return sameStore
      ? { kind: 'connected', baseUrl, source: 'server-json', ...health }
      : { kind: 'not-found', address: baseUrl, source: 'server-json', home: 'exists' }
  }

  const health = await checkHealth(client, DEFAULT_BASE_URL, signal)
  if (health !== null) return { kind: 'connected', baseUrl: DEFAULT_BASE_URL, source: 'default', ...health }
  const home: HomeFolder = (await disk.folderState(settings.home)) === 'exists' ? 'exists' : 'missing'
  return { kind: 'not-found', address: DEFAULT_BASE_URL, source: 'default', home }
}
