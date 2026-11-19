// The connection state as a frame gets it: the view model the worker answers and posts. It is
// types only, so the panel and the worker read one contract and no code crosses between them.

/** The two declared settings that decide where Orchon looks for Archon. */
export type SettingKey = 'baseUrl' | 'archonHome'

/** Where a base URL came from: the setting, `server.json` in the home folder, or the default. */
export type AddressSource = 'setting' | 'server-json' | 'default'

/** A setting value that failed its parse, with the reason as one sentence. */
export type RefusedSetting = {
  key: SettingKey
  /** The value as typed, cut for display. */
  value: string
  /** One sentence. A word between backticks is code. */
  reason: string
}

/** Both connection settings as the person typed them, and the home folder they lead to. */
export type SettingsView = {
  /** Empty when unset, which means automatic discovery. Cut for display. */
  baseUrl: string
  /** Empty when unset, which means the default folder. Cut for display. */
  archonHome: string
  /** The folder in use with a leading `~` expanded, or null while that setting is refused. */
  homeFolder: string | null
}

/**
 * Whether the Archon home folder exists, which picks between the two Not found wordings.
 * `unchecked` when the Base URL is set: the folder is then not looked at.
 */
export type HomeFolder = 'exists' | 'missing' | 'unchecked'

type Stamped = {
  /** When this state was entered, in milliseconds since the epoch. It rises with every change. */
  since: number
  settings: SettingsView
}

/** The optional features a connected server has, each decided by its paths in the path list. */
export type Features = {
  /** `/api/metrics` and `/api/metric-views`, first served by Archon 0.14.0. */
  metrics: boolean
}

export type Searching = Stamped & { kind: 'searching' }
export type Connected = Stamped & {
  kind: 'connected'
  baseUrl: string
  source: AddressSource
  /** The version string health reported. It is shown and never decides anything. */
  version: string | null
  storeId: string | null
  features: Features
  /**
   * Whether the worker holds Archon's dashboard stream open and reads it. While it is false the
   * frames refetch on a short timer, and nothing is disabled.
   */
  live: boolean
}
export type NotFound = Stamped & {
  kind: 'not-found'
  /** The address that did not answer. */
  address: string
  source: AddressSource
  home: HomeFolder
}
export type BadSetting = Stamped & { kind: 'bad-setting'; refused: RefusedSetting[] }
/**
 * A server answered health, but its path list lacks a path Orchon needs, is not JSON, or has no
 * `paths` object. The version is what health reported, shown and never the reason.
 */
export type Unsupported = Stamped & {
  kind: 'unsupported'
  baseUrl: string
  source: AddressSource
  version: string | null
}

/** The worker's one connection state. A frame keeps the one with the greatest `since`. */
export type ConnectionView = Searching | Connected | NotFound | BadSetting | Unsupported

/** What every answer from the worker carries beside its own data. */
export type ConnectionAnswer = { connection: ConnectionView }
