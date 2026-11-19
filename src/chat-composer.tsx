// The chat composer: the text area, **Send** and the hint line at the top of a thread or a new
// chat, and what the panel does with each answer to a send. A send goes to the worker once and is
// never sent again; the typed text stays until Archon accepts it. Drafts are kept per
// conversation, and per project for a new chat, by the worker in plugin storage: the panel reads
// them when it mounts, hands each change to the worker after a pause, and hands what still waits
// when it unmounts. Nothing here moves focus.
import { atom, type Atom, Button, plugin, read, Row, set, Spinner, Stack, Text, Textarea, type OrcaNode, type PanelContext } from 'orca'
import { DRAFT_SEND_PAUSE_MS } from './chat-drafts-view'
import { CHAT_MESSAGE_CAP, COMPOSER_CHARACTER_CAP, messageBytes, type ChatSendAnswer, type ChatSendOutcome, type ChatSendRequest } from './chat-send-view'
import type { Thread, ThreadMessage } from './chat-thread-view'
import type { ConnectionView } from './connection-view'
import { now } from './dates'
import { frameTimers } from './frame-timers'
import { isRecord } from './records'
import { offersTryAgain, troubleText } from './worker-words'
import { nextTrouble, rejectionOf } from './view-fetch'

/** The hint under the text area. */
export const COMPOSER_HINT = 'Enter adds a line. Ctrl+Enter sends (Cmd+Enter on macOS).'

/**
 * Where a composer sends: an open conversation, with its newest message as drawn now, or a new
 * chat in a project (null while none is chosen).
 */
export type ComposerTarget =
  | { kind: 'thread'; conversationId: string; newest: ThreadMessage | undefined }
  | { kind: 'new'; draftKey: string; codebaseId: string | null }

/** How often a busy thread is read again (#18, part 2). */
export const BUSY_REFETCH_MS = 3_000
/** How long the agent's newest message must stay unchanged for its turn to count as done (#18, part 3). */
export const DONE_AFTER_MS = 6_000
/** How long the composer waits for a reply before it unlocks (#18, part 3). */
export const GIVE_UP_MS = 5 * 60_000

/** The note when the composer unlocked with no reply. */
export const GAVE_UP_NOTE = `No reply came within ${String(GIVE_UP_MS / 60_000)} minutes, so you can write again. Archon may still be working on it.`

/**
 * A turn the panel infers from the saved messages, with no stream (#18, part 3): a trailing
 * message of the person's means busy, and a trailing message of the agent's that stays unchanged
 * for `DONE_AFTER_MS` means done.
 */
type Turn = {
  /** When the turn began: the send, or the saved time of the person's message that opened it. */
  since: number
  /** After a send: the newest message as it was before it, until the thread shows a newer one. */
  after: string | null | undefined
  /** The newest message as last seen, and since when it has not changed. */
  last: string | null
  lastSince: number
}

/** The turns in flight, by conversation. */
const turns = atom<Record<string, Turn>>({})
/** The conversations whose composer unlocked with no reply, with their newest message then. */
const gaveUp = atom<Record<string, string | null>>({})

/** What tells one newest message from another: its id and what it holds now. */
const messageKey = (message: ThreadMessage | undefined): string | null =>
  message === undefined ? null : `${message.id}\n${String(message.notShown)}\n${message.blocks.join('')}`

/** Sets one key of a record atom, or removes the key when the value is undefined. */
function putKey<T>(store: Atom<Record<string, T>>, key: string, value: T | undefined): void {
  const next = { ...read(store) }
  if (value === undefined) delete next[key]
  else next[key] = value
  set(store, next)
}

const putTurn = (conversationId: string, turn: Turn | null): void => putKey(turns, conversationId, turn ?? undefined)

const putGaveUp = (conversationId: string, key: string | null | undefined): void => putKey(gaveUp, conversationId, key)

const ownTurn = (conversationId: string): Turn | undefined => {
  const all = read(turns)
  return Object.hasOwn(all, conversationId) ? all[conversationId] : undefined
}

/** Whether a turn is in flight for the conversation, as far as the panel can tell. */
export function chatBusy(conversationId: string): boolean {
  return ownTurn(conversationId) !== undefined
}

/** A message was accepted: the conversation is busy from now until its reply is saved. */
export function beginTurn(conversationId: string, newest: ThreadMessage | undefined): void {
  const at = now()
  const key = messageKey(newest)
  putGaveUp(conversationId, undefined)
  putTurn(conversationId, { since: at, after: key, last: key, lastSince: at })
}

/** Reads a thread the worker answered into the conversation's turn. */
export function observeThread(thread: Thread): void {
  const at = now()
  const newest = thread.messages[0]
  const key = messageKey(newest)
  const unlocked = read(gaveUp)
  if (Object.hasOwn(unlocked, thread.id) && unlocked[thread.id] !== key) putGaveUp(thread.id, undefined)
  let turn = ownTurn(thread.id)
  if (turn === undefined) {
    if (newest?.role !== 'user' || Object.hasOwn(read(gaveUp), thread.id)) return
    turn = { since: newest.at ?? at, after: undefined, last: key, lastSince: at }
  }
  if (key !== turn.last) turn = { ...turn, last: key, lastSince: at }
  if (turn.after !== undefined && key !== turn.after) turn = { ...turn, after: undefined }
  const waiting = turn.after !== undefined || newest?.role === 'user'
  if (waiting && at - turn.since >= GIVE_UP_MS) {
    putTurn(thread.id, null)
    putGaveUp(thread.id, key)
  } else if (!waiting && at - turn.lastSince >= DONE_AFTER_MS) putTurn(thread.id, null)
  else putTurn(thread.id, turn)
}

/** What the composer tells the rest of the Chat section. */
export type ComposerHooks = {
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** Archon accepted the message. For a new chat the id is the conversation it created. */
  sent(conversationId: string): void
  /** The answer leaves the conversation in doubt, so it is read again. */
  refetch(): void
}

/** The typed text by draft key, as the worker kept it and as typed since. */
const drafts = atom<Record<string, string>>({})
/** The draft keys typed in during this panel run, which the worker's drafts read later do not replace. */
const typed = atom<Record<string, true>>({})
/** The drafts that wait for the pause before they go to the worker, by key. */
const waiting = new Map<string, unknown>()
/** One send at a time: the draft key of the send that waits for the worker, or null. */
const sending = atom<string | null>(null)
/** The note under a composer after its last send, by draft key. */
const notes = atom<Record<string, string>>({})

const draftKeyOf = (target: ComposerTarget): string => (target.kind === 'thread' ? `conversation:${target.conversationId}` : target.draftKey)

/** Sets a draft or a note, removing it when there is none. */
const setIn = (store: Atom<Record<string, string>>, key: string, value: string | null): void =>
  putKey(store, key, value === null || value === '' ? undefined : value)

const draftOf = (key: string): string => {
  const all = read(drafts)
  return Object.hasOwn(all, key) ? (all[key] ?? '') : ''
}

const noteOf = (key: string): string | null => {
  const all = read(notes)
  return Object.hasOwn(all, key) ? (all[key] ?? null) : null
}

/** Hands one draft to the worker now, as it stands. Text past the cap stays in the panel only. */
function handDraft(key: string): void {
  const pending = waiting.get(key)
  if (pending !== undefined) frameTimers.clear(pending)
  waiting.delete(key)
  const text = draftOf(key)
  if (messageBytes(text) > CHAT_MESSAGE_CAP) return
  plugin.request('chat.draft.write', { key, text }).catch(() => {})
}

/** A keystroke: the draft changes now, and goes to the worker after a pause with no other. */
function typeDraft(key: string, text: string): void {
  setIn(drafts, key, text)
  putKey(typed, key, true)
  const pending = waiting.get(key)
  if (pending !== undefined) frameTimers.clear(pending)
  waiting.set(
    key,
    frameTimers.set(() => handDraft(key), DRAFT_SEND_PAUSE_MS)
  )
}

/** Whether this panel run asked the worker for its drafts. */
const draftsAsked = atom(false)

/** Hands what still waits to the worker when the panel unmounts. */
export function startComposerDrafts(ctx: PanelContext): void {
  ctx.subscriptions.push({
    dispose() {
      for (const key of [...waiting.keys()]) handDraft(key)
    }
  })
}

/** Reads the worker's drafts, once in this panel run: the Chat section began to show. */
export function readComposerDrafts(): void {
  if (read(draftsAsked)) return
  set(draftsAsked, true)
  plugin.request('chat.drafts.read').then(
    (answer) => {
      const stored: Record<string, string> = {}
      if (isRecord(answer.drafts)) for (const [key, text] of Object.entries(answer.drafts)) if (typeof text === 'string') stored[key] = text
      const mine = read(typed)
      const held = read(drafts)
      for (const key of Object.keys(mine)) {
        if (Object.hasOwn(held, key)) stored[key] = held[key] ?? ''
        else delete stored[key]
      }
      set(drafts, stored)
    },
    () => {}
  )
}

/** The note after an answer that did not take the message. */
function outcomeNote(outcome: ChatSendOutcome): string | null {
  switch (outcome.kind) {
    case 'sent':
      return null
    case 'timeout':
      return `Archon did not answer within ${String(outcome.timeoutMs / 1000)} seconds. The message may have arrived, so it was not sent again; your text is still here.`
    case 'refused':
      return outcome.message
    case 'gone':
      return 'This conversation no longer exists in Archon. Nothing was sent.'
    case 'not-connected':
      return 'Orchon is not connected to Archon. Nothing was sent.'
  }
}

async function send(target: ComposerTarget, message: string, hooks: ComposerHooks): Promise<void> {
  const key = draftKeyOf(target)
  if (read(sending) !== null || message === '' || messageBytes(message) > CHAT_MESSAGE_CAP) return
  let request: ChatSendRequest
  if (target.kind === 'thread') request = { conversationId: target.conversationId, message }
  else if (target.codebaseId !== null) request = { codebaseId: target.codebaseId, message }
  else return
  set(sending, key)
  setIn(notes, key, null)
  try {
    const answer: ChatSendAnswer = await plugin.request('chat.send', request)
    hooks.keep(answer.connection)
    const { outcome } = answer
    if (outcome.kind === 'sent') {
      setIn(drafts, key, null)
      putKey(typed, key, true)
      handDraft(key)
      beginTurn(outcome.conversationId, target.kind === 'thread' ? target.newest : undefined)
      hooks.sent(outcome.conversationId)
      return
    }
    setIn(notes, key, outcomeNote(outcome))
    if (outcome.kind === 'timeout' || outcome.kind === 'gone') hooks.refetch()
  } catch (error) {
    // The worker did not answer: whether the message arrived is not known, so the thread is read again.
    const trouble = nextTrouble(null, rejectionOf(error))
    const words = trouble === null ? 'Orchon could not send the message. Your text is still here.' : troubleText(trouble)
    setIn(notes, key, offersTryAgain(trouble ?? { kind: 'consent' }) ? `${words} Your text is still here.` : words)
    hooks.refetch()
  } finally {
    set(sending, null)
  }
}

/**
 * The composer, with the working line directly below it while a turn is in flight, when the
 * composer is disabled. `writable` is false while writes are off (Searching, a state screen,
 * Worker unreachable).
 */
export function composer(target: ComposerTarget, options: { writable: boolean; hooks: ComposerHooks }): OrcaNode {
  const busy = target.kind === 'thread' && chatBusy(target.conversationId)
  const unlocked = target.kind === 'thread' && Object.hasOwn(read(gaveUp), target.conversationId)
  const key = draftKeyOf(target)
  const text = draftOf(key)
  const inFlight = read(sending) !== null
  const locked = busy || read(sending) === key
  // Counted only past the point where the text could pass the cap: a character is at most 3 bytes of UTF-8 per UTF-16 unit.
  const bytes = text.length * 3 > CHAT_MESSAGE_CAP ? messageBytes(text) : text.length
  const tooLong = bytes > CHAT_MESSAGE_CAP
  const canSend = options.writable && !inFlight && !busy && text !== '' && !tooLong && (target.kind === 'thread' || target.codebaseId !== null)
  const note = noteOf(key)
  const press = (value: string): void => {
    if (!canSend) return
    send(target, value, options.hooks).catch(() => {})
  }
  return (
    <Stack gap="xs">
      <Textarea
        label="Message to Archon's agent"
        labelHidden
        rows={3}
        value={text}
        maxLength={COMPOSER_CHARACTER_CAP}
        invalid={tooLong}
        disabled={locked}
        onChange={(value) => typeDraft(key, value)}
        onSubmit={(value) => press(value)}
      />
      <Row gap="sm" align="center" wrap>
        <Button size="sm" variant="solid" disabled={!canSend} onPress={() => press(text)}>
          Send
        </Button>
        <Text muted size="sm">
          {COMPOSER_HINT}
        </Text>
      </Row>
      {tooLong ? (
        <Text size="sm" tone="danger">
          {`The message is ${String(bytes)} bytes; Archon takes at most ${String(CHAT_MESSAGE_CAP)}. Shorten it to send.`}
        </Text>
      ) : null}
      {note === null ? null : (
        <Text size="sm" tone="warning">
          {note}
        </Text>
      )}
      {unlocked ? (
        <Text size="sm" tone="warning">
          {GAVE_UP_NOTE}
        </Text>
      ) : null}
      {busy ? <Spinner label="Working…" /> : null}
    </Stack>
  )
}
