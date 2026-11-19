// The run graph tab's contract with the worker: the request the tab sends and the view model the
// worker answers. It is types only. It lives beside the tab because the editors compile on their
// own and can import nothing from src/; the worker imports these types from here.

/** What the tab sends: the run its pointer file names, and Orca's UI language for the times. */
export type GraphRequest = { runId: string; locale: string }

/** A step's state as the tab shows it, always as a glyph and a word as well as a colour. */
export type GraphStepState = 'running' | 'waiting' | 'queued' | 'not-reached' | 'completed' | 'failed' | 'skipped'

export type GraphStep = {
  /** Archon's node id. A step inside a loop group has its group's id, a dot and its own. */
  id: string
  /** The name drawn on the step. */
  name: string
  /** Archon's kind of node, or null when neither the workflow nor the run names one. */
  kind: string | null
  state: GraphStepState
  glyph: string
  /** The state in a word, such as "Completed". */
  word: string
  /** The loop group that holds the step, or null for a step at the top. */
  group: string | null
  /** A loop group: drawn as a frame around its own steps. */
  isGroup: boolean
  /** A step with a `when`: an edge into it is dashed. */
  conditional: boolean
  /** A line under the name, such as where a paused step is answered, or null. */
  note: string | null
}

/** An edge of the workflow: `to` depends on `from`. Either end may be a loop group. */
export type GraphEdge = { from: string; to: string }

/** The header inside the tab. Every field is plain text, set through `textContent`. */
export type GraphHeader = {
  workflow: string
  /** The first 8 characters of the run id. */
  shortId: string
  /** The run's state as a glyph and a word, such as "✓ Completed". */
  state: string
  /** The start time in the tab's language, or empty when Archon gave none that parses. */
  started: string
  /** Whether the run has ended, so its arrows come from the workflow as it is now. */
  finished: boolean
}

export type GraphView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /** Archon has no run with this id. */
  | { kind: 'gone' }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }
  /** The run has no project, or Archon no longer lists it: there is no workflow file to draw. */
  | { kind: 'no-graph'; header: GraphHeader; message: string }
  /** More steps than one graph lays out. */
  | { kind: 'too-many'; header: GraphHeader; count: number; cap: number }
  | {
      kind: 'ready'
      header: GraphHeader
      /**
       * Null when the workflow file matches the run. Otherwise the file has changed or been
       * deleted since the run, and the steps are the run's own, in run order, with no edges.
       */
      mismatch: null | 'changed' | 'deleted'
      steps: GraphStep[]
      edges: GraphEdge[]
    }

/** A state screen in the tab's own HTML. A word between backticks in a line is code. */
export type TabScreen = {
  title: string
  lines: string[]
  /** A command shown as code after the lines, such as `archon serve`, or null. */
  command: string | null
  /** Lines after the command. */
  after: string[]
  /** Whether the screen offers Try again, which asks the worker to look for Archon at once. */
  tryAgain: boolean
  /** The installation guide's address when the screen links it, or null. */
  install: string | null
}

/** The connection as the tab draws it. */
export type TabConnection =
  | { kind: 'connected'; live: boolean }
  /** Searching: the banner over data, and the label when there is none. */
  | { kind: 'searching'; banner: string; label: string }
  | { kind: 'screen'; screen: TabScreen }

export type GraphAnswer = { connection: TabConnection; graph: GraphView }
