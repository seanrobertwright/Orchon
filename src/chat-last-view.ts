// A thread's last answer, as a frame gets it: the request a panel that mounts again sends, and
// the thread the worker last answered for it. It is types and constants only.
import type { Thread } from './chat-thread-view'

/** How long a thread's reads hold its lease: past it with no read, the worker drops its last answer. */
export const THREAD_LEASE_MS = 60_000

/** How many threads' last answers the worker holds at once: the least recently read goes first. */
export const LAST_ANSWERS_CAP = 5

/** What a panel sends: the conversation whose thread it is about to show. */
export type ChatLastRequest = { conversationId: string }

/** The thread as the worker last read it while its lease holds, or null. */
export type ChatLastAnswer = { thread: Thread | null }
