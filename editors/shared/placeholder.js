// What the workflow builder tab shows until the builder is built. Its page is static
// HTML; this module only asks Orca for the tab's document and reports whether it arrived.
const READ = 'Pointer file read.';
const UNREADABLE = 'Orchon could not read this file.';
/** Whether Orca handed this tab its document. A tab that is not a custom editor has none. */
async function documentArrives() {
    try {
        const api = typeof orca === 'undefined' ? undefined : orca.document;
        if (api === undefined)
            return false;
        await api.get();
        return true;
    }
    catch {
        return false;
    }
}
/** Asks for the tab's document, as every custom editor must, and writes the outcome to `status`. */
export async function showPlaceholderStatus(status) {
    status.textContent = (await documentArrives()) ? READ : UNREADABLE;
}
