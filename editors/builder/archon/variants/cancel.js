/** Default cancel config (empty reason) for a freshly-created cancel node. */
export function defaultCancelData() {
    return { reason: '' };
}
/**
 * Build `CancelNodeData` from a partitioned wire node's variant-specific fields.
 * Throws when the `cancel` mode field is absent — importers must check field
 * presence first; defaults for new nodes come from `defaultCancelData()`.
 */
export function cancelFromDag(variantSpecific) {
    if (variantSpecific.cancel === undefined) {
        throw new Error("cancelFromDag: wire node has no 'cancel' field — use defaultCancelData() for new nodes");
    }
    return { reason: variantSpecific.cancel };
}
/** Serialize `CancelNodeData` to the sparse `{ cancel: … }` wire fragment. */
export function cancelToDag(data) {
    return { cancel: data.reason };
}
