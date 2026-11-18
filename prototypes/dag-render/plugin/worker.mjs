// PROTOTYPE - throwaway. Stands in for the real worker: serves graphs from a fixture file
// (no call to Archon) and opens a wide tab the way the spec plans to: write a pointer file
// into the focused workspace, then editor.open.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FOLDER = '.orchon-proto'

export default function activate(orca) {
  const { graphs } = JSON.parse(
    readFileSync(new URL('./fixtures/graphs.json', import.meta.url), 'utf8')
  )
  const byName = new Map(graphs.map((g) => [g.name, g]))

  orca.panels.handle('graph.list', async () =>
    graphs.map((g) => ({ name: g.name, nodes: g.nodes.length, synthetic: g.synthetic }))
  )
  orca.panels.handle('graph.get', async (input) => {
    const graph = byName.get(String(input?.name))
    if (!graph) throw Object.assign(new Error('no such graph'), { code: 'invalid_params' })
    return graph
  })

  // The editors report their timings here so they land in `orca plugin logs`.
  orca.panels.handle('stats.report', async (input) => {
    orca.log(String(input?.line).slice(0, 400))
    return { ok: true }
  })

  async function open(suffix) {
    const context = await orca.host.call('workspace.readContext')
    if (!context?.workspaceId) return 'No workspace is focused.'
    const { workspaces } = await orca.host.call('workspace.list')
    const workspace = workspaces.find((w) => w.id === context.workspaceId)
    if (!workspace) return 'The focused workspace is not in workspace.list.'
    if (workspace.hostId && workspace.hostId !== 'local') {
      return `The focused workspace is on ${workspace.hostId}; the worker cannot write there.`
    }
    const dir = join(workspace.path, FOLDER)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.gitignore'), '*\n')
    const name = `archon-build-queue-3f2a9c1b.${suffix}`
    writeFileSync(
      join(dir, name),
      `${JSON.stringify({ workflow: 'archon-build-queue', runId: '3f2a9c1b-prototype' }, null, 2)}\n`
    )
    await orca.host.call('editor.open', {
      workspaceId: workspace.id,
      path: `${FOLDER}/${name}`
    })
    orca.log(`opened ${FOLDER}/${name} in ${workspace.name} (hostId ${workspace.hostId})`)
    return `Opened ${FOLDER}/${name}`
  }

  // Same route as the palette commands, callable with `orca plugin dev request`.
  orca.panels.handle('proto.open', async (input) =>
    open(input?.variant === 'flow' ? 'orchonflow' : 'orchonsvg')
  )
  orca.commands.register('orchon-proto.open-svg', () => open('orchonsvg'))
  orca.commands.register('orchon-proto.open-flow', () => open('orchonflow'))
}
