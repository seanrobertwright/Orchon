// The plugin's own typings for the parts of dagre's copied ESM build (dagre.esm.js) that the
// graph layout calls. dagre's own typings import its graph library by package name, which a
// frame cannot load, so they are not copied.

export type Point = { x: number; y: number }

/** A node's label: what the layout is given, and the centre it sets. */
export type NodeLabel = { width: number; height: number; x?: number; y?: number }
/** An edge's label: the routed points the layout sets. */
export type EdgeLabel = { minlen?: number; weight?: number; points?: Point[] }
export type GraphLabel = {
  rankdir?: 'TB' | 'BT' | 'LR' | 'RL'
  nodesep?: number
  ranksep?: number
  edgesep?: number
  marginx?: number
  marginy?: number
  width?: number
  height?: number
}

export class Graph {
  constructor(options?: { directed?: boolean; multigraph?: boolean; compound?: boolean })
  setGraph(label: GraphLabel): this
  graph(): GraphLabel
  setDefaultEdgeLabel(make: () => EdgeLabel): this
  setNode(id: string, label: NodeLabel): this
  node(id: string): NodeLabel | undefined
  nodes(): string[]
  setParent(id: string, parent: string): this
  setEdge(from: string, to: string, label?: EdgeLabel): this
  edge(from: string, to: string): EdgeLabel | undefined
  edges(): { v: string; w: string }[]
}

export function layout(graph: Graph): void
