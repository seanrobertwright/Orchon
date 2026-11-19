export const COALESCE_MS = 400;
const MAX_STACK = 50;
/** A fresh, empty history. */
export function createHistory() {
    return { past: [], future: [], lastKind: null, lastTime: 0 };
}
/**
 * Record `snapshot` as an undo point for an edit of `kind` happening at `now`.
 * A push with the same kind within {@link COALESCE_MS} of the previous attempt
 * coalesces (no new entry; the earlier snapshot stays the undo point) but
 * still refreshes the window. Any push clears the redo stack.
 */
export function pushSnapshot(h, kind, snapshot, now) {
    const coalesce = h.lastKind === kind && now - h.lastTime < COALESCE_MS && h.past.length > 0;
    if (coalesce) {
        return { ...h, future: [], lastTime: now };
    }
    return {
        past: [...h.past.slice(-(MAX_STACK - 1)), { kind, snapshot }],
        future: [],
        lastKind: kind,
        lastTime: now,
    };
}
export function canUndo(h) {
    return h.past.length > 0;
}
export function canRedo(h) {
    return h.future.length > 0;
}
/**
 * Step back. Returns the snapshot to restore plus the next history value, or
 * `null` when there is nothing to undo. `current` (the caller's live state)
 * moves onto the redo stack. Resets the coalescing window so the next edit
 * always gets its own entry.
 */
export function undo(h, current) {
    const head = h.past[h.past.length - 1];
    if (head === undefined)
        return null;
    return {
        history: {
            past: h.past.slice(0, -1),
            future: [{ kind: head.kind, snapshot: current }, ...h.future],
            lastKind: null,
            lastTime: 0,
        },
        snapshot: head.snapshot,
    };
}
/**
 * Step forward. Returns the snapshot to restore plus the next history value,
 * or `null` when there is nothing to redo. `current` moves onto the undo stack.
 */
export function redo(h, current) {
    const head = h.future[0];
    if (head === undefined)
        return null;
    return {
        history: {
            past: [...h.past, { kind: head.kind, snapshot: current }],
            future: h.future.slice(1),
            lastKind: null,
            lastTime: 0,
        },
        snapshot: head.snapshot,
    };
}
