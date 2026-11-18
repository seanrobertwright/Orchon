// PROTOTYPE - throwaway. Worker for the workflow builder screen prototype.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FOLDER = '.orchon-proto'

function makeOversizedWorkflow() {
  const nodes = []
  for (let i = 1; i <= 320; i++) {
    const kind = i % 5 === 0 ? 'bash' : i % 11 === 0 ? 'approval' : 'prompt'
    const node = {
      id: `step-${String(i).padStart(3, '0')}`,
      label: `Step ${i}`,
      kind,
      dependsOn: i === 1 ? [] : [`step-${String(i - 1).padStart(3, '0')}`]
    }
    if (kind === 'prompt') node.prompt = `Run automated check #${i}`
    if (kind === 'bash') node.command = `echo "check ${i}"`
    if (kind === 'approval') {
      node.message = `Gate #${i}`
      node.options = ['Continue']
    }
    nodes.push(node)
  }
  return {
    key: 'project:oversized-pipeline',
    name: 'oversized-pipeline',
    scope: 'project',
    file: '.archon/workflows/oversized-pipeline.yaml',
    description: '320-node workflow (>300 cap) to test outline-only editing when the canvas is disabled.',
    nodes
  }
}

export default function activate(orca) {
  const { workflows } = JSON.parse(
    readFileSync(new URL('./fixtures/workflows.json', import.meta.url), 'utf8')
  )
  const savedMap = new Map(workflows.map((w) => [w.key, w]))
  const oversized = makeOversizedWorkflow()
  savedMap.set(oversized.key, oversized)

  orca.panels.handle('builder.list', async () =>
    [...savedMap.values()].map((w) => ({
      key: w.key,
      name: w.name,
      scope: w.scope,
      file: w.file,
      nodeCount: w.nodes.length
    }))
  )

  orca.panels.handle('builder.load', async (input) => {
    const key = String(input?.key || 'project:archon-assist')
    const saved = savedMap.get(key)
    if (!saved) throw Object.assign(new Error(`Unknown workflow: ${key}`), { code: 'invalid_params' })
    const t0 = performance.now()
    const draft = await orca.storage.get(`draft:${key}`)
    const storageMs = performance.now() - t0
    return { saved, draft: draft ?? null, storageMs }
  })

  orca.panels.handle('builder.saveDraft', async (input) => {
    const key = String(input?.key || '')
    if (!savedMap.has(key)) throw Object.assign(new Error('Unknown workflow'), { code: 'invalid_params' })
    await orca.storage.set(`draft:${key}`, input.draft)
    return { ok: true }
  })

  orca.panels.handle('builder.discardDraft', async (input) => {
    const key = String(input?.key || '')
    await orca.storage.delete(`draft:${key}`)
    return { ok: true }
  })

  orca.panels.handle('builder.save', async (input) => {
    const key = String(input?.key || '')
    if (!savedMap.has(key)) throw Object.assign(new Error('Unknown workflow'), { code: 'invalid_params' })
    savedMap.set(key, input.workflow)
    await orca.storage.delete(`draft:${key}`)
    orca.log(`saved ${key} (${input.workflow.nodes.length} nodes)`)
    return { ok: true, saved: input.workflow }
  })

  orca.panels.handle('builder.validate', async (input) => {
    const wf = input?.workflow
    const serverErrors = []
    if (!wf?.nodes?.length) {
      serverErrors.push('Workflow must declare at least one node.')
    }
    if (wf?.nodes?.some((n) => n.kind === 'approval') && wf.nodes.length > 2) {
      serverErrors.push('Server check: approval gates in unattended runs require a timeout or fallback route.')
    }
    if (wf?.nodes?.some((n) => !n.when && n.triggerRule === 'one_success')) {
      serverErrors.push('Server check: one_success triggerRule has no effect when all upstream nodes are unconditional.')
    }
    return { valid: serverErrors.length === 0, errors: serverErrors }
  })

  orca.panels.handle('proto.log', async (input) => {
    orca.log(String(input?.line || '').slice(0, 400))
    return { ok: true }
  })

  async function open(key = 'project:archon-assist') {
    const context = await orca.host.call('workspace.readContext')
    if (!context?.workspaceId) return 'No workspace is focused.'
    const { workspaces } = await orca.host.call('workspace.list')
    const workspace = workspaces.find((w) => w.id === context.workspaceId)
    if (!workspace) return 'The focused workspace is not in workspace.list.'
    if (workspace.hostId && workspace.hostId !== 'local') {
      return `The focused workspace is on ${workspace.hostId}; the worker cannot write there.`
    }
    const wf = savedMap.get(key) ?? savedMap.get('project:archon-assist')
    const dir = join(workspace.path, FOLDER)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.gitignore'), '*\n')
    // Include scope in the pointer filename so two workflows sharing a name (project vs global) stay distinct.
    const slug = `${wf.scope}-${wf.name}`.replace(/[^a-zA-Z0-9._-]+/g, '-')
    const name = `${slug}.orchonbuilder`
    writeFileSync(
      join(dir, name),
      `${JSON.stringify({ key: wf.key, name: wf.name, scope: wf.scope }, null, 2)}\n`
    )
    await orca.host.call('editor.open', {
      workspaceId: workspace.id,
      path: `${FOLDER}/${name}`
    })
    orca.log(`opened ${FOLDER}/${name} in ${workspace.name}`)
    return `Opened ${FOLDER}/${name}`
  }

  orca.panels.handle('proto.open', async (input) => open(input?.key))
  orca.commands.register('orchon-builder-proto.open', () => open('project:archon-assist'))
}
