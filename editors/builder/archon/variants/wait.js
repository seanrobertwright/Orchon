export function defaultWaitData() {
    return { duration_ms: 60_000 };
}
export function waitFromDag(variantSpecific) {
    if (variantSpecific.wait === undefined) {
        throw new Error("waitFromDag: wire node has no 'wait' field — use defaultWaitData() for new nodes");
    }
    return { ...variantSpecific.wait };
}
export function waitToDag(data) {
    return { wait: { ...data } };
}
