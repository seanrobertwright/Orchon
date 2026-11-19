// The parser of the two connection settings, Base URL and Archon home folder. A value either
// passes or is refused with the sentence the person is shown, and a refused value connects to
// nothing. Nothing is trimmed or completed. A Base URL that passes is written one way only: its
// scheme and host in lower case and without its one allowed trailing `/`, since each spelling
// names the same address.
import { isAbsolute, join } from 'node:path'
import type { RefusedSetting, SettingKey } from './connection-view'
import { isLoopbackHost } from './loopback'
import { isRecord, own } from './records'

/** Why a value was refused, one sentence each. A word between backticks is shown as code. */
export const REASONS = {
  notAddress: 'This is not a web address.',
  notHttp: 'The address must start with `http://`.',
  notLoopback: 'Orchon works only with an Archon on this computer. Use `127.0.0.1`, `localhost` or `[::1]`.',
  notBare: 'The address must be `http://`, a host and a port, and nothing else.',
  badPort: 'The port must be a number from 1 to 65535.',
  notFullPath: 'The folder must be a full path.'
} as const

/** The folder inside the person's home that Archon uses when the setting is empty. */
const DEFAULT_HOME = '.archon'

/** A value is shown cut to this many characters. */
const SHOWN_LENGTH = 200

/** Both settings as the person typed them, cut for display. Empty means unset. */
export type TypedSettings = Record<SettingKey, string>

export type ParsedSettings =
  | {
      ok: true
      typed: TypedSettings
      /** Both settings as stored, uncut: what decides whether a setting changed. */
      stored: TypedSettings
      /** `http://`, a loopback host and a port, or null for automatic discovery. */
      baseUrl: string | null
      /** The Archon home folder, a full path. */
      home: string
    }
  | {
      ok: false
      typed: TypedSettings
      /** Both settings as stored, uncut: what decides whether a setting changed. */
      stored: TypedSettings
      /** Each refused setting, the Base URL first. */
      refused: RefusedSetting[]
      /** The home folder when that setting passed, for display; null when it was refused. */
      home: string | null
    }

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** A value cut for display, with a mark where it was cut. */
export function shown(text: string): string {
  return text.length <= SHOWN_LENGTH ? text : `${text.slice(0, SHOWN_LENGTH - 1)}…`
}

/** One setting as it was stored: its own key of a plain object, or absent. */
function stored(raw: unknown, key: SettingKey): unknown {
  return isRecord(raw) ? own(raw, key) : undefined
}

/** A stored value as text: a string as typed, anything else as its JSON. */
function storedText(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
}

/** A port as typed: digits with no leading zero, from 1 to 65535. */
function parsePort(text: string | undefined): number | null {
  if (text === undefined || !/^[1-9]\d{0,4}$/.test(text)) return null
  const port = Number(text)
  return port <= 65535 ? port : null
}

/**
 * The Base URL as typed. It is read by hand, not with `URL`, which would quietly trim spaces and
 * turn `127.1` into `127.0.0.1`: both are repairs, and both are refused. A value that passes is
 * answered in one spelling: `http://`, the host in lower case and the port, with no trailing `/`.
 */
function parseBaseUrl(value: unknown): Parsed<string | null> {
  if (value === undefined || value === '') return { ok: true, value: null }
  if (typeof value !== 'string' || /[\s\p{Cc}]/u.test(value)) return refuse(REASONS.notAddress)
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(value)?.[0]
  if (scheme === undefined) return refuse(REASONS.notAddress)
  const afterScheme = value.slice(scheme.length)
  if (scheme.toLowerCase() !== 'http:' || !afterScheme.startsWith('//')) return refuse(REASONS.notHttp)

  const rest = afterScheme.slice(2)
  const end = rest.search(/[/?#]/)
  const authority = end === -1 ? rest : rest.slice(0, end)
  const tail = end === -1 ? '' : rest.slice(end)
  const at = authority.lastIndexOf('@')
  const [, hostAsTyped = '', portAsTyped] = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(authority.slice(at + 1)) ?? []
  const host = hostAsTyped.toLowerCase()
  if (host === '') return refuse(REASONS.notAddress)
  if (!isLoopbackHost(host)) return refuse(REASONS.notLoopback)
  if (at !== -1 || (tail !== '' && tail !== '/')) return refuse(REASONS.notBare)
  const port = parsePort(portAsTyped)
  if (port === null) return refuse(REASONS.badPort)
  return { ok: true, value: `http://${host}:${port}` }
}

/** The home folder as typed, with a leading `~` standing for the person's home. */
function parseHome(value: unknown, homeDir: string): Parsed<string> {
  if (value === undefined || value === '') return { ok: true, value: join(homeDir, DEFAULT_HOME) }
  if (typeof value !== 'string') return refuse(REASONS.notFullPath)
  if (value === '~') return { ok: true, value: homeDir }
  const expanded = value.startsWith('~/') || value.startsWith('~\\') ? join(homeDir, value.slice(2)) : value
  return isAbsolute(expanded) ? { ok: true, value: expanded } : refuse(REASONS.notFullPath)
}

/**
 * Parses what `settings.get` answered. `homeDir` is the person's home folder, a full path.
 * Anything that is not a plain object reads as both settings unset.
 */
export function parseConnectionSettings(raw: unknown, env: { homeDir: string }): ParsedSettings {
  const storedUrl = stored(raw, 'baseUrl')
  const storedHome = stored(raw, 'archonHome')
  const asStored: TypedSettings = { baseUrl: storedText(storedUrl), archonHome: storedText(storedHome) }
  const typed: TypedSettings = { baseUrl: shown(asStored.baseUrl), archonHome: shown(asStored.archonHome) }
  const baseUrl = parseBaseUrl(storedUrl)
  const home = parseHome(storedHome, env.homeDir)
  if (baseUrl.ok && home.ok) return { ok: true, typed, stored: asStored, baseUrl: baseUrl.value, home: home.value }

  const refused: RefusedSetting[] = []
  if (!baseUrl.ok) refused.push({ key: 'baseUrl', value: typed.baseUrl, reason: baseUrl.reason })
  if (!home.ok) refused.push({ key: 'archonHome', value: typed.archonHome, reason: home.reason })
  return { ok: false, typed, stored: asStored, refused, home: home.ok ? home.value : null }
}
