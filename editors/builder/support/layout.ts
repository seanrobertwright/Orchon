// A top-to-bottom layered layout for the copied editor logic (../archon/editor/). Archon's builder
// lays out with dagre (flow/layout.ts at v0.14.0); the plugin has no dagre yet, so this stand-in
// keeps the same node size and spacing: each node sits one rank below its deepest dependency, and
// the nodes of a rank sit side by side in workflow order. Pure: it returns positions and mutates
// nothing.
import type { XYPosition } from './flow.ts'

export const NODE_WIDTH = 180
export const NODE_HEIGHT = 80
const RANK_GAP = 80
const NODE_GAP = 40

/**
 * The top-left corner of every node. An edge naming an id outside `nodeIds` is skipped, and an
 * edge that closes a cycle is ignored when ranking, so every node gets a position.
 */
export function layoutGraph(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[]
): Map<string, XYPosition> {
  const known = new Set(nodeIds)
  const dependencies = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
  for (const edge of edges) {
    if (known.has(edge.source) && known.has(edge.target)) dependencies.get(edge.target)?.push(edge.source)
  }

  const ranks = new Map<string, number>()
  const visiting = new Set<string>()
  const rankOf = (id: string): number => {
    const ranked = ranks.get(id)
    if (ranked !== undefined) return ranked
    visiting.add(id)
    let rank = 0
    for (const dependency of dependencies.get(id) ?? []) {
      if (!visiting.has(dependency)) rank = Math.max(rank, rankOf(dependency) + 1)
    }
    visiting.delete(id)
    ranks.set(id, rank)
    return rank
  }

  const columns = new Map<number, number>()
  const positions = new Map<string, XYPosition>()
  for (const id of nodeIds) {
    if (positions.has(id)) continue
    const rank = rankOf(id)
    const column = columns.get(rank) ?? 0
    columns.set(rank, column + 1)
    positions.set(id, { x: column * (NODE_WIDTH + NODE_GAP), y: rank * (NODE_HEIGHT + RANK_GAP) })
  }
  return positions
}
