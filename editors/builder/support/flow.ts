// The canvas pieces the copied editor logic (../archon/editor/) uses. Archon's builder takes them
// from its React Flow bridge (flow/types.ts and flow/to-flow.ts at v0.14.0); the plugin keeps the
// same names and meaning with no React Flow types.
import type { BuilderWorkflow } from '../archon/types/index.ts'

/** An x/y point in canvas coordinates. */
export interface XYPosition {
  x: number
  y: number
}

/** One `depends_on` edge: `source` is the dependency, `target` the node that depends on it. */
export interface DependencyEdge {
  id: string
  source: string
  target: string
}

/** Stable edge id for a `depends_on` pair. */
export function edgeId(source: string, target: string): string {
  return `${source}->${target}`
}

/**
 * Every `depends_on` edge between two nodes of the workflow, in node order then dependency
 * order. A dependency on an id the workflow does not hold gets no edge; validation reports it.
 */
export function builderToFlowEdges(workflow: BuilderWorkflow): DependencyEdge[] {
  const known = new Set(workflow.nodes.map((node) => node.id))
  const edges: DependencyEdge[] = []
  for (const target of workflow.nodes) {
    for (const source of target.base.depends_on ?? []) {
      if (known.has(source)) edges.push({ id: edgeId(source, target.id), source, target: target.id })
    }
  }
  return edges
}
