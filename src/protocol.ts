// The contract between the worker and the frames, declared once. The panel and the worker both
// read it through the type-check, so a name spelled differently on one side does not compile.
import type { ConnectionAnswer, ConnectionView } from './connection-view'
import type { RunsAnswer, RunsRequest } from './runs-view'

declare module 'orca' {
  interface PluginRequests {
    /** The connection state. Neither request takes an input. */
    'connection.read': { output: ConnectionAnswer }
    /** "Try again": in Not found and Unsupported, runs discovery at once. */
    'connection.retry': { output: ConnectionAnswer }
    /** The runs table: the counts and rows 0 to N of one status filter, in one answer. */
    'runs.read': { input: RunsRequest; output: RunsAnswer }
  }
  interface PluginPanelEvents {
    /** A hint that the person asked to see runs. It carries no data. */
    'show-runs': null
    /** The connection state, posted each time it changes. */
    'connection.changed': ConnectionView
  }
}
