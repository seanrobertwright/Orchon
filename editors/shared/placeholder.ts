// What both editor tabs show until the run graph and the builder are built. Each page is static
// HTML; this module only asks Orca for the tab's document and reports whether it arrived.

/** The part of an element this module writes to. Outside text always goes through textContent. */
export interface StatusLine {
  textContent: string | null
}

const READ = 'Pointer file read.'
const UNREADABLE = 'Orchon could not read this file.'

/** Whether Orca handed this tab its document. A tab that is not a custom editor has none. */
async function documentArrives(): Promise<boolean> {
  try {
    const api = typeof orca === 'undefined' ? undefined : orca.document
    if (api === undefined) return false
    await api.get()
    return true
  } catch {
    return false
  }
}

/** Asks for the tab's document, as every custom editor must, and writes the outcome to `status`. */
export async function showPlaceholderStatus(status: StatusLine): Promise<void> {
  status.textContent = (await documentArrives()) ? READ : UNREADABLE
}
