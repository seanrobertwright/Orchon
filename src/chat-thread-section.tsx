// A chat thread, the second level of the Chat section: one conversation's saved messages, newest
// first, in the panel's own scroll. It draws only the worker's view model and fetches it under
// the shared per-view fetch rules, every 30 seconds while it shows and every 3 seconds while a
// turn is in flight. The composer of `chat-composer.tsx` sits at its top. It reads saved messages
// only, with no stream: a turn is inferred from them.
import {
  atom,
  Button,
  Callout,
  CodeView,
  Collapsible,
  Heading,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  type OrcaNode,
  type PanelContext
} from 'orca'
import {
  ARCHON_MESSAGES_CAP,
  THREAD_GAP_MS,
  THREAD_PAGE,
  type Thread,
  type ThreadAnswer,
  type ThreadMessage,
  type ThreadRequest,
  type ThreadToolCall
} from './chat-thread-view'
import { BUSY_REFETCH_MS, chatBusy, composer, observeThread, type ComposerHooks } from './chat-composer'
import type { ConnectionView } from './connection-view'
import { CONVERSATION_ID_CAP } from './conversations'
import { now } from './dates'
import { frameTimers } from './frame-timers'
import { plural } from './plural'
import { createViewFetch, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { problemLine, type ReadProblem } from './view-notices'
import { offersTryAgain, troubleText } from './worker-words'

/**
 * The conversation that is open, kept per workspace because Orca unmounts a hidden panel. It is
 * stored as whatever was written, so it is parsed on every read.
 */
const openChat = atom<unknown>('openChat', null, { persist: 'workspace' })
/** Whether tool calls show, kept per workspace like the open conversation. Off until turned on. */
const toolCallsOn = atom<unknown>('chatToolCalls', false, { persist: 'workspace' })
/** How many of the newest messages the thread asks for. */
const limit = atom(THREAD_PAGE)
const loaded = atom<Thread | null>(null)
/** Set when Archon answered that the open conversation does not exist. */
const gone = atom(false)
const problem = atom<ReadProblem | null>(null)
const lastGood = atom<number | null>(null)

/** What the thread reads from the rest of the panel. */
export type ChatThreadHooks = {
  connection(): ConnectionView | null
  /** Whether the Chat section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** The way back: the list shows again and is read again. */
  back(): void
}

let fetcher: ViewFetch | undefined
let hooks: ChatThreadHooks | undefined

function report(message: string, tryAgain = true): void {
  set(problem, { message, lastGood: read(lastGood), tryAgain })
}

/** The open conversation's id, or null when the list shows. */
export function openChatId(): string | null {
  const value = read(openChat)
  return typeof value === 'string' && value !== '' && value.length <= CONVERSATION_ID_CAP ? value : null
}

const showingToolCalls = (): boolean => read(toolCallsOn) === true

function apply(answer: ThreadAnswer | null): void {
  if (answer === null) return
  hooks?.keep(answer.connection)
  const { thread } = answer
  if (thread.kind === 'ready' && thread.thread.id === openChatId()) {
    observeThread(thread.thread)
    set(loaded, thread.thread)
    set(gone, false)
    set(problem, null)
    set(lastGood, now())
  } else if (thread.kind === 'gone') {
    set(loaded, null)
    set(gone, true)
    set(problem, null)
  } else if (thread.kind === 'failed') {
    report(thread.message)
  }
}

/** Starts the thread's fetch rules for this panel run. They stop when the panel closes. */
export function startChatThreadSection(ctx: PanelContext, given: ChatThreadHooks): void {
  hooks = given
  const view = createViewFetch<ThreadAnswer | null>({
    load(signal) {
      const conversationId = openChatId()
      if (conversationId === null || given.connection()?.kind !== 'connected' || !given.showing()) return Promise.resolve(null)
      const request: ThreadRequest = { conversationId, limit: read(limit) }
      if (showingToolCalls()) request.toolCalls = true
      return plugin.request('chat.read', request, { signal })
    },
    apply,
    // Worker unreachable, said by the shared fetch rules; a rate-limited read says nothing.
    fail(_error, trouble) {
      if (trouble !== null) report(troubleText(trouble), offersTryAgain(trouble))
    },
    minGapMs: THREAD_GAP_MS,
    // While a turn is in flight the thread is read every 3 seconds (#18, part 2).
    safetyMs: () => {
      const id = openChatId()
      return id !== null && chatBusy(id) ? BUSY_REFETCH_MS : SAFETY_REFETCH_MS
    },
    now,
    timers: frameTimers
  })
  fetcher = view
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

function resetView(): void {
  set(loaded, null)
  set(gone, false)
  set(problem, null)
  set(lastGood, null)
  set(limit, THREAD_PAGE)
}

/** Opens a conversation in place of the list. */
export function openChatThread(conversationId: string): void {
  set(openChat, conversationId)
  resetView()
  fetcher?.restart()
}

/** Reads the open thread again at once: the section was shown or the connection came back. */
export function restartChatThread(): void {
  if (openChatId() !== null) fetcher?.restart()
}

/** Whether the thread holds an answer to show, as Searching keeps it under its banner. */
export function chatThreadHasData(): boolean {
  return read(loaded) !== null
}

/** A different Archon store: the open conversation belongs to the old one. */
export function clearChatThread(): void {
  set(openChat, null)
  resetView()
}

function back(): void {
  set(openChat, null)
  resetView()
  hooks?.back()
}

function toggleToolCalls(on: boolean): void {
  set(toolCallsOn, on)
  // The worker carries tool calls only when asked, so the thread is read again with or without them.
  fetcher?.restart()
}

function showEarlier(): void {
  set(limit, Math.min(read(limit) + THREAD_PAGE, ARCHON_MESSAGES_CAP))
  fetcher?.restart()
}

const ROLE_WORD: Record<ThreadMessage['role'], string> = { user: 'You', assistant: 'Agent', system: 'System' }

/** The line under a text cut short, or null when all of it is shown. */
function notShownLine(count: number, of: string): OrcaNode {
  if (count === 0) return null
  return (
    <Text muted size="sm">
      {`${plural(count, 'character', 'characters')} of ${of} ${count === 1 ? 'is' : 'are'} not shown.`}
    </Text>
  )
}

/** A message's content: its blocks one under the other, with no gap between them. */
function contentOf(message: ThreadMessage): OrcaNode {
  if (message.blocks.length === 0) return null
  let at = 0
  const blocks = message.blocks.map((block) => {
    const key = `${message.id}:${String(at)}`
    at += block.length
    return message.format === 'markdown' ? <Markdown key={key} content={block} /> : <Text key={key}>{block}</Text>
  })
  return <Stack gap="none">{blocks}</Stack>
}

function toolCallRow(call: ThreadToolCall): OrcaNode {
  return (
    <Collapsible key={call.id} title={call.name} description="Tool call">
      <Stack gap="xs">
        {call.input === null ? (
          <Text muted size="sm">
            No input was saved.
          </Text>
        ) : (
          <CodeView code={call.input} label={`Input of ${call.name}`} language="json" wrap />
        )}
        {notShownLine(call.inputNotShown, 'the input')}
        {call.output === null ? (
          <Text muted size="sm">
            No output was saved.
          </Text>
        ) : (
          <CodeView code={call.output} label={`Output of ${call.name}`} wrap />
        )}
        {notShownLine(call.outputNotShown, 'the output')}
      </Stack>
    </Collapsible>
  )
}

function filesLine(files: NonNullable<ThreadMessage['files']>): OrcaNode {
  const more = files.notShown === 0 ? '' : `, and ${String(files.notShown)} more`
  return (
    <Text muted size="sm">
      {`Sent with ${plural(files.names.length + files.notShown, 'file', 'files')}: ${files.names.join(', ')}${more}`}
    </Text>
  )
}

/** One message, or null when it has nothing to show: only tool calls, while they are hidden. */
function messageNode(message: ThreadMessage, withToolCalls: boolean): OrcaNode {
  const toolCalls = withToolCalls ? message.toolCalls : undefined
  if (message.blocks.length === 0 && message.error === undefined && message.files === undefined && toolCalls === undefined) return null
  return (
    <Stack key={message.id} gap="xs">
      <Row gap="sm" align="center">
        <Text weight="semibold">{ROLE_WORD[message.role]}</Text>
        {message.at === null ? null : (
          <Text muted size="sm">
            <RelativeTime at={message.at} />
          </Text>
        )}
      </Row>
      {contentOf(message)}
      {notShownLine(message.notShown, 'this message')}
      {message.files === undefined ? null : filesLine(message.files)}
      {message.error === undefined ? null : (
        <Callout tone="danger" title="Error">
          <Text>{message.error}</Text>
        </Callout>
      )}
      {toolCalls === undefined ? null : toolCalls.calls.map(toolCallRow)}
      {toolCalls === undefined || toolCalls.notShown === 0 ? null : (
        <Text muted size="sm">
          {`${plural(toolCalls.notShown, 'more tool call is', 'more tool calls are')} not shown.`}
        </Text>
      )}
    </Stack>
  )
}

function header(): OrcaNode {
  return (
    <Row gap="sm" align="center" justify="between" wrap>
      <Button size="sm" variant="ghost" tooltip="Back to the conversations" onPress={back}>
        Chats
      </Button>
      <Switch label="Show tool calls" checked={showingToolCalls()} onChange={toggleToolCalls} />
    </Row>
  )
}

/** What the composer of the open thread tells the thread. */
const threadComposerHooks: ComposerHooks = {
  keep: (view) => hooks?.keep(view),
  sent: () => fetcher?.restart(),
  refetch: () => fetcher?.restart()
}

function threadBody(thread: Thread, writable: boolean): OrcaNode {
  const withToolCalls = showingToolCalls()
  const messages = thread.messages.map((message) => messageNode(message, withToolCalls)).filter((node) => node !== null)
  return (
    <Stack gap="sm">
      <Heading level={3}>{thread.title ?? 'Untitled'}</Heading>
      {thread.project === null ? (
        <Text muted size="sm">
          No project
        </Text>
      ) : (
        <Stack gap="none">
          <Text muted size="sm">
            {thread.project.name}
          </Text>
          <Text muted size="sm">
            {thread.project.defaultCwd}
          </Text>
        </Stack>
      )}
      {composer({ kind: 'thread', conversationId: thread.id, newest: thread.messages[0] }, { writable, hooks: threadComposerHooks })}
      {messages.length === 0 ? <Text muted>No messages yet.</Text> : <Stack gap="md">{messages}</Stack>}
      {thread.unreadable === 0 ? null : (
        <Text muted size="sm">
          {plural(thread.unreadable, 'message could not be read and is not shown.', 'messages could not be read and are not shown.')}
        </Text>
      )}
      {thread.cut === 0 ? null : (
        <Text muted size="sm">
          {`${plural(thread.cut, 'older message is', 'older messages are')} not shown: the thread is too long to show at once. Archon's console shows all of it.`}
        </Text>
      )}
      {thread.earlier ? (
        <Row>
          <Button size="sm" variant="outline" onPress={showEarlier}>
            Show earlier
          </Button>
        </Row>
      ) : null}
      {thread.atArchonCap ? (
        <Text muted size="sm">
          {`Archon sends only the ${String(ARCHON_MESSAGES_CAP)} newest messages, so older messages cannot be fetched.`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** The thread in place of the list, while connected or under the Searching banner. `writable` is false when its controls that write are off. */
export function chatThreadSection(writable: boolean): OrcaNode {
  const thread = read(loaded)
  const held = read(problem)
  let body: OrcaNode
  if (read(gone)) {
    body = (
      <Stack gap="sm">
        <Text>This conversation no longer exists in Archon.</Text>
        <Row>
          <Button size="sm" variant="outline" onPress={back}>
            Back to conversations
          </Button>
        </Row>
      </Stack>
    )
  } else if (thread === null) body = held === null ? <Spinner label="Loading the conversation…" /> : null
  else body = threadBody(thread, writable)
  return (
    <Stack gap="sm">
      {header()}
      {held === null ? null : problemLine(held, thread !== null, () => fetcher?.restart())}
      {body}
    </Stack>
  )
}
