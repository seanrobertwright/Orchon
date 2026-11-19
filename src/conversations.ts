// The validator and view-model builder of `GET /api/conversations`. It lists only the fields the
// chat list reads, all of them present at the floor (Archon 0.12.1), and ignores the rest of
// Archon's answer, so nothing else reaches a frame. A row that fails is dropped and counted; an
// answer that is not a list is an error.
import { parseInstant } from './dates'
import { isRecord, own } from './records'

export const CONVERSATIONS_PATH = '/api/conversations'

/** The only platform the list shows: CLI and Telegram conversations are never listed. */
export const WEB_PLATFORM = 'web'

/** The conversation ids the worker accepts (#33, Chat): the same rule the later chat requests use. */
export const CONVERSATION_ID = /^[\w-]+$/

/** The most characters a conversation id may have; Archon's are about 25. */
export const CONVERSATION_ID_CAP = 200

/** One conversation as the worker reads it. */
export type Conversation = {
  /** The platform id, which Archon's conversation routes take. */
  id: string
  /** The platform it came from, as Archon names it. */
  platform: string
  title: string | null
  lastActivityAt: number | null
  /** The Archon project's id, or null when the conversation has none. */
  codebaseId: string | null
}

/** A text field that may be missing or null, or false when it is something else. */
function optionalText(record: Record<string, unknown>, key: string): string | null | false {
  const value = own(record, key)
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : false
}

/**
 * One conversation, or null when it cannot be read: no platform id that the conversation id
 * rule accepts, no platform, or a title, time or project that is not text.
 */
export function parseConversation(value: unknown): Conversation | null {
  if (!isRecord(value)) return null
  const id = own(value, 'platform_conversation_id')
  const platform = own(value, 'platform_type')
  if (typeof id !== 'string' || id.length > CONVERSATION_ID_CAP || !CONVERSATION_ID.test(id)) return null
  if (typeof platform !== 'string' || platform === '') return null
  const title = optionalText(value, 'title')
  const lastActivity = optionalText(value, 'last_activity_at')
  const codebaseId = optionalText(value, 'codebase_id')
  if (title === false || lastActivity === false || codebaseId === false) return null
  return {
    id,
    platform,
    // A title of blanks is no title.
    title: title === null || title.trim() === '' ? null : title,
    // A date that does not parse drops the time and keeps the row.
    lastActivityAt: parseInstant(lastActivity),
    codebaseId: codebaseId === '' ? null : codebaseId
  }
}

/** Archon's list, or null when its answer as a whole is not one. `sent` counts every row, read or not. */
export function parseConversations(value: unknown): { rows: Conversation[]; sent: number; unreadable: number } | null {
  if (!Array.isArray(value)) return null
  const rows: Conversation[] = []
  for (const row of value as unknown[]) {
    const conversation = parseConversation(row)
    if (conversation !== null) rows.push(conversation)
  }
  return { rows, sent: value.length, unreadable: value.length - rows.length }
}
