// The contract between the worker and the frames, declared once. The panel and the worker both
// read it through the type-check, so a name spelled differently on one side does not compile.
import type { ConnectionAnswer, ConnectionView } from './connection-view'
import type { ConflictChoice, FormGroupId, FormsAnswer, FormsEdit, FormsView } from './forms-view'
import type { RunsAnswer, RunsRequest } from './runs-view'
import type { SystemAnswer, SystemView } from './system-view'

declare module 'orca' {
  interface PluginRequests {
    /** The connection state. Neither request takes an input. */
    'connection.read': { output: ConnectionAnswer }
    /** "Try again": in Not found and Unsupported, runs discovery at once. */
    'connection.retry': { output: ConnectionAnswer }
    /** The runs table: the counts and rows 0 to N of one status filter, in one answer. */
    'runs.read': { input: RunsRequest; output: RunsAnswer }
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
    /** A hint that the person asked to see runs. It carries no data. */
    'show-runs': null
    /** The connection state, posted each time it changes. */
    'connection.changed': ConnectionView
    /** The System group, posted when a read that no request waits for has ended. */
    'system.changed': SystemView
    /** The editable groups, posted when a save or a read that no request waits for has ended. */
    'forms.changed': FormsView
  }
}
