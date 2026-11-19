// Chat drafts as a frame gets them: the requests a panel sends and what the worker answers. It is
// types and constants, so the panel and the worker read one contract.
import { CONVERSATION_ID_CAP } from './conversations'
import { PROJECT_ID_CAP } from './scope-view'

/** How many drafts plugin storage keeps: the most recently edited. */
export const DRAFTS_KEPT = 20

/** How long the worker waits after the last change before it writes the drafts to plugin storage. */
export const DRAFT_WRITE_PAUSE_MS = 1_000

/** How long the panel waits after the last keystroke before it hands a draft to the worker. */
export const DRAFT_SEND_PAUSE_MS = 500

/**
 * A draft's key: `conversation:` and a conversation id for an open thread, or `new:` and an
 * Archon project id for a new chat in that project, `new:all` under "All projects".
 */
export const DRAFT_KEY = new RegExp(`^(?:conversation:[\\w-]{1,${String(CONVERSATION_ID_CAP)}}|new:[\\w-]{1,${String(PROJECT_ID_CAP)}})$`)

/** The draft key of an open conversation. */
export const conversationDraftKey = (conversationId: string): string => `conversation:${conversationId}`

/** The draft key of a new chat in an Archon project. */
export const newChatDraftKey = (codebaseId: string): string => `new:${codebaseId}`

/** What `chat.drafts.read` answers: every kept draft's text by its key. */
export type ChatDraftsAnswer = { drafts: Record<string, string> }

/** What `chat.draft.write` takes: the draft's key and its text, where empty text removes it. */
export type ChatDraftWrite = { key: string; text: string }
