// The resident worker. Orca starts it when the plugin is enabled, because the manifest has a
// status bar item beside `main`, and loads this file as written: there is no build step.
import type { OrcaWorkerApi } from 'orca/worker'
import { startConnection, type WorkerPorts } from './connection'
import { realPorts } from './ports'
import { startProjectScope } from './project-scope'
import { startRunsTable } from './runs-table'
import { startSettingsForms } from './settings-forms'

/** The manifest text of the status bar item, and what its press answers until runs are counted. */
const STATUS_TEXT = 'Orchon'

/**
 * Everything the worker does, on the ports it is given: the real ones in Orca, scripted ones in
 * the tests. Returns what stops it.
 */
export function start(orca: OrcaWorkerApi, ports: WorkerPorts): () => void {
  // The status bar item's press, also in the palette. It never opens or closes the sidebar: an
  // open panel hears the hint and shows Runs.
  orca.commands.register('show-runs', () => {
    orca.panels.post('show-runs', null)
    return STATUS_TEXT
  })
  const connection = startConnection(orca, ports)
  const projectScope = startProjectScope(orca, {
    client: connection.client,
    current: connection.current,
    platform: ports.platform,
    openDisk: ports.openDisk
  })
  const runsTable = startRunsTable(orca, { ...connection, workspaces: projectScope.workspaces })
  const forms = startSettingsForms(orca, { client: connection.client, current: connection.current, now: ports.now })
  return () => {
    forms.dispose()
    projectScope.dispose()
    runsTable.dispose()
    connection.stop()
  }
}

let stop: (() => void) | undefined

export default function activate(orca: OrcaWorkerApi): void {
  stop = start(orca, realPorts())
}

/** Orca awaits this before it stops the worker: no timer or request outlives it. */
export function deactivate(): void {
  stop?.()
  stop = undefined
}
