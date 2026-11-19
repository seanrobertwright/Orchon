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

export type BuilderAnswer = { connection: TabConnection; builder: BuilderView }

/** Open YAML: whether Orca opened the file, or the one sentence that says why not. */
export type YamlOpenAnswer = { opened: true } | { opened: false; reason: string }
