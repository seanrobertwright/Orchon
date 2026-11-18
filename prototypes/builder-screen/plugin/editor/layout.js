// PROTOTYPE - throwaway. Dagre layout, read-only rules, local validation, and YAML preview.
import dagre from '../vendor/dagre.esm.js'

export const NODE_W = 196
export const NODE_H = 52
export const MAX_CANVAS_NODES = 300

const EDITABLE_KINDS = new Set(['prompt', 'bash', 'script', 'loop', 'approval'])

export function isReadOnlyNode(node) {
  if (!node) return false
  if (node.readOnlyReason) return true
  return !EDITABLE_KINDS.has(node.kind)
}

export function validateLocal(workflow) {
  const errors = []
  const byNode = new Map()
  const add = (nodeId, message) => {
    errors.push({ nodeId, message })
    if (!nodeId) return
    if (!byNode.has(nodeId)) byNode.set(nodeId, [])
    byNode.get(nodeId).push(message)
  }

  const seen = new Set()
  const ids = new Set(workflow.nodes.map((n) => n.id))
  for (const n of workflow.nodes) {
    if (!n.id || !n.id.trim()) {
      add(n.id || '(unnamed)', 'Node id cannot be empty.')
    } else if (seen.has(n.id)) {
      add(n.id, `Duplicate node id "${n.id}".`)
    }
    seen.add(n.id)

    for (const dep of n.dependsOn || []) {
      if (!ids.has(dep)) {
        add(n.id, `Depends on missing node "${dep}".`)
      }
      if (dep === n.id) {
        add(n.id, 'Node cannot depend on itself.')
      }
    }

    if (!isReadOnlyNode(n)) {
      if (n.kind === 'prompt' && !(n.prompt || '').trim()) {
        add(n.id, 'Prompt text is required.')
      }
      if ((n.kind === 'bash' || n.kind === 'script') && !(n.command || '').trim()) {
        add(n.id, 'Command is required.')
      }
      if (n.kind === 'loop' && (!n.maxIterations || Number(n.maxIterations) < 1)) {
        add(n.id, 'Loop maxIterations must be at least 1.')
      }
    }
  }

  // Cycle check (Kahn / DFS)
  const state = new Map() // 0=unvisited, 1=visiting, 2=done
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]))
  function dfs(id) {
    state.set(id, 1)
    const node = byId.get(id)
    for (const dep of node?.dependsOn || []) {
      if (!byId.has(dep)) continue
      const st = state.get(dep) ?? 0
      if (st === 1) {
        add(id, `Dependency cycle involving "${id}" and "${dep}".`)
      } else if (st === 0) {
        dfs(dep)
      }
    }
    state.set(id, 2)
  }
  for (const n of workflow.nodes) {
    if ((state.get(n.id) ?? 0) === 0) dfs(n.id)
  }

  return { errors, byNode }
}

export function layoutGraph(workflow, direction = 'TB') {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]))
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: direction, nodesep: 28, ranksep: 48, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of workflow.nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H })
  }
  const edges = []
  for (const n of workflow.nodes) {
    for (const dep of n.dependsOn || []) {
      if (!byId.has(dep) || dep === n.id || g.hasEdge(dep, n.id)) continue
      g.setEdge(dep, n.id, {})
      edges.push({ id: `${dep}->${n.id}`, from: dep, to: n.id, conditional: Boolean(n.when) })
    }
  }
  dagre.layout(g)

  const nodes = workflow.nodes.map((n) => {
    const p = g.node(n.id)
    return {
      id: n.id,
      data: n,
      x: p.x - p.width / 2,
      y: p.y - p.height / 2,
      w: p.width,
      h: p.height
    }
  })
  for (const e of edges) {
    e.points = g.edge(e.from, e.to).points
  }
  const size = g.graph()
  return {
    width: Math.max(size.width || 240, 240),
    height: Math.max(size.height || 180, 180),
    nodes,
    edges
  }
}

export function edgePath(points) {
  if (!points || points.length < 2) return ''
  if (points.length < 3) return `M${points.map((p) => `${p.x},${p.y}`).join('L')}`
  let d = `M${points[0].x},${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2
    const my = (points[i].y + points[i + 1].y) / 2
    d += `Q${points[i].x},${points[i].y} ${mx},${my}`
  }
  const last = points[points.length - 1]
  return `${d}L${last.x},${last.y}`
}

export function clipLabel(text, max = 21) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function toYaml(workflow) {
  const lines = [
    `name: ${workflow.name}`,
    `description: ${JSON.stringify(workflow.description || '')}`,
    'nodes:'
  ]
  for (const n of workflow.nodes) {
    lines.push(`  - id: ${n.id}`)
    if (n.label && n.label !== n.id) lines.push(`    label: ${JSON.stringify(n.label)}`)
    lines.push(`    kind: ${n.kind}`)
    if (n.dependsOn?.length) {
      lines.push(`    depends_on: [${n.dependsOn.join(', ')}]`)
    }
    if (n.prompt) lines.push(`    prompt: ${JSON.stringify(n.prompt)}`)
    if (n.command) lines.push(`    command: ${JSON.stringify(n.command)}`)
    if (n.runtime) lines.push(`    runtime: ${n.runtime}`)
    if (n.model) lines.push(`    model: ${n.model}`)
    if (n.maxIterations != null) lines.push(`    max_iterations: ${n.maxIterations}`)
    if (n.until) lines.push(`    until: ${JSON.stringify(n.until)}`)
    if (n.interactive) lines.push(`    interactive: true`)
    if (n.freshContext) lines.push(`    fresh_context: true`)
    if (n.when) lines.push(`    when: ${JSON.stringify(n.when)}`)
    if (n.triggerRule) lines.push(`    trigger_rule: ${n.triggerRule}`)
    if (n.message) lines.push(`    message: ${JSON.stringify(n.message)}`)
    if (n.options?.length) lines.push(`    options: ${JSON.stringify(n.options)}`)
    if (n.extra) {
      for (const [k, v] of Object.entries(n.extra)) {
        lines.push(`    ${k}: ${JSON.stringify(v)}`)
      }
    }
  }
  return lines.join('\n')
}
