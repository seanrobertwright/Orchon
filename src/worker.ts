// The resident worker. Orca starts it when the plugin is enabled, because the manifest has a
// status bar item beside `main`, and loads this file as written: there is no build step.
import type { OrcaWorkerApi } from 'orca/worker'

/** The manifest text of the status bar item, and what its press answers until runs are counted. */
const STATUS_TEXT = 'Orchon'

export default function activate(orca: OrcaWorkerApi): void {
  // The status bar item's press, also in the palette. It never opens or closes the sidebar: an
  // open panel hears the hint and shows Runs.
  orca.commands.register('show-runs', () => {
    orca.panels.post('show-runs', null)
    return STATUS_TEXT
  })
}
