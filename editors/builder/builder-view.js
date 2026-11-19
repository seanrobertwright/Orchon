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
/**
 * Archon's rule for the name a workflow is saved under (`isValidCommandName`, which its
 * `PUT /api/workflows/{name}` applies at 0.12.1): not empty, no `/`, `\` or `..`, and no leading
 * `.`. The copied builder logic holds no such rule; this is read from Archon's server source.
 */
export function isArchonWorkflowName(name) {
    return name !== '' && name.length <= WORKFLOW_NAME_CAP && !name.includes('/') && !name.includes('\\') && !name.includes('..') && !name.startsWith('.');
}
/** A new workflow's first copy: its name, no description, and one empty prompt node, as the copied editor names a first prompt node. */
export const newWorkflowDefinition = (name) => ({ name, description: '', nodes: [{ id: 'prompt-1', prompt: '' }] });
/** Where a new workflow's first Save writes it, in words, for its header until then. */
export const newWorkflowFile = (place) => place === 'global' ? "Not saved yet. The first Save writes it to the workflows folder of Archon's home folder." : "Not saved yet. The first Save writes it to the project's .archon/workflows folder.";
