// The System group as a frame gets it: the view model the worker answers and posts. It is types
// only, so the panel and the worker read one contract and no code crosses between them.
import type { ConnectionView } from './connection-view'

/** Conversations holding a processing slot, and how many slots there are. */
export type Concurrency = { active: number; max: number }

/** The first names of the active platforms, and how many more there are. */
export type Platforms = { names: string[]; more: number }

/** What health reported. A field the server did not send, or sent in another shape, is null. */
export type HealthFacts = {
  status: string | null
  adapter: string | null
  database: string | null
  version: string | null
  storeId: string | null
  concurrency: Concurrency | null
  runningWorkflows: number | null
  platforms: Platforms | null
}

/** The update check, in its four states. */
export type Updates =
  | { kind: 'checking' }
  /** The version is the one the server runs, or null when it did not say. */
  | { kind: 'up-to-date'; version: string | null }
  /** `releaseUrl` is an `https` address on `github.com`, or null when the answer held none. */
  | { kind: 'available'; version: string; releaseUrl: string | null }
  | { kind: 'unavailable' }

export type SystemView = {
  /** When this view was made, in milliseconds since the epoch. It rises with every change. */
  since: number
  /** The newest health answer that could be read, or null before the first one. */
  health: HealthFacts | null
  /** When `health` was read, or null before the first answer. */
  readAt: number | null
  /** The newest health read failed, so `health` is from an earlier answer. */
  failed: boolean
  updates: Updates
}

/** What every System request answers. */
export type SystemAnswer = { connection: ConnectionView; system: SystemView }
