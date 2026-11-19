// The Workflows section as a frame gets it: a project select, the workflows Archon lists with
// where each comes from, and the outcome of a Delete. It is types and constants only, so the
// panel and the worker read one contract and none of Archon's JSON crosses to the panel. Node
// definitions stay in Archon's answer.
import type { ConnectionAnswer } from './connection-view'
import type { ProjectRef } from './scope-view'

/** How many workflows the section lists. Past it a line says how many are not shown. */
export const SECTION_WORKFLOWS_CAP = 200

/** How many Archon projects the project select lists, by name. */
export const SECTION_PROJECTS_CAP = 200

/** The most characters of a project or workflow search. */
export const SECTION_SEARCH_CAP = 200

/** How much of a workflow's description a row shows. */
export const SECTION_DESCRIPTION_CAP = 1_000

/** The most characters of a workflow name Delete takes. */
export const DELETE_NAME_CAP = 200

/**
 * The closed set of names Delete takes: a letter, digit or `_` first, then letters, digits, `.`,
 * `_` and `-`, and never `..`. Archon refuses a name with a separator or a leading dot; this is
 * narrower still, so the name is safe in a URL path and a file name.
 */
export const DELETE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** Whether Delete takes this workflow name. */
export function isDeletableName(name: string): boolean {
  return name.length <= DELETE_NAME_CAP && DELETE_NAME_PATTERN.test(name) && !name.includes('..')
}

/** One workflow as the section lists it. */
export type SectionWorkflow = {
  name: string
  description: string
  /** Where Archon read it from: `project`, `global`, `bundled` or `installed`. */
  source: string
  /** Delete is offered: a project or global workflow whose name Delete takes. */
  deletable: boolean
}

export type SectionList =
  | {
      kind: 'ready'
      /** By name; the search applied; at most `SECTION_WORKFLOWS_CAP`. */
      rows: SectionWorkflow[]
      /** How many workflows Archon lists here. */
      total: number
      /** How many match the search, shown or not. */
      matching: number
      /** How many of Archon's rows could not be read and are not shown. */
      unreadable: number
    }
  /** Archon's list passed the read cap. Nothing partial is shown. */
  | { kind: 'too-large' }
  | { kind: 'failed'; message: string }

export type WorkflowsSectionView =
  | { kind: 'not-connected' }
  /** Archon's projects could not be read. One sentence for the person. */
  | { kind: 'failed'; message: string }
  | {
      kind: 'ready'
      projects: { rows: ProjectRef[]; more: number; unreadable: number }
      /** The chosen project, or null: then only global, bundled and installed workflows are listed. */
      codebaseId: string | null
      /** The chosen project's `default_cwd` as Archon spells it, which a project Delete names. */
      folder: string | null
      /**
       * The folder the workflows are read from, when the focused workspace is a different folder.
       * Null when they are the same, with no project, or with no local workspace focused.
       */
      readFrom: string | null
      list: SectionList
    }

export type WorkflowsAnswer = ConnectionAnswer & { workflows: WorkflowsSectionView }

/** What a frame's `workflows.read` sends. Every key may be left out. */
export type WorkflowsRequest = {
  /** The chosen project. Left out: no project. */
  project?: string
  search?: string
  filter?: string
  /** Read Archon's projects and the workflow list again, as opening the section and Refresh do. */
  reload?: boolean
}

/** What Delete sends: the workflow by name, and the project whose list it is in, or null. */
export type WorkflowDelete = { name: string; codebaseId: string | null }

export type DeleteOutcome = { kind: 'deleted'; name: string } | { kind: 'failed'; name: string; message: string }

export type DeleteAnswer = WorkflowsAnswer & { outcome: DeleteOutcome }

/** The worker's own refusals of a Delete. */
export const NOT_DELETABLE = 'Orchon deletes only project and global workflows that Archon lists here. Refresh and try again.'
export const DELETE_TIMED_OUT = 'Archon did not answer in time, so it is not known whether the workflow was deleted. The list has been read again.'
