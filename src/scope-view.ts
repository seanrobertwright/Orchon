// The project scope as a frame gets it: which Archon project the focused workspace matches, and
// what Link and Register may offer. It is types and constants only, so the panel and the worker
// read one contract and none of Archon's JSON crosses to the panel.
import type { ConnectionAnswer } from './connection-view'

/** An Archon project as the panel names it. */
export type ProjectRef = { id: string; name: string }

/** How many Archon projects the link chooser lists, by name. */
export const CHOICES_CAP = 100

/** The Archon projects a link may name: the first by name, and how many are not shown. */
export type LinkChoices = {
  projects: ProjectRef[]
  /** How many listed projects are past the cap and not shown. */
  more: number
  /** How many of Archon's rows could not be read and are not shown. */
  unreadable: number
}

export type ScopeView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /** No workspace is focused in Orca. */
  | { kind: 'no-workspace' }
  /** The focused workspace is on another host: matching, Link and Register are off. */
  | { kind: 'remote' }
  | {
      kind: 'matched'
      project: ProjectRef
      /** `link` when the person made the match by hand. */
      by: 'link' | 'path' | 'remote'
      choices: LinkChoices
    }
  | {
      kind: 'unmatched'
      /** The main checkout folder Register would send, left out when the project is not a Git repository. */
      registerFolder?: string
      choices: LinkChoices
    }
  /** Archon's list of projects could not be read. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type ScopeAnswer = ConnectionAnswer & {
  scope: ScopeView
  /** Why a Link or Register press changed nothing, one sentence. Left out when it did. */
  refused?: string
}

/** What Link sends: the Archon project to link the focused Orca project to. */
export type LinkRequest = { projectId: string }

/** What Register sends: the exact folder the person confirmed. */
export type RegisterRequest = { folder: string }

/** What Open in Orca sends: the workspace a run's folder belongs to. */
export type OpenRequest = { workspaceId: string }
