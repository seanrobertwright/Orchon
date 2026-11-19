// The Launch section as a frame gets it: the form's projects and workflows, the draft, the
// Starting view and the callouts of runs that started. It is types and constants only, so the
// panel and the worker read one contract and none of Archon's JSON crosses to the panel. Node
// definitions stay in Archon's answer: a workflow reaches the panel as its name, description and
// source.
import type { ConnectionAnswer } from './connection-view'
import type { ProjectRef } from './scope-view'

/** The most characters a launch message may have. It is sent as typed. */
export const MESSAGE_CAP = 16_000

/** How many Archon projects the project select lists, by name. */
export const PROJECTS_CAP = 200

/** How many workflows the workflow select lists. */
export const WORKFLOWS_CAP = 200

/** Above this many workflows the form shows a filter field. */
export const FILTER_FROM = 20

/** The most characters of a project search or a workflow filter. */
export const SEARCH_CAP = 200

/** The most characters of a workflow name in a frame's request. */
export const WORKFLOW_NAME_CAP = 200

/** How much of a workflow's description the form shows under the select. */
export const DESCRIPTION_CAP = 1_000

/** The most characters of a launch id in a frame's request. */
export const LAUNCH_ID_CAP = 64

/** The most launch records the worker keeps in memory. */
export const RECORDS_CAP = 20

/** How many of the plugin's launch conversation ids plugin storage keeps, newest first. */
export const CONVERSATIONS_KEPT = 500

/** A workflow as the form lists it. */
export type LaunchWorkflow = {
  name: string
  description: string
  /** Where Archon read it from, such as `bundled` or `project`. */
  source: string
  recommended: boolean
}

export type WorkflowsView =
  /** No project is chosen, so no workflow is listed. */
  | { kind: 'none' }
  | {
      kind: 'ready'
      /** Recommended first, then by name; the filter applied; at most `WORKFLOWS_CAP`. */
      rows: LaunchWorkflow[]
      /** How many workflows Archon lists for the project. */
      total: number
      /** How many match the filter, shown or not. */
      matching: number
      /** How many of Archon's rows could not be read and are not shown. */
      unreadable: number
    }
  /** Archon's list passed the read cap. Nothing partial is shown. */
  | { kind: 'too-large' }
  | { kind: 'failed'; message: string }

/** Where a launch stands while the Starting view shows it. */
export type StartingState =
  /** Archon took the launch and starts it. */
  | 'started'
  /** Archon took the launch and waits for a free slot. */
  | 'queued'
  /** The launch call timed out. It is not sent again; the worker looks for the run. */
  | 'looking'
  /** The run was found. */
  | 'found'

export type StartingView = {
  launchId: string
  workflow: string
  /** The project by name. */
  project: string
  state: StartingState
  /** No run after 60 seconds of a launch Archon started: offer "Keep waiting". */
  late: boolean
  /** The run, once found. */
  runId?: string
}

/** A run a launch started, found after its Starting view stopped showing. */
export type LaunchNotice = { launchId: string; workflow: string; runId: string }

export type LaunchView =
  | { kind: 'not-connected' }
  /** The focused workspace is on another host: there is no launcher. */
  | { kind: 'remote' }
  /** Archon's projects could not be read. One sentence for the person. */
  | { kind: 'failed'; message: string }
  | {
      kind: 'ready'
      projects: { rows: ProjectRef[]; more: number; unreadable: number }
      /** The chosen project, or null. */
      codebaseId: string | null
      workflows: WorkflowsView
      /** The chosen workflow, or null. */
      workflow: string | null
      /** The chosen workflow's description, cut, or empty. */
      description: string
      /** The draft's message. */
      message: string
      /** Why the last Start did not launch: Archon's words, or the worker's. */
      error?: string
      /** A launch from this workspace is being posted. */
      posting: boolean
      /**
       * The inputs the draft holds, by name in the workflow's order: filled by Re-run from the
       * run's `metadata.inputs`, kept only for names the chosen workflow declares. Left out when
       * there are none.
       */
      inputs?: DraftInput[]
      /** Sentences about what Re-run filled and what it could not. Left out when there are none. */
      rerunNotes?: string[]
      /** The Starting view, which replaces the form. */
      starting?: StartingView
    }

export type LaunchAnswer = ConnectionAnswer & {
  launch: LaunchView
  /** Runs that started whose callout was not dismissed, newest first. */
  notices: LaunchNotice[]
}

export type NoticesAnswer = ConnectionAnswer & {
  notices: LaunchNotice[]
  /** How many launches are still looking for their run. */
  looking: number
}

/** What a frame's `launch.read` sends. Every key may be left out. */
export type LaunchRequest = {
  /** The panel's project, the default when the draft has none. */
  project?: string
  search?: string
  filter?: string
  /** Read Archon's projects and the workflow list again, as opening the section and refresh do. */
  reload?: boolean
}

/** What `launch.edit` sends: the draft's fields that changed. Null clears a choice. */
export type LaunchEdit = {
  codebaseId?: string | null
  workflow?: string | null
  message?: string
}

/** One input a draft holds: a name the workflow declares and its value as text. */
export type DraftInput = { name: string; value: string }

/** What Re-run sends: the run to fill the launcher from. The worker reads the run itself. */
export type RerunRequest = { runId: string }

/** How many names a Re-run notice lists before "and N more". */
export const NOTE_NAMES_CAP = 10

/** What Start sends. */
export type LaunchStart = { codebaseId: string; workflow: string; message: string }

/** Why Start does not launch a message, said by the panel and the worker alike. */
export const NO_MESSAGE = 'Type a message.'
export const MESSAGE_TOO_LONG = `The message is longer than ${MESSAGE_CAP.toLocaleString('en-US')} characters.`

/** The words of the Starting view and the callout, shared by the panel's tests. */
export const QUEUED_TEXT = 'Queued by Archon, waiting for a free slot'
export const LOOKING_TEXT = 'Archon did not answer in time. Orchon is looking for the run.'
