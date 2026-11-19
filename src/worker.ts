// The resident worker. Orca starts it when the plugin is enabled, because the manifest has a
// status bar item beside `main`, and loads this file as written: there is no build step.
import type { OrcaWorkerApi } from 'orca/worker'
import { startConnection, type WorkerPorts } from './connection'
import { realPorts } from './ports'
import { startProjectScope } from './project-scope'
import { startRunDetail } from './run-detail'
import { startRunsTable } from './runs-table'
import { startSettingsForms } from './settings-forms'

/**
 * Everything the worker does, on the ports it is given: the real ones in Orca, scripted ones in
 * the tests. Returns what stops it.
 */
export function start(orca: OrcaWorkerApi, ports: WorkerPorts): () => void {
  const connection = startConnection(orca, ports)
  // The status bar item's press, also in the palette. It never opens or closes the sidebar: an
  // open panel hears the hint and shows Runs, and one that mounts within a minute reads it.
  orca.commands.register('show-runs', () => {
    orca.panels.post('show-runs', connection.needsYou.press())
    return connection.showRunsSentence()
  })
  const projectScope = startProjectScope(orca, {
    client: connection.client,
    current: connection.current,
    platform: ports.platform,
    openDisk: ports.openDisk
  })
  const runsTable = startRunsTable(orca, { ...connection, workspaces: projectScope.workspaces })
  const runDetail = startRunDetail(orca, { ...connection, workspaces: projectScope.workspaces, now: ports.now })
  const forms = startSettingsForms(orca, { client: connection.client, current: connection.current, now: ports.now })
  return () => {
    forms.dispose()
    projectScope.dispose()
    runsTable.dispose()
    runDetail.dispose()
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
