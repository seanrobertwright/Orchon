// PROTOTYPE - throwaway. One dagre layout shared by both variants, so the comparison is about
// drawing, not about where the nodes land.
import dagre from '../vendor/dagre.esm.js'

export const NODE_W = 190
export const NODE_H = 46

/** graph: { nodes: [{ id, parent, dependsOn, when, ... }] }, direction: 'TB' | 'LR'. */
export function layoutGraph(graph, direction = 'TB') {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const children = new Map()
  for (const n of graph.nodes) {
    if (!n.parent) continue
    if (!children.has(n.parent)) children.set(n.parent, [])
    children.get(n.parent).push(n)
  }
  const isGroup = (id) => (children.get(id)?.length ?? 0) > 0

  // dagre cannot route an edge that touches a cluster, so an edge into a group goes to the
  // group's first steps and an edge out of it leaves from its last steps.
  const entries = (id) =>
    isGroup(id)
      ? children
          .get(id)
          .filter((c) => c.dependsOn.length === 0)
          .flatMap((c) => entries(c.id))
      : [id]
  const exits = (id) => {
    if (!isGroup(id)) return [id]
    const kids = children.get(id)
    const depended = new Set(kids.flatMap((c) => c.dependsOn))
    return kids.filter((c) => !depended.has(c.id)).flatMap((c) => exits(c.id))
  }

  const g = new dagre.graphlib.Graph({ compound: true })
  g.setGraph({ rankdir: direction, nodesep: 28, ranksep: 46, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of graph.nodes) {
    g.setNode(n.id, isGroup(n.id) ? {} : { width: NODE_W, height: NODE_H })
  }
  for (const n of graph.nodes) {
    if (n.parent && byId.has(n.parent)) g.setParent(n.id, n.parent)
  }
  const edges = []
  for (const n of graph.nodes) {
    for (const dep of n.dependsOn) {
      if (!byId.has(dep)) continue
      for (const from of exits(dep)) {
        for (const to of entries(n.id)) {
          if (from === to || g.hasEdge(from, to)) continue
          g.setEdge(from, to, {})
          edges.push({ id: `${from}->${to}`, from, to, conditional: Boolean(n.when) })
        }
      }
    }
  }
  dagre.layout(g)

  const nodes = graph.nodes.map((n) => {
    const p = g.node(n.id)
    return {
      id: n.id,
      data: n,
      group: isGroup(n.id),
      x: p.x - p.width / 2,
      y: p.y - p.height / 2,
      w: p.width,
      h: p.height
    }
  })
  for (const e of edges) e.points = g.edge(e.from, e.to).points
  const size = g.graph()
  return { width: size.width, height: size.height, nodes, edges }
}

/** Collapsed (the default) keeps only top-level steps; a loop group is then one node that
 *  says how many steps it holds. Expanded draws every nested step inside its group. */
export function visibleGraph(graph, expand) {
  if (expand) return graph
  const count = new Map()
  for (const n of graph.nodes) {
    if (!n.parent) continue
    const top = n.id.split('/')[0]
    count.set(top, (count.get(top) ?? 0) + 1)
  }
  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => !n.parent)
      .map((n) => ({ ...n, childCount: count.get(n.id) ?? 0 }))
  }
}

export function kindLine(d) {
  const parts = [d.kind.replace('_', ' ')]
  if (d.childCount) parts.push(`${d.childCount} steps`)
  if (d.when) parts.push('if')
  return parts.join(' · ')
}

/** A smooth SVG path through dagre's edge points. */
export function edgePath(points) {
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

export const STATUS_GLYPH = {
  completed: '✓',
  running: '●',
  failed: '✕',
  paused: '‖',
  skipped: '⤼',
  pending: '○'
}

export function clipLabel(text, max = 22) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
