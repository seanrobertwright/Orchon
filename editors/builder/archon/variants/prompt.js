/** Default prompt config (empty body) for a freshly-created prompt node. */
export function defaultPromptData() {
    return { prompt: '' };
}
/**
 * Build `PromptNodeData` from a partitioned wire node's variant-specific fields.
 * Throws when the `prompt` mode field is absent — importers must check field
 * presence first; defaults for new nodes come from `defaultPromptData()`.
 */
export function promptFromDag(variantSpecific) {
    if (variantSpecific.prompt === undefined) {
        throw new Error("promptFromDag: wire node has no 'prompt' field — use defaultPromptData() for new nodes");
    }
    return { prompt: variantSpecific.prompt };
}
/** Serialize `PromptNodeData` to the sparse `{ prompt: … }` wire fragment. */
export function promptToDag(data) {
    return { prompt: data.prompt };
}
