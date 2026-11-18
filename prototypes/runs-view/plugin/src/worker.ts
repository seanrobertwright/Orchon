// PROTOTYPE. Stands in for the real worker: it answers the panel from made-up runs and never
// calls Archon. The 150 ms wait makes loading states visible.
import type { OrcaWorkerApi } from 'orca/worker'
import { listRuns } from './fixtures'
import './protocol'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('runs.list', async (input) => {
    await wait(150)
    return listRuns(input)
  })

  orca.panels.handle('proto.set', async (input) => {
    orca.panels.post('proto.set', input)
    return { posted: true as const }
  })

  // For the one live check this prototype carries: does a worktree Archon made, once shown in
  // Orca, appear in workspace.list under the path Archon reports as working_path?
  orca.panels.handle('debug.workspaces', async () => {
    const answer = await orca.host.call('workspace.list')
    return {
      workspaces: answer.workspaces.map((row) => ({ path: row.path, kind: row.kind, hostId: row.hostId }))
    }
  })
}
