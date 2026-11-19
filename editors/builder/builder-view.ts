// The builder tab's contract with the worker: the requests the tab sends, the view model the
// worker answers, and the caps both sides hold them to. It lives beside the tab because the
// editors compile on their own and can import nothing from src/; the worker imports it from here.
import type { TabConnection } from '../run-graph/graph-view.ts'

/** The most characters of a workflow name the builder's requests and pointer files take. */
export const WORKFLOW_NAME_CAP = 200
/** The most characters of a scope the builder's requests and pointer files take. */
export const SCOPE_CAP = 40
/** The largest definition the builder opens, in bytes of its JSON text (#16). */
export const DEFINITION_CAP_BYTES = 1024 * 1024

/** A size in mebibytes to one decimal place, such as `1.0 MiB`. */
export const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

/** The workflow a builder pointer file names. */
export type BuilderIdentity = { name: string; codebaseId: string | null; scope: string }

/** What the tab sends to read its workflow: its identity, and Orca's UI language. */
export type BuilderRequest = BuilderIdentity & { locale: string }

/** The header inside the tab. Every field is plain text, set through `textContent`. */
export type BuilderHeader = {
  name: string
  /** Where Archon reads the workflow from now: `project`, `global`, `bundled` or `installed`. */
  source: string
  /** Which file the builder shows, in words, such as a path. */
  file: string
  /** An installed workflow: it can only be viewed here. */
  viewOnly: boolean
  /** Whether Open YAML can open the file: it sits inside a local Orca workspace. */
  openYaml: boolean
}

export type BuilderView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /** Archon has no such workflow here, or no longer lists its project. One sentence for the person. */
  | { kind: 'gone'; message: string }
  /** The read failed. One sentence for the person. */
  | { kind: 'failed'; message: string }
  /** The definition is over the builder's cap, so it is not sent. */
  | { kind: 'too-large'; header: BuilderHeader; bytes: number | null; cap: number }
  | {
      kind: 'ready'
      header: BuilderHeader
      /**
       * The definition as authored: a record with a `nodes` list of records, checked by the
       * worker. An installed workflow, which Archon sends only normalised, comes as that.
       */
      definition: Record<string, unknown>
    }

/** The tab's read: the connection, the workflow as Archon serves it, and its draft, when one is kept. */
export type BuilderAnswer = { connection: TabConnection; builder: BuilderView; draft?: BuilderDraftView | null }

/** Open YAML: whether Orca opened the file, or the one sentence that says why not. */
export type YamlOpenAnswer = { opened: true } | { opened: false; reason: string }

/**
 * The copy a save expects Archon to serve now: where Archon reads it from and its authored form.
 * The tab sends the copy it opened; after a save, the one it saved.
 */
export type BuilderBase = { source: string; authored: Record<string, unknown> }

/**
 * Save: the workflow's identity, the definition to write, and the copy Archon is expected to
 * serve, or null when it is expected to serve none (an overwrite of a workflow removed outside).
 */
export type BuilderSaveRequest = BuilderRequest & { definition: Record<string, unknown>; base: BuilderBase | null }

/** Validate: the definition to check, and Orca's UI language. Nothing is written. */
export type BuilderValidateRequest = { definition: Record<string, unknown>; locale: string }

/** The most of Archon's validation sentences a view lists; past it `more` says how many are not shown. */
export const VALIDATION_ERRORS_CAP = 20

/** Archon's validation: its sentences, which name no node, at most the cap of them. */
export type ValidationErrors = { errors: string[]; more: number }

export type BuilderSaveOutcome =
  /** Archon holds the definition now, read from `source`: the copy later checks compare against. */
  | { kind: 'saved'; source: string }
  /** Nothing was sent, for the reason given: the worker's own rule, such as one save at a time. */
  | { kind: 'refused'; message: string }
  /**
   * The workflow changed outside the builder since the copy it opened, so nothing was written.
   * `current` is what Archon serves now, or null when it serves none; an overwrite sends it as the base.
   */
  | { kind: 'changed'; message: string; current: BuilderBase | null }
  /** Archon's validation rejected the definition, so it was not saved. */
  | ({ kind: 'invalid' } & ValidationErrors)
  /** A request to Archon failed or Archon refused the write. One sentence for the person. */
  | { kind: 'failed'; message: string }
  /**
   * The write was not answered in time and was not sent again. The worker read the workflow
   * again: `landed` says whether Archon holds the definition, or is null when the read failed.
   */
  | { kind: 'timeout'; landed: boolean | null; message: string; source: string | null }

export type BuilderSaveAnswer = { connection: TabConnection; save: BuilderSaveOutcome }

export type BuilderValidateOutcome =
  | { kind: 'valid' }
  | ({ kind: 'invalid' } & ValidationErrors)
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string }

export type BuilderValidateAnswer = { connection: TabConnection; validate: BuilderValidateOutcome }

/** The most drafts plugin storage keeps. At the cap a draft of another workflow is refused until one is saved or discarded. */
export const BUILDER_DRAFTS_CAP = 20
/** How long the worker waits after a draft's last change before it writes it to plugin storage. */
export const BUILDER_DRAFT_WRITE_PAUSE_MS = 1_000
/** How long the tab waits after the last edit before it hands its draft to the worker. */
export const BUILDER_DRAFT_SEND_PAUSE_MS = 500
/** The most characters of the file words a draft keeps, to show while Archon is away. */
export const DRAFT_FILE_CAP = 2_000

/** A draft the tab hands to the worker: the workflow's identity, the copy as it stands, the copy the edit started from, and the file in words. */
export type BuilderDraftWrite = BuilderIdentity & { definition: Record<string, unknown>; base: BuilderBase | null; file: string }

/** Whether the worker kept the draft, or the one sentence that says why not. */
export type BuilderDraftWriteAnswer = { kept: true } | { kept: false; reason: string }

/**
 * A draft as a tab's read gives it back: the copy as it was left, the copy the edit started
 * from (null when Archon held none), the file in words, whether it is a new workflow never
 * saved, and whether it was made on a different Archon from the one connected now.
 */
export type BuilderDraftView = { definition: Record<string, unknown>; base: BuilderBase | null; file: string; isNew: boolean; otherArchon: boolean }
