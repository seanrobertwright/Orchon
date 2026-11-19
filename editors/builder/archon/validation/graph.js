import { makeIssue } from "./make-issue.js";
/** A node's direct dependencies (empty when unset). */
function depsOf(node) {
    return node.base.depends_on ?? [];
}
/** Emit `graph.ref.unknown` for every `depends_on` target that is not a node id. */
function checkRefs(nodes, idSet) {
    const issues = [];
    for (const node of nodes) {
        for (const dep of depsOf(node)) {
            if (!idSet.has(dep)) {
                issues.push(makeIssue({
                    rule: 'graph.ref.unknown',
                    severity: 'error',
                    source: 'client-debounced',
                    message: `node '${node.id}' depends on unknown node '${dep}'`,
                    path: { nodeId: node.id, field: 'depends_on' },
                }));
            }
        }
    }
    return issues;
}
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
/** Detect cycles in the `depends_on` graph via three-color DFS. */
function checkCycles(nodes, idSet) {
    const color = new Map();
    const depsById = new Map();
    for (const node of nodes) {
        color.set(node.id, WHITE);
        depsById.set(node.id, depsOf(node));
    }
    const issues = [];
    function visit(id) {
        color.set(id, GRAY);
        for (const dep of depsById.get(id) ?? []) {
            if (!idSet.has(dep))
                continue; // unknown refs are reported by checkRefs
            const depColor = color.get(dep);
            if (depColor === GRAY) {
                // Back edge → the dependency closes a cycle.
                issues.push(makeIssue({
                    rule: 'graph.cycle',
                    severity: 'error',
                    source: 'client-debounced',
                    message: `dependency cycle detected involving node '${dep}'`,
                    path: { nodeId: dep, field: 'depends_on' },
                }));
            }
            else if (depColor === WHITE) {
                visit(dep);
            }
        }
        color.set(id, BLACK);
    }
    for (const node of nodes) {
        if (color.get(node.id) === WHITE)
            visit(node.id);
    }
    return issues;
}
/** Validate `depends_on` reference integrity and acyclicity. */
export function validateGraph(workflow) {
    const idSet = new Set(workflow.nodes.map(n => n.id));
    return [...checkRefs(workflow.nodes, idSet), ...checkCycles(workflow.nodes, idSet)];
}
