/** FNV-1a 32-bit hash → 8-hex-char string. Pure, deterministic, no deps. */
function fnv1a(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
/** Build a complete `Issue` with a stable id derived from its identifying fields. */
export function makeIssue(input) {
    const { rule, path, message } = input;
    // JSON.stringify is lossless: a '|' join would collide when a field contains '|'.
    const key = JSON.stringify([
        rule,
        path.nodeId ?? '',
        path.field ?? '',
        path.atomIndex ?? '',
        message,
    ]);
    return { ...input, id: `${rule}:${fnv1a(key)}` };
}
