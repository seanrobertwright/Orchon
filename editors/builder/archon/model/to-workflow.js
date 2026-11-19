import { nodeDataToDag } from "../variants/index.js";
/** Drop `undefined` values and empty `depends_on`, matching the engine transform. */
function sparsifyNode(merged) {
    const out = {};
    for (const [key, value] of Object.entries(merged)) {
        if (value === undefined)
            continue;
        if (key === 'depends_on' && Array.isArray(value) && value.length === 0)
            continue;
        out[key] = value;
    }
    return out;
}
/** Reassemble a single builder node into a sparse wire node. */
function nodeToDag(node) {
    return sparsifyNode({ ...node.base, ...nodeDataToDag(node), id: node.id });
}
/** Convert a `BuilderWorkflow` into a preview/validation draft. */
export function toWorkflowDefinition(bw) {
    return {
        name: bw.name,
        description: bw.description,
        ...bw.meta,
        nodes: bw.nodes.map(nodeToDag),
    };
}
