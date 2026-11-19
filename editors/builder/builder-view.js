/** The most characters of a workflow name the builder's requests and pointer files take. */
export const WORKFLOW_NAME_CAP = 200;
/** The most characters of a scope the builder's requests and pointer files take. */
export const SCOPE_CAP = 40;
/** The largest definition the builder opens, in bytes of its JSON text (#16). */
export const DEFINITION_CAP_BYTES = 1024 * 1024;
/** A size in mebibytes to one decimal place, such as `1.0 MiB`. */
export const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
/** The most of Archon's validation sentences a view lists; past it `more` says how many are not shown. */
export const VALIDATION_ERRORS_CAP = 20;
/** The most drafts plugin storage keeps. At the cap a draft of another workflow is refused until one is saved or discarded. */
export const BUILDER_DRAFTS_CAP = 20;
/** How long the worker waits after a draft's last change before it writes it to plugin storage. */
export const BUILDER_DRAFT_WRITE_PAUSE_MS = 1_000;
/** How long the tab waits after the last edit before it hands its draft to the worker. */
export const BUILDER_DRAFT_SEND_PAUSE_MS = 500;
/** The most characters of the file words a draft keeps, to show while Archon is away. */
export const DRAFT_FILE_CAP = 2_000;
