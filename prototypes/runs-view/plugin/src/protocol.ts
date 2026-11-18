// PROTOTYPE. The panel <-> worker contract, declared once: the panel files and src/worker.ts read it.

export type RunStatus = 'running' | 'paused' | 'pending' | 'completed' | 'failed' | 'cancelled'

/** A status filter: one of Archon's statuses, every run, or the runs waiting on a person. */
export type StatusFilter = 'all' | 'attention' | RunStatus

/** Which fixture world the worker answers from. */
export type Scenario = 'matched' | 'unmatched' | 'empty'

export type Scope = 'project' | 'all'

/** Where a run's worktree stands, as the workspace mapping decision splits it. */
export type WorktreeState = 'in-orca' | 'on-disk' | 'missing'

/** The trimmed row the worker hands the panel; the real worker would cut Archon's row down to this. */
export type RunRow = {
  id: string
  workflow: string
  project: string
  message: string
  status: RunStatus
  attention: { kind: string; question: string } | null
  startedAt: number
  endedAt: number | null
  step: { name: string; done: number; total: number } | null
  costUsd: number | null
  worktree: { path: string; state: WorktreeState }
}

export type Counts = Record<StatusFilter, number>

export type RunsListInput = {
  scenario: Scenario
  scope: Scope
  status: StatusFilter
  /** Only runs of this project (variant C groups by project). */
  project?: string
  offset: number
  limit: number
}

export type RunsListOutput = {
  rows: RunRow[]
  /** How many runs match the filter, of which `rows` is one page. */
  total: number
  /** Per-status counts inside the scope, whatever the filter. */
  counts: Counts
  /** Run counts per project inside the scope. */
  projects: { name: string; count: number }[]
  /** The focused Orca project's Archon name, or null when it is unmatched. */
  matchedProject: string | null
}

/** What `orca plugin dev request . proto.set` may change in the open panel. */
export type Remote = {
  variant?: 'A' | 'B' | 'C'
  scenario?: Scenario
  scope?: Scope
  filter?: StatusFilter
  /** Opens the detail stub of the run that needs attention (else the newest run). */
  detail?: boolean
  /** Selects that same run, for the previews of variants A and C. */
  pick?: boolean
  /** Section bar drawn with icons (the default) or with words only. */
  tabIcons?: boolean
}

declare module 'orca' {
  interface PluginRequests {
    /** One page of fixture runs, shaped like a trimmed `GET /api/dashboard/runs` answer. */
    'runs.list': { input: RunsListInput; output: RunsListOutput }
    /** What Orca's `workspace.list` answers, for the worktree path check. */
    'debug.workspaces': { output: { workspaces: { path: string; kind: string; hostId: string | null }[] } }
    /** Drives the open panel from a terminal, because shots cannot press while Orca's window shows. */
    'proto.set': { input: Remote; output: { posted: true } }
  }
  interface PluginPanelEvents {
    'proto.set': Remote
  }
}
