import { detectOpaqueKind, detectVariantOrNull, partitionNode, VARIANT_REGISTRY, variantDataFromDag, } from "../variants/index.js";
import { makeIssue } from "../validation/make-issue.js";
/** A node shown read-only and saved unchanged, with the info issue that says so. */
function readOnlyNode(id, base, kind, fields, message, issues) {
    issues.push(makeIssue({
        rule: 'structural.node.read-only',
        severity: 'info',
        source: 'client-instant',
        message,
        path: { nodeId: id },
    }));
    return { id, variant: 'opaque', base, data: { kind, fields } };
}
/** Convert a single wire node into a `BuilderNode`, collecting import issues. */
function nodeFromDag(node, issues) {
    const { id, base, variantSpecific } = partitionNode(node);
    const opaqueKind = detectOpaqueKind(node);
    if (opaqueKind !== null) {
        // A valid node the builder cannot edit: show it read-only and carry every
        // mode field back untouched, rather than degrading it to an empty prompt.
        return readOnlyNode(id, base, opaqueKind, variantSpecific, `'${opaqueKind}' nodes have no editor yet; shown read-only and saved unchanged`, issues);
    }
    const variant = detectVariantOrNull(node);
    if (variant === null) {
        // Orchon: no mode field the builder knows (malformed or future-schema
        // input). Upstream edits it as an empty prompt node, which would rewrite it
        // on save; it opens read-only and is saved unchanged instead.
        return readOnlyNode(id, base, 'unrecognised', variantSpecific, 'this node is of a kind the builder does not recognise; shown read-only and saved unchanged', issues);
    }
    if (variant === 'loop' &&
        typeof variantSpecific.loop?.prompt === 'string' &&
        typeof variantSpecific.loop.command === 'string') {
        // Orchon: the engine schema rejects a loop carrying both prompt sources.
        // Upstream keeps `prompt` and drops `command`; the node opens read-only and
        // is saved unchanged instead.
        return readOnlyNode(id, base, 'loop_with_prompt_and_command', variantSpecific, "loop node has both 'prompt' and 'command' (engine allows exactly one); shown read-only and saved unchanged", issues);
    }
    if (variant === 'script' && variantSpecific.runtime === undefined) {
        // Orchon: the engine requires `runtime` on script nodes. Upstream edits the
        // node as 'bun', which would write a runtime on save; it opens read-only
        // and is saved unchanged instead.
        return readOnlyNode(id, base, 'script_without_runtime', variantSpecific, "script node is missing required 'runtime' ('bun' or 'uv'); shown read-only and saved unchanged", issues);
    }
    // Wire keys the variant's converters do not carry — a field of another node
    // kind, or one no release names. Orchon: upstream drops them with a warning;
    // they are kept with the node's base fields instead, which a save writes back
    // verbatim, and the info issue says so.
    // Widen to `string[]` so the `.includes(key)` membership test accepts the
    // arbitrary keys present on the wire node (the registry types these as
    // `keyof WireDagNode` for compile-time drift safety).
    const wireKeys = VARIANT_REGISTRY[variant].wireKeys;
    const carried = {};
    const kept = { ...base };
    for (const [key, value] of Object.entries(variantSpecific)) {
        if (wireKeys.includes(key)) {
            carried[key] = value;
            continue;
        }
        kept[key] = value;
        issues.push(makeIssue({
            rule: 'structural.field.unsupported',
            severity: 'info',
            source: 'client-instant',
            message: `field '${key}' has no editor on ${variant} nodes; kept and saved unchanged`,
            path: { nodeId: id, field: key },
        }));
    }
    const data = variantDataFromDag(variant, carried);
    // The (variant, data) pair is consistent by construction — detectVariantOrNull
    // and variantDataFromDag read the same fields — so this assembles a valid
    // member of the BuilderNode discriminated union.
    return { id, variant, base: kept, data };
}
/** Convert a wire workflow definition into a `BuilderWorkflow` plus import issues. */
export function fromWorkflowDefinition(def) {
    const { name, description, nodes, ...meta } = def;
    const issues = [];
    return {
        workflow: {
            name,
            description,
            meta,
            nodes: nodes.map(node => nodeFromDag(node, issues)),
        },
        issues,
    };
}
/**
 * Import a workflow definition, surfacing any import issues to the console.
 *
 * Callers that seed the editor from a definition but have nowhere to render the
 * issue list (the fixture route, the preview page) should use this instead of
 * dropping `.issues` on the floor — upstream, an unknown node variant becomes an
 * empty prompt node and a missing script `runtime` becomes `bun`, so the
 * degradation must at least be visible in the console. (Orchon: both now open
 * read-only, and the issues say so.) PR-3's live editor routes the same issues
 * into the validation panel.
 */
export function importWorkflowDefinition(def, label) {
    const { workflow, issues } = fromWorkflowDefinition(def);
    if (issues.length > 0) {
        // Dev-visibility surface for import degradation; these routes have no issue
        // panel (PR-3's live editor routes the same issues into the panel).
        console.warn(`[builder] imported "${label}" with ${String(issues.length)} import issue(s):`, issues.map(i => i.message));
    }
    return workflow;
}
