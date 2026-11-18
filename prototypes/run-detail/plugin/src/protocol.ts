// PROTOTYPE. The panel <-> worker contract, declared once: the panel files and src/worker.ts read it.

/** The four made-up runs. Each is the same 16-step workflow stopped at a different point. */
export type Scenario = 'paused' | 'running' | 'failed' | 'completed'

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed'

export type StepState = 'completed' | 'running' | 'failed' | 'skipped' | 'pending' | 'paused'

export type StepRow = {
  /** Archon's step id; a loop's inner step has a dotted id such as `implement.build`. */
  id: string
  name: string
  /** The loop this step sits under, or null for a top-level step. */
  parent: string | null
  kind: string
  state: StepState
  startedAt: number | null
  endedAt: number | null
  /** How many times the step started. */
  ran: number
}

export type RunDetail = {
  scenario: Scenario
  id: string
  workflow: string
  project: string
  status: RunStatus
  /** The question an attention wait asks, when the run is paused on one. */
  attention: { question: string; options: string[] } | null
  startedAt: number
  endedAt: number | null
  costUsd: number
  message: string
  messageCut: boolean
  worktree: string
  hasConversation: boolean
  steps: StepRow[]
}

export type StepView = {
  step: StepRow
  index: number
  total: number
  prev: string | null
  next: string | null
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  model: string | null
  provider: string | null
  turns: number | null
  stopReason: string | null
  skipReason: string | null
  /** The step's output as plain text, already split into blocks of at most 16 KiB. */
  output: string[]
  outputBytes: number
  outputCut: boolean
  error: string | null
  items: number
  attempts: number
  /** Hook and state events the list leaves out. */
  hidden: number
}

export type ItemKind = 'text' | 'thought' | 'tool' | 'subtask' | 'warning' | 'hook'

export type ItemRow = {
  key: string
  kind: ItemKind
  title: string
  state: string
  at: number
  attempt: number
  /** True on the first item of an attempt, where the divider goes. */
  firstOfAttempt: boolean
}

export type ActivityPage = {
  /** One page in time order, oldest first. */
  rows: ItemRow[]
  /** How many items are older than the first row. */
  earlier: number
}

export type ItemPreview = {
  key: string
  kind: ItemKind
  title: string
  state: string
  at: number
  /** Agent text, thinking, a subtask's summary, a warning or a failed hook's line. */
  text: string | null
  textCut: boolean
  input: string | null
  inputCut: boolean
  output: string | null
  outputCut: boolean
  /** Archon's own `outputTruncated`: it stored only part of the output. */
  archonTruncated: boolean
}

export type ArtifactRow = { path: string; size: number; modifiedAt: number }

export type ArtifactList = {
  /** At most 200 rows, sorted by path. */
  rows: ArtifactRow[]
  matching: number
  total: number
}

/** `lines`: cut at any line break. `blocks`: cut at a blank line, re-opening a fence or a table. */
export type Split = 'lines' | 'blocks'

export type ArtifactBody = {
  path: string
  size: number
  kind: 'markdown' | 'text' | 'too-large' | 'binary'
  blocks: string[]
}

export type RunTab = 'steps' | 'artifacts'

export type Focus = 'all' | 'lower' | 'preview'

/**
 * Where `orca plugin dev request . proto.set` puts the open panel. It is the whole position:
 * a field left out goes back to its default. `{}` clears it, so the panel stays where a person
 * left it the next time it mounts.
 */
export type Remote = {
  variant?: 'A' | 'B' | 'C'
  /** Opens this run's detail; left out, the panel shows the runs table. */
  run?: Scenario
  /** Opens this step's view; left out, the panel shows run detail. */
  step?: string
  tab?: RunTab
  /** Selects this activity item (`i329` is the newest of `implement.build`). */
  item?: string
  filter?: string
  /** Selects this artifact. */
  artifact?: string
  split?: Split
  /**
   * A capture shows only the part of the panel that is on screen, so this leaves out what is
   * above: `lower` starts at the Steps and Artifacts switch (in a step view, at Activity) and
   * `preview` also leaves out the list, so the selected item's or file's preview comes first.
   */
  focus?: Focus
  /** Loads this many more pages of earlier activity. */
  earlier?: number
}

declare module 'orca' {
  interface PluginRequests {
    'run.get': { input: { scenario: Scenario }; output: RunDetail }
    'step.get': { input: { scenario: Scenario; step: string }; output: StepView }
    /** The 50 items before `before` (an item key), or the newest 50 when it is null. */
    'activity.page': { input: { scenario: Scenario; step: string; before: string | null }; output: ActivityPage }
    'activity.item': { input: { scenario: Scenario; step: string; key: string }; output: ItemPreview }
    'artifacts.list': { input: { scenario: Scenario; filter: string }; output: ArtifactList }
    'artifact.read': { input: { scenario: Scenario; path: string; split: Split }; output: ArtifactBody }
    /** Drives the open panel from a terminal, because shots cannot press while Orca's window shows. */
    'proto.set': { input: Remote; output: { posted: true } }
    /** The last `proto.set`, for a panel that was not on screen when it was posted. */
    'proto.get': { output: Remote | null }
  }
  interface PluginPanelEvents {
    'proto.set': Remote
  }
}
