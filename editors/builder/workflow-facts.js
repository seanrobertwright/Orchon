// What the builder tab shows of a definition (#16, #28): every node with its kind and whether the
// builder can edit it, the arrows between nodes, the issues opening and the local rules found, and
// the YAML a save would write. The copied Archon logic reads the definition; this module gathers
// what the tab draws, once per definition, so nothing is derived again on a redraw. It is pure.
import { fromWorkflowDefinition, toWorkflowDefinition } from "./archon/model/index.js";
import { runValidation } from "./archon/validation/index.js";
import { serializeToYaml } from "./archon/yaml/index.js";
import { notEditableHere } from "./not-editable.js";
const OPAQUE_KIND = {
    loop_group: { kind: 'loop group', reason: 'A loop group has no editor here.' },
    workflow: { kind: 'workflow', reason: 'A node that runs another workflow has no editor here.' },
    include: { kind: 'include', reason: 'An include has no editor here.' },
    unrecognised: { kind: 'unknown kind', reason: 'This node is of a kind the builder does not know.' },
    script_without_runtime: { kind: 'script with no runtime', reason: 'This script node names no runtime.' },
    loop_with_prompt_and_command: { kind: 'loop with prompt and command', reason: 'This loop node has both a prompt and a command.' }
};
const SEVERITY = { error: 'Error', warning: 'Warning', info: 'Info' };
const RANK = { error: 0, warning: 1, info: 2 };
const texts = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
/** The YAML a save writes for one node: its item under `nodes:`, unindented. */
function nodeYaml(node) {
    const whole = serializeToYaml(toWorkflowDefinition({ name: '', description: '', meta: {}, nodes: [node] }));
    const lines = whole.split('\n');
    const start = lines.indexOf('nodes:');
    return lines
        .slice(start + 1)
        .filter((line) => line !== '')
        .map((line) => line.replace(/^ {2}/, ''))
        .join('\n');
}
/** The YAML of the workflow-level keys other than `name`, `description` and `nodes`, or empty. */
function settingsYaml(meta) {
    if (Object.keys(meta).length === 0)
        return '';
    const whole = serializeToYaml({ name: '', description: '', ...meta, nodes: [] });
    const lines = whole.split('\n');
    const end = lines.indexOf('nodes:');
    return lines
        .slice(1, end)
        .filter((line) => line !== '')
        .join('\n');
}
function nodeFacts(node) {
    const opaque = node.variant === 'opaque' ? OPAQUE_KIND[node.data.kind] : null;
    return {
        id: typeof node.id === 'string' ? node.id : '',
        kind: opaque?.kind ?? node.variant,
        readOnly: opaque !== null,
        reason: opaque?.reason ?? null,
        dependsOn: texts(node.base.depends_on),
        conditional: typeof node.base.when === 'string' && node.base.when !== '',
        notEditable: notEditableHere(node),
        yaml: nodeYaml(node)
    };
}
const issueFacts = (issue) => ({ severity: SEVERITY[issue.severity], rule: issue.rule, message: issue.message, nodeId: issue.path.nodeId ?? null });
/** What the tab shows of a definition the worker checked, or null when the copied logic cannot read it. */
export function workflowFacts(definition) {
    if (!Array.isArray(definition.nodes))
        return null;
    try {
        const { workflow, issues } = fromWorkflowDefinition(definition);
        const nodes = workflow.nodes.map(nodeFacts);
        const first = new Map();
        nodes.forEach((node, index) => {
            if (!first.has(node.id))
                first.set(node.id, index);
        });
        const edges = [];
        nodes.forEach((node, to) => {
            for (const id of node.dependsOn) {
                const from = first.get(id);
                if (from !== undefined && from !== to)
                    edges.push({ from, to });
            }
        });
        edges.sort((a, b) => a.from - b.from || a.to - b.to);
        const found = [...issues, ...runValidation(workflow)]
            .map((issue, at) => ({ issue, at }))
            .sort((a, b) => RANK[a.issue.severity] - RANK[b.issue.severity] || a.at - b.at)
            .map(({ issue }) => issueFacts(issue));
        return {
            name: typeof workflow.name === 'string' ? workflow.name : '',
            description: typeof workflow.description === 'string' ? workflow.description : '',
            nodes,
            edges,
            issues: found,
            yaml: serializeToYaml(toWorkflowDefinition(workflow)),
            settingsYaml: settingsYaml(workflow.meta)
        };
    }
    catch {
        return null;
    }
}
