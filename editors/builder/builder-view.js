/** The most characters of a workflow name the builder's requests and pointer files take. */
export const WORKFLOW_NAME_CAP = 200;
/** The most characters of a scope the builder's requests and pointer files take. */
export const SCOPE_CAP = 40;
/** The largest definition the builder opens, in bytes of its JSON text (#16). */
export const DEFINITION_CAP_BYTES = 1024 * 1024;
/** A size in mebibytes to one decimal place, such as `1.0 MiB`. */
export const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
