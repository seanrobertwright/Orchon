// The worktree line of a run, which the runs table's preview and run detail both draw: **Open in
// Orca** when Orca lists the run's folder as a workspace, and otherwise the hint about Orca's
// Non-Orca worktrees setting.
import { Button, plugin, Row, Text, type OrcaNode } from 'orca'
import type { RunRow } from './runs-view'

/** Opens the workspace a run's folder belongs to. A failed request changes nothing. */
function openInOrca(workspaceId: string): void {
  plugin.request('workspace.open', { workspaceId }).then(
    () => {},
    () => {}
  )
}

/**
 * Under the worktree: **Open in Orca** when Orca lists the run's folder as a workspace, and
 * otherwise the hint about Orca's Non-Orca worktrees setting. Whether the folder exists is not
 * checked: the worker's closed disk list of #32 has no such read.
 */
export function worktreeLine(run: Pick<RunRow, 'workingPath' | 'workspaceId'>): OrcaNode {
  if (run.workingPath === null) return null
  const { workspaceId } = run
  if (workspaceId !== undefined) {
    return (
      <Row>
        <Button size="sm" variant="outline" onPress={() => openInOrca(workspaceId)}>
          Open in Orca
        </Button>
      </Row>
    )
  }
  return (
    <Text muted size="sm">
      Orca does not show this worktree. To open it in Orca, show it in the project's Non-Orca worktrees setting.
    </Text>
  )
}
