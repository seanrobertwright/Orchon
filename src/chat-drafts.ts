// Chat drafts in the worker: the unsent text of each open conversation, and of a new chat per
// project, kept in plugin storage so it survives the panel unmounting and Orca restarting. The
// worker holds them in memory and writes them to storage after a pause, because `storage.set`
// rewrites the whole file. Only the 20 most recently edited are kept, each within the 32 KiB cap
// of a message; that holds for what is read from storage as well as for what a frame writes.
// No other message text is ever stored.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { CHAT_MESSAGE_CAP, messageBytes } from './chat-send-view'
import { DRAFT_KEY, DRAFT_WRITE_PAUSE_MS, DRAFTS_KEPT, type ChatDraftsAnswer, type ChatDraftWrite } from './chat-drafts-view'
import type { Timers } from './client'
import { isRecord, own, refuseOtherKeys, refuseRequest } from './records'

/** The plugin storage key the drafts are kept under: a list, the most recently edited first. */
export const DRAFTS_STORAGE_KEY = 'chat-drafts'

type Draft = { key: string; text: string }

const isDraftText = (text: unknown): text is string => typeof text === 'string' && text !== '' && messageBytes(text) <= CHAT_MESSAGE_CAP

/** What storage held, as drafts: anything that is not a draft within the caps is dropped, and so is a second draft of one key. */
export function parseStoredDrafts(value: unknown): Draft[] {
  if (!Array.isArray(value)) return []
  const kept: Draft[] = []
  for (const entry of value as unknown[]) {
    if (kept.length >= DRAFTS_KEPT) break
    if (!isRecord(entry)) continue
    const key = own(entry, 'key')
    const text = own(entry, 'text')
    if (typeof key !== 'string' || !DRAFT_KEY.test(key) || !isDraftText(text)) continue
    if (kept.some((draft) => draft.key === key)) continue
    kept.push({ key, text })
  }
  return kept
}

/** A frame's write, or a refusal. Empty text removes the draft. */
export function parseDraftWrite(input: unknown): ChatDraftWrite {
  if (!isRecord(input)) refuseRequest('A draft takes a key and its text.')
  refuseOtherKeys(input, ['key', 'text'], 'A draft')
  const key = own(input, 'key')
  const text = own(input, 'text')
  if (typeof key !== 'string' || !DRAFT_KEY.test(key)) refuseRequest('The draft key must name a conversation or a project.')
  if (typeof text !== 'string' || (text !== '' && !isDraftText(text))) refuseRequest(`The draft must be text of at most ${String(CHAT_MESSAGE_CAP)} bytes.`)
  return { key, text }
}

export type ChatDrafts = Disposable & {
  /** Removes one draft: Archon accepted its message, or its conversation was deleted. */
  clear(key: string): void
}

/** Answers the frames' `chat.drafts.read` and `chat.draft.write`. */
export function startChatDrafts(orca: OrcaWorkerApi, ports: { timers: Timers }): ChatDrafts {
  let held: Promise<Draft[]> | undefined
  let pending: unknown
  let current: Draft[] = []

  function load(): Promise<Draft[]> {
    held ??= orca.storage.get(DRAFTS_STORAGE_KEY).then(
      (value) => (current = parseStoredDrafts(value)),
      () => current
    )
    return held.then(() => current)
  }

  function flush(): void {
    if (pending === undefined) return
    ports.timers.clear(pending)
    pending = undefined
    const value = current.map(({ key, text }) => ({ key, text }))
    orca.storage.set(DRAFTS_STORAGE_KEY, value).catch((error: unknown) => orca.log(`Orchon could not save the chat drafts: ${String(error)}`))
  }

  function change(key: string, text: string): void {
    const rest = current.filter((draft) => draft.key !== key)
    current = (text === '' ? rest : [{ key, text }, ...rest]).slice(0, DRAFTS_KEPT)
    if (pending !== undefined) ports.timers.clear(pending)
    pending = ports.timers.set(flush, DRAFT_WRITE_PAUSE_MS)
  }

  const reads = orca.panels.handle('chat.drafts.read', async (): Promise<ChatDraftsAnswer> => {
    const drafts: Record<string, string> = {}
    for (const draft of await load()) drafts[draft.key] = draft.text
    return { drafts }
  })
  const writes = orca.panels.handle('chat.draft.write', async (input): Promise<null> => {
    const { key, text } = parseDraftWrite(input)
    await load()
    change(key, text)
    return null
  })
  return {
    clear(key) {
      load()
        .then(() => {
          if (current.some((draft) => draft.key === key)) change(key, '')
        })
        .catch(() => {})
    },
    dispose() {
      reads.dispose()
      writes.dispose()
      // What waits for the pause is written now, so a draft outlives the worker.
      flush()
    }
  }
}
