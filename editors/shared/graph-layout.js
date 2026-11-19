// The graph layout, shared by the run graph and the builder (#11): dagre's copied ESM build places
// the steps and routes the edges. A loop group is a compound node framing its own steps. dagre
// cannot route an edge that touches a compound node, so an edge into a group attaches to its
// first steps and an edge out of it leaves from its last. An edge into a conditional step is
// dashed. It is pure logic: no DOM, and it is called once per change of the graph, never per draw.
import { Graph, layout } from './dagre.esm.js';
/** Every step is drawn the same size: a line for its name and a line for its state. */
export const STEP_WIDTH = 184;
export const STEP_HEIGHT = 60;
/** Room above a group's steps for the group's name. */
const GROUP_LABEL = 22;
/** The gap between two steps one under another, in run order. */
const ORDER_GAP = 16;
const MARGIN = 16;
/** The steps directly inside each group. */
function childrenOf(steps) {
    const children = new Map();
    for (const step of steps) {
        if (step.group === null)
            continue;
        const level = children.get(step.group);
        if (level === undefined)
            children.set(step.group, [step]);
        else
            level.push(step);
    }
    return children;
}
/**
 * The steps an edge attaches to at one end of `id`: the step itself, or for a group with steps,
 * its first steps (`entry`) or its last (`exit`), found again inside any group among them.
 */
function endsOf(id, side, framed, children, edges, seen = new Set()) {
    if (!framed.has(id) || seen.has(id))
        return [id];
    seen.add(id);
    const inside = new Set((children.get(id) ?? []).map((step) => step.id));
    const linked = new Set(edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to)).map((edge) => (side === 'entry' ? edge.to : edge.from)));
    const ends = [...inside].filter((child) => !linked.has(child));
    return (ends.length === 0 ? [...inside] : ends).flatMap((child) => endsOf(child, side, framed, children, edges, seen));
}
/** Lays the graph out with dagre, top to bottom. */
export function layoutGraph(steps, edges) {
    const children = childrenOf(steps);
    /** The groups drawn as frames: those holding at least one step. An empty one is drawn as a step. */
    const framed = new Set(steps.filter((step) => step.isGroup && (children.get(step.id)?.length ?? 0) > 0).map((step) => step.id));
    const known = new Set(steps.map((step) => step.id));
    const conditional = new Set(steps.filter((step) => step.conditional).map((step) => step.id));
    const graph = new Graph({ compound: true, multigraph: false });
    graph.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 44, marginx: MARGIN, marginy: MARGIN });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const step of steps) {
        graph.setNode(step.id, framed.has(step.id) ? { width: 0, height: 0 } : { width: STEP_WIDTH, height: STEP_HEIGHT });
    }
    for (const step of steps)
        if (step.group !== null && known.has(step.group))
            graph.setParent(step.id, step.group);
    const routed = [];
    const added = new Set();
    for (const edge of edges) {
        if (!known.has(edge.from) || !known.has(edge.to))
            continue;
        // An edge into a conditional group is dashed at each first step, as one into the group is.
        const intoConditional = conditional.has(edge.to);
        for (const from of endsOf(edge.from, 'exit', framed, children, edges)) {
            for (const to of endsOf(edge.to, 'entry', framed, children, edges)) {
                const key = `${from}\u0000${to}`;
                if (from === to || added.has(key))
                    continue;
                added.add(key);
                graph.setEdge(from, to, {});
                routed.push({ from, to, dashed: intoConditional || conditional.has(to) });
            }
        }
    }
    layout(graph);
    const box = (id) => {
        const label = graph.node(id);
        const width = label?.width ?? 0;
        const height = label?.height ?? 0;
        return { id, x: (label?.x ?? 0) - width / 2, y: (label?.y ?? 0) - height / 2, width, height };
    };
    const groups = steps.filter((step) => framed.has(step.id)).map((step) => {
        const frame = box(step.id);
        // dagre's frame hugs its steps; the name needs room above them.
        return { ...frame, y: frame.y - GROUP_LABEL, height: frame.height + GROUP_LABEL };
    });
    const label = graph.graph();
    const placed = steps.filter((step) => !framed.has(step.id)).map((step) => box(step.id));
    const lowest = Math.min(0, ...groups.map((group) => group.y - MARGIN));
    const shift = (one) => ({ ...one, y: one.y - lowest });
    return {
        width: label.width ?? 0,
        height: (label.height ?? 0) - lowest,
        steps: placed.map(shift),
        groups: groups.map(shift),
        edges: routed.map((edge) => ({ ...edge, points: (graph.edge(edge.from, edge.to)?.points ?? []).map((point) => ({ x: point.x, y: point.y - lowest })) }))
    };
}
/** The steps one under another in the order given, with no edges: a run drawn in run order. */
export function layoutInOrder(ids) {
    const steps = ids.map((id, index) => ({ id, x: MARGIN, y: MARGIN + index * (STEP_HEIGHT + ORDER_GAP), width: STEP_WIDTH, height: STEP_HEIGHT }));
    return {
        width: STEP_WIDTH + 2 * MARGIN,
        height: ids.length === 0 ? 2 * MARGIN : 2 * MARGIN + ids.length * STEP_HEIGHT + (ids.length - 1) * ORDER_GAP,
        steps,
        groups: [],
        edges: []
    };
}
