// Opening a wide tab, as a frame asks for it and hears back. It is types only, so the panel and
// the worker read one contract.

/** Open graph: the run whose graph tab opens. */
export type GraphOpenRequest = { runId: string }

/** Whether the tab opened, or the one sentence that says why not. */
export type GraphOpenAnswer = { opened: true } | { opened: false; reason: string }

/**
 * Open in builder: a workflow by name, in the Archon project whose list it is in, or in none.
 * `source` is the scope of the row pressed, when the frame knows it: the tab opens only when
 * Archon serves that scope's workflow by this name, not another scope's in its place.
 */
export type BuilderOpenRequest = { name: string; codebaseId: string | null; source?: string }

/** Whether the builder tab opened, or the one sentence that says why not. */
export type BuilderOpenAnswer = GraphOpenAnswer
