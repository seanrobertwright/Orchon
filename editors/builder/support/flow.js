/** Stable edge id for a `depends_on` pair. */
export function edgeId(source, target) {
    return `${source}->${target}`;
}
/**
 * Every `depends_on` edge between two nodes of the workflow, in node order then dependency
 * order. A dependency on an id the workflow does not hold gets no edge; validation reports it.
 */
export function builderToFlowEdges(workflow) {
    const known = new Set(workflow.nodes.map((node) => node.id));
    const edges = [];
    for (const target of workflow.nodes) {
        for (const source of target.base.depends_on ?? []) {
            if (known.has(source))
                edges.push({ id: edgeId(source, target.id), source, target: target.id });
        }
    }
    return edges;
}
