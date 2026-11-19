// Which fields of a node the builder lists under "Not editable here". Such a field is kept on its
// node and written back unchanged; the builder shows it as read-only YAML.
//
// The fields that do have an editor are the ones the inspector's form edits (`node-form.ts`), which
// follows Archon's own builder inspector at v0.14.0, plus the id and the "Depends on" list.
import { isRecord } from "../shared/records.js";
import { toWorkflowDefinition } from "./archon/model/index.js";
import { formFields } from "./node-form.js";
/** The node fields that hold an object whose own fields the inspector edits one by one. */
const NESTED = ['loop', 'approval', 'wait'];
/**
 * The fields of `node` that have no editor, in the order a save writes them. A field inside
 * `loop`, `approval` or `wait` is named by its path, such as `loop.signal_completes`. A node the
 * builder shows read-only lists every field but its id and the shared fields its form edits.
 */
export function notEditableHere(node) {
    const [saved] = toWorkflowDefinition({ name: '', description: '', meta: {}, nodes: [node] }).nodes;
    if (saved === undefined)
        return [];
    const keys = ['id', 'depends_on', ...formFields(node).map((field) => field.key)];
    /** A field is edited when the form edits it or a field inside it, such as `approval.on_reject.prompt`. */
    const edited = (path) => keys.some((key) => key === path || key.startsWith(`${path}.`));
    const listed = [];
    for (const [key, value] of Object.entries(saved)) {
        if (node.variant !== 'opaque' && NESTED.includes(key) && isRecord(value)) {
            for (const inner of Object.keys(value)) {
                if (!edited(`${key}.${inner}`))
                    listed.push(`${key}.${inner}`);
            }
        }
        else if (!edited(key)) {
            listed.push(key);
        }
    }
    return listed;
}
