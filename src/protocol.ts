// The contract between the worker and the frames, declared once. The panel and the worker both
// read it through the type-check, so a name spelled differently on one side does not compile.
import type { ConnectionAnswer, ConnectionView } from './connection-view'
import type { RunsAnswer, RunsRequest } from './runs-view'
import type { LinkRequest, OpenRequest, RegisterRequest, ScopeAnswer } from './scope-view'
import type { SystemAnswer, SystemView } from './system-view'

declare module 'orca' {
  interface PluginRequests {
    /** The connection state. Neither request takes an input. */
    'connection.read': { output: ConnectionAnswer }
    /** "Try again": in Not found and Unsupported, runs discovery at once. */
    'connection.retry': { output: ConnectionAnswer }
    /** The runs table: the counts and rows 0 to N of one status filter, in one answer. */
    'runs.read': { input: RunsRequest; output: RunsAnswer }
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
  }
  interface PluginPanelEvents {
    /** A hint that the person asked to see runs. It carries no data. */
    'show-runs': null
    /** A hint that the focused workspace changed, so the project scope may have. It carries no data. */
    'scope.changed': null
    /** The connection state, posted each time it changes. */
    'connection.changed': ConnectionView
    /** The System group, posted when a read that no request waits for has ended. */
    'system.changed': SystemView
  }
}
