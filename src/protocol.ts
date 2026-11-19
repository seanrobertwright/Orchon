// The contract between the worker and the frames, declared once. The panel and the worker both
// read it through the type-check, so a name spelled differently on one side does not compile.
import type { ConnectionAnswer, ConnectionView } from './connection-view'
import type { ConflictChoice, FormGroupId, FormsAnswer, FormsEdit, FormsView } from './forms-view'
import type { RunsHint, ShowRuns } from './hint-view'
import type { RunDetailAnswer, RunDetailRequest } from './run-detail-view'
import type { RunsAnswer, RunsRequest } from './runs-view'
import type { LinkRequest, OpenRequest, RegisterRequest, ScopeAnswer } from './scope-view'
import type { SystemAnswer, SystemView } from './system-view'

declare module 'orca' {
  interface PluginRequests {
    /**
     * The connection state. Neither request takes an input. The read also carries the last press
     * of "Orchon: Show runs" while the worker remembers it, for a panel that mounts after it.
     */
    'connection.read': { output: ConnectionAnswer & { showRuns?: ShowRuns } }
    /** "Try again": in Not found and Unsupported, runs discovery at once. */
    'connection.retry': { output: ConnectionAnswer }
    /** The runs table: the counts and rows 0 to N of one status filter, in one answer. */
    'runs.read': { input: RunsRequest; output: RunsAnswer }
    /** Run detail: one run's facts, its steps and what it waits for, in one answer. */
    'run.read': { input: RunDetailRequest; output: RunDetailAnswer }
    /** The project scope of the focused workspace. It takes no input. */
    'scope.read': { output: ScopeAnswer }
    /** Links the focused Orca project to an Archon project Archon lists, or changes its link. */
    'scope.link': { input: LinkRequest; output: ScopeAnswer }
    /** Clears the focused Orca project's link. It takes no input. */
    'scope.unlink': { output: ScopeAnswer }
    /** Registers the main checkout folder the person confirmed with Archon, then reads the scope again. */
    'scope.register': { input: RegisterRequest; output: ScopeAnswer }
    /** Open in Orca: shows a workspace Orca lists, through `workspace.open`. */
    'workspace.open': { input: OpenRequest; output: null }
    /**
     * The Settings section began to show: reads health and the update check at once, then health
     * every 30 seconds until `system.close`. The System requests take no input.
     */
    'system.open': { output: SystemAnswer }
    /** Refresh: reads health and the update check at once. */
    'system.refresh': { output: SystemAnswer }
    /** The Settings section no longer shows: health is no longer read on the timer. */
    'system.close': { output: null }
    /**
     * Reads Archon's config and its providers. A group with unsaved edits keeps them and is not
     * refilled. It takes no input.
     */
    'forms.read': { output: FormsAnswer }
    /** New values for some fields of one group, kept in the worker's unsaved form. */
    'forms.edit': { input: FormsEdit; output: FormsAnswer }
    /** Returns one group to its loaded values. */
    'forms.discard': { input: { group: FormGroupId }; output: FormsAnswer }
    /**
     * Saves one group. The answer comes at once: with the group saving when the save started, and
     * then its outcome is posted as `forms.changed`; with the failed checks on their fields, and
     * nothing sent, when it did not.
     */
    'forms.save': { input: { group: FormGroupId }; output: FormsAnswer }
    /** Settles a save stopped by an outside change: load, overwrite or keep editing. */
    'forms.resolve': { input: { group: FormGroupId; choice: ConflictChoice }; output: FormsAnswer }
  }
  interface PluginPanelEvents {
    /**
     * A hint that the person asked to see runs: when, and whether runs needed you then. It carries
     * no run data. Null is read as a press with no runs that need you.
     */
    'show-runs': ShowRuns | null
    /** A hint that the focused workspace changed, so the project scope may have. It carries no data. */
    'scope.changed': null
    /** The connection state, posted each time it changes. */
    'connection.changed': ConnectionView
    /** A hint that runs changed in Archon, at most one a second. It carries no run data. */
    'runs.changed': RunsHint
    /** A hint that the snapshot of runs that need you changed. It carries no data. */
    'needs-you.changed': null
    /** The System group, posted when a read that no request waits for has ended. */
    'system.changed': SystemView
    /** The editable groups, posted when a save or a read that no request waits for has ended. */
    'forms.changed': FormsView
  }
}
