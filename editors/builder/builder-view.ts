// The builder tab's contract with the worker: the requests the tab sends and the view model the
// worker answers. It is types only. It lives beside the tab because the editors compile on their
// own and can import nothing from src/; the worker imports these types from here.
import type { TabConnection } from '../run-graph/graph-view.ts'

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
