// The copy of a workflow the builder tab edits (#16, #28). Each edit goes through the copied
// Archon editor state (`archon/editor/state.ts`) and its undo history, so the builder holds one
// model of a workflow, Archon's. The session also knows whether the copy differs from the one
// opened, which is what "Unsaved changes" says. Node positions carry no meaning: the tab lays the
// graph out again after every change, and nothing is dragged or saved; the state's positions are
// only kept in each undo step as the copied history expects. The session holds its own state and
// touches nothing outside it: no page, no file, no clock.
//
// The copied reducer finds a node by its id. A workflow may hold two nodes with one id, or a node
// with none, until the person fixes it; an edit to such a node is applied by its position here,
// with the same history, so it never reaches the other node that shares the id.
import { CLIPBOARD_VERSION, pasteEnvelope } from "./archon/editor/clipboard.js";
import { COALESCE_MS, pushSnapshot } from "./archon/editor/history.js";
import { canRedo, canUndo, createEditorState, editorReducer } from "./archon/editor/state.js";
import { fromWorkflowDefinition, toWorkflowDefinition } from "./archon/model/index.js";
import { edgeId } from "./support/flow.js";
const ORIGIN = { x: 0, y: 0 };
/** Opens a definition for editing, or null when the copied logic cannot read it. */
export function openSession(definition) {
    if (!Array.isArray(definition.nodes))
        return null;
    let opened;
    try {
        opened = fromWorkflowDefinition(definition);
    }
    catch {
        return null;
    }
    const openedText = JSON.stringify(toWorkflowDefinition(opened.workflow));
    let state = createEditorState(opened.workflow);
    /** The time each edit is stamped with for the history: a burst shares one, any other edit moves on past the coalescing window. */
    let at = 0;
    let dirtyFor = null;
    let dirty = false;
    const stamp = (continues) => {
        if (!continues)
            at += COALESCE_MS * 2;
        return at;
    };
    const nodes = () => state.workflow.nodes;
    /** Whether `id` names exactly one node, so the copied reducer finds it alone. */
    const unique = (id) => id !== '' && nodes().filter((node) => node.id === id).length === 1;
    /** Applies an action; true when it changed the workflow. */
    const run = (action) => {
        const before = state.workflow;
        state = editorReducer(state, action);
        return state.workflow !== before;
    };
    /** Replaces the workflow by hand, with one undo step of `kind`. */
    const commit = (workflow, kind, time) => {
        state = { ...state, history: pushSnapshot(state.history, kind, { workflow: state.workflow, positions: state.positions }, time), workflow };
        return true;
    };
    /**
     * Makes one edit, with one undo step. While `byId` holds, the copied reducer can find the nodes by
     * their ids and makes it with `action`; otherwise `byPosition` makes it, with an undo step of `kind`.
     */
    const viaReducer = (byId, action, byPosition, kind, time) => byId ? run(action(time)) : commit(byPosition(), kind, time);
    const withNodeAt = (index, node) => nodes().map((held, position) => (position === index ? node : held));
    const dependsOn = (node) => (Array.isArray(node.base.depends_on) ? node.base.depends_on : []);
    const withDepends = (node, ids) => ({ ...node, base: { ...node.base, depends_on: ids.length > 0 ? ids : undefined } });
    return {
        workflow: () => state.workflow,
        definition: () => toWorkflowDefinition(state.workflow),
        openingIssues: opened.issues,
        dirty() {
            if (dirtyFor !== state.workflow) {
                dirtyFor = state.workflow;
                dirty = JSON.stringify(toWorkflowDefinition(state.workflow)) !== openedText;
            }
            return dirty;
        },
        canUndo: () => canUndo(state.history),
        canRedo: () => canRedo(state.history),
        setNode(index, node, continues = false) {
            const held = nodes()[index];
            if (held === undefined || held === node)
                return false;
            return viaReducer(held.id === node.id && unique(node.id), (at) => ({ type: 'patch-node', node, at }), () => ({ ...state.workflow, nodes: withNodeAt(index, node) }), `patch@${String(index)}`, stamp(continues));
        },
        setDescription(text, continues = false) {
            if (state.workflow.description === text)
                return false;
            return commit({ ...state.workflow, description: text }, 'description', stamp(continues));
        },
        addNode(variant) {
            run({ type: 'add-node', variant, position: ORIGIN, at: stamp(false) });
            return nodes().length - 1;
        },
        removeNode(index) {
            const held = nodes()[index];
            if (held === undefined)
                return false;
            return viaReducer(unique(held.id), (at) => ({ type: 'remove-nodes', ids: [held.id], at }), () => ({ ...state.workflow, nodes: nodes().filter((_, position) => position !== index) }), 'remove-nodes', stamp(false));
        },
        duplicateNode(index) {
            const held = nodes()[index];
            if (held === undefined)
                return null;
            // The copied clipboard gives the copy a fresh id; a copy of one node keeps none of its dependencies.
            const envelope = { version: CLIPBOARD_VERSION, nodes: [withDepends(held, [])], positions: {} };
            const [copy] = pasteEnvelope(envelope, new Set(nodes().map((node) => node.id))).nodes;
            if (copy === undefined)
                return null;
            commit({ ...state.workflow, nodes: [...nodes(), copy] }, 'paste', stamp(false));
            return nodes().length - 1;
        },
        addDependency(index, id) {
            const held = nodes()[index];
            if (held === undefined || id === '' || id === held.id || dependsOn(held).includes(id))
                return false;
            return viaReducer(unique(held.id) && unique(id), (at) => ({ type: 'add-edge', source: id, target: held.id, at }), () => ({ ...state.workflow, nodes: withNodeAt(index, withDepends(held, [...dependsOn(held), id])) }), 'add-edge', stamp(false));
        },
        removeDependency(index, id) {
            const held = nodes()[index];
            if (held === undefined || !dependsOn(held).includes(id))
                return false;
            const byId = unique(held.id);
            // The copied reducer removes an edge by selecting it first.
            if (byId)
                state = editorReducer(state, { type: 'set-selection', nodeIds: new Set(), edgeIds: new Set([edgeId(id, held.id)]) });
            return viaReducer(byId, (at) => ({ type: 'remove-selection', at }), () => ({ ...state.workflow, nodes: withNodeAt(index, withDepends(held, dependsOn(held).filter((dep) => dep !== id))) }), 'remove-selection', stamp(false));
        },
        undo: () => run({ type: 'undo' }),
        redo: () => run({ type: 'redo' })
    };
}
