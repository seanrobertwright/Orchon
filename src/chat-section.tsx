// The Chat section of the panel: the list of the scope's conversations with Archon's agent. It
// draws only the worker's view model and fetches it under the shared per-view fetch rules, under
// the project scope of `scope-section.tsx`. It ignores run hints, reads the list again on a chat
// hint, and has no search. A row opens the conversation's thread, drawn by `chat-thread-section.tsx`
// in place of the list. **New chat** opens an empty thread, drawn by `chat-new.tsx`, whose first
// send creates the conversation.
import {
  atom,
  Badge,
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
import { readComposerDrafts, startComposerDrafts } from './chat-composer'
import { closeNewChat, newChatHasData, newChatSection, newChatShowing, openNewChat, rescopeNewChat } from './chat-new'
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

/** The notice at Archon's 50 rows. */
export const CAPPED_TEXT = `Showing the ${String(ARCHON_CONVERSATIONS_CAP)} most recent conversations. Archon lists no more, so some may be missing.`

/** What the section reads from the rest of the panel. */
export type ChatSectionHooks = {
  connection(): ConnectionView | null
  /** Whether the Chat section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** Open run on a thread's dispatch row or result card: shows the Runs section on the run's detail. */
  openRun(runId: string): void
}

/** The section's hooks for this panel run, which the new chat reads. */
let sectionHooks: ChatSectionHooks | undefined

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
      if (given.connection()?.kind !== 'connected' || !given.showing() || !scopeSettled() || openChatId() !== null || newChatShowing()) return Promise.resolve(null)
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
  sectionHooks = given
  // A conversation's stream said something, so a row's Working badge may have changed.
  ctx.subscriptions.push(
    plugin.on('chat.changed', () => {
      if (openChatId() === null && !newChatShowing()) view.refresh()
    })
  )
  startChatThreadSection(ctx, { ...given, back: () => view.restart() })
  startComposerDrafts(ctx)
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Whether the list holds an answer to show, as Searching keeps it under its banner. */
export function chatsHaveData(): boolean {
  if (newChatShowing()) return newChatHasData()
  return openChatId() === null ? read(loaded) !== null : chatThreadHasData()
}

/** A different Archon store: what the section loaded belongs to the old one. */
export function clearChats(): void {
  set(loaded, null)
  set(problem, null)
  set(lastGood, null)
  closeNewChat()
  clearChatThread()
}

/**
 * Reads the list again at once: the section was shown, the scope changed or a person asked.
 * While a thread shows in its place, the thread is read instead.
 */
export function restartChats(): void {
  if (sectionHooks?.showing() === true) readComposerDrafts()
  if (openChatId() === null) fetcher?.restart()
  else restartChatThread()
}

/** The project scope changed: the list follows it, and an open thread, which does not, is not read again. */
export function rescopeChats(): void {
  rescopeNewChat(scopedProjectId())
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
      {chat.working === true ? <Badge tone="accent">Working</Badge> : null}
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
  if (newChatShowing()) {
    return newChatSection(writable, {
      keep: (view) => sectionHooks?.keep(view),
      opened: openChatThread,
      back: () => fetcher?.restart()
    })
  }
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
        <Button size="sm" variant="outline" onPress={() => openNewChat(projectId)}>
          New chat
        </Button>
      </Row>
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
