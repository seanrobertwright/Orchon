// The Chat section of the panel: the list of the scope's conversations with Archon's agent. It
// draws only the worker's view model and fetches it under the shared per-view fetch rules, under
// the project scope of `scope-section.tsx`. It ignores run hints and has no search. A row opens
// the conversation's thread, drawn by `chat-thread-section.tsx` in place of the list. **New chat**
// belongs to a later ticket: the button is drawn disabled, with its reason beside it.
import {
  atom,
  Button,
  Callout,
  EmptyState,
  Heading,
  Link,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Text,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { chatThreadHasData, chatThreadSection, clearChatThread, openChatId, openChatThread, restartChatThread, startChatThreadSection } from './chat-thread-section'
import { ARCHON_CONVERSATIONS_CAP, CHAT_LIST_GAP_MS, type ChatRow, type ChatsAnswer, type ChatsRequest, type ChatsView } from './chats-view'
import type { Connected, ConnectionView } from './connection-view'
import { now } from './dates'
import { frameTimers } from './frame-timers'
import { plural } from './plural'
import { scopeChoice, scopedProjectId, scopeNotice, scopeSettled, scopeSwitch } from './scope-section'
import { createViewFetch, LIVE_OFF_REFETCH_MS, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { problemLine, type ReadProblem } from './view-notices'
import { offersTryAgain, troubleText } from './worker-words'

type Ready = Extract<ChatsView, { kind: 'ready' }>

const loaded = atom<Ready | null>(null)
const problem = atom<ReadProblem | null>(null)
const lastGood = atom<number | null>(null)

/** Why **New chat** is disabled: starting a chat is not built yet. */
export const NEW_CHAT_LATER = 'Starting a chat from Orchon is not available yet.'

/** The notice at Archon's 50 rows. */
export const CAPPED_TEXT = `Showing the ${String(ARCHON_CONVERSATIONS_CAP)} most recent conversations. Archon lists no more, so some may be missing.`

/** What the section reads from the rest of the panel. */
export type ChatSectionHooks = {
  connection(): ConnectionView | null
  /** Whether the Chat section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
}

/** The section's fetch rules for this panel run: the one handle every restart goes through. */
let fetcher: ViewFetch | undefined

function report(message: string, tryAgain = true): void {
  set(problem, { message, lastGood: read(lastGood), tryAgain })
}

function apply(answer: ChatsAnswer | null, hooks: ChatSectionHooks): void {
  if (answer === null) return
  hooks.keep(answer.connection)
  const { chats } = answer
  if (chats.kind === 'ready') {
    set(loaded, chats)
    set(problem, null)
    set(lastGood, now())
  } else if (chats.kind === 'failed') {
    report(chats.message)
  }
}

/** Starts the section's fetch rules for this panel run. They stop when the panel closes. */
export function startChatSection(ctx: PanelContext, given: ChatSectionHooks): void {
  const view = createViewFetch<ChatsAnswer | null>({
    load(signal) {
      // The list waits for the scope, so it never reads one project and then another.
      // Nor is it read while a thread shows in its place.
      if (given.connection()?.kind !== 'connected' || !given.showing() || !scopeSettled() || openChatId() !== null) return Promise.resolve(null)
      const codebaseId = scopedProjectId()
      const request: ChatsRequest = codebaseId === undefined ? {} : { codebaseId }
      return plugin.request('chats.read', request, { signal })
    },
    apply: (answer) => apply(answer, given),
    // Worker unreachable, said by the shared fetch rules; a rate-limited read says nothing.
    fail(_error, trouble) {
      if (trouble !== null) report(troubleText(trouble), offersTryAgain(trouble))
    },
    minGapMs: CHAT_LIST_GAP_MS,
    safetyMs: () => {
      const state = given.connection()
      return state?.kind === 'connected' && !state.live ? LIVE_OFF_REFETCH_MS : SAFETY_REFETCH_MS
    },
    now,
    timers: frameTimers
  })
  fetcher = view
  startChatThreadSection(ctx, { ...given, back: () => view.restart() })
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Whether the list holds an answer to show, as Searching keeps it under its banner. */
export function chatsHaveData(): boolean {
  return openChatId() === null ? read(loaded) !== null : chatThreadHasData()
}

/** A different Archon store: what the section loaded belongs to the old one. */
export function clearChats(): void {
  set(loaded, null)
  set(problem, null)
  set(lastGood, null)
  clearChatThread()
}

/**
 * Reads the list again at once: the section was shown, the scope changed or a person asked.
 * While a thread shows in its place, the thread is read instead.
 */
export function restartChats(): void {
  if (openChatId() === null) fetcher?.restart()
  else restartChatThread()
}

/** The project scope changed: the list follows it, and an open thread, which does not, is not read again. */
export function rescopeChats(): void {
  if (openChatId() === null) fetcher?.restart()
}

function unreadableLine(count: number): string {
  return plural(count, 'conversation could not be read and is not shown.', 'conversations could not be read and are not shown.')
}

function chatRow(chat: ChatRow, allProjects: boolean): OrcaNode {
  const title = chat.title ?? 'Untitled'
  const project = allProjects ? (chat.project ?? 'No project') : undefined
  return (
    <ListItem key={chat.id} title={title} description={project} onPress={() => openChatThread(chat.id)}>
      {chat.lastActivityAt === null ? null : (
        <Text muted size="sm">
          <RelativeTime at={chat.lastActivityAt} />
        </Text>
      )}
    </ListItem>
  )
}

/** The section while connected or under the Searching banner. `writable` is false when its controls that write are off. */
export function chatSection(state: Connected, writable: boolean): OrcaNode {
  if (openChatId() !== null) return chatThreadSection(writable)
  const chats = read(loaded)
  const held = read(problem)
  const allProjects = scopeChoice() === 'all'
  const projectId = scopedProjectId()
  const openConsole = (): void => {
    const page = projectId === undefined ? '/console' : `/console/p/${encodeURIComponent(projectId)}/chat`
    shell.openExternal(`${state.baseUrl}${page}`).catch(() => {})
  }
  let body: OrcaNode
  if (chats === null) body = held === null ? <Spinner label="Loading conversations…" /> : null
  else if (chats.rows.length === 0) body = <EmptyState title="No conversations yet" description="Chats with Archon's agent appear here." />
  else body = <List label="Conversations">{chats.rows.map((chat) => chatRow(chat, allProjects))}</List>
  return (
    <Stack gap="sm">
      {scopeSwitch()}
      {scopeNotice(writable)}
      <Row gap="sm" wrap align="center">
        <Heading level={3}>Conversations</Heading>
        <Button size="sm" variant="outline" disabled tooltip={NEW_CHAT_LATER}>
          New chat
        </Button>
      </Row>
      <Text muted size="sm">
        {NEW_CHAT_LATER}
      </Text>
      {held === null ? null : problemLine(held, chats !== null, () => restartChats())}
      {chats?.capped === true ? <Callout tone="neutral">{CAPPED_TEXT}</Callout> : null}
      {body}
      {chats !== null && chats.unreadable > 0 ? (
        <Text muted size="sm">
          {unreadableLine(chats.unreadable)}
        </Text>
      ) : null}
      <Link onPress={openConsole}>Open in Archon console</Link>
    </Stack>
  )
}
