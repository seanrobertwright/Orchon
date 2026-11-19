// A chat thread's **Delete**: the button in the thread's header and the inline danger callout that
// asks first, safe button first, the pattern Cancel and Abandon use in run detail (#18, part 7).
// It is off while the conversation is busy and while writes are off. A delete goes to the worker
// once and is never sent again; after it the list opens and is read again. There is no rename.
// Nothing here moves focus.
import { atom, Button, Callout, plugin, read, Row, set, Stack, Text, type OrcaNode } from 'orca'
import type { ChatDeleteAnswer, ChatDeleteOutcome } from './chat-delete-view'
import type { ConnectionView } from './connection-view'
import { nextTrouble, rejectionOf } from './view-fetch'
import { troubleText } from './worker-words'

/** The callout's question. */
export const DELETE_QUESTION = 'Delete this conversation?'

/** What the callout says under its question. */
export const DELETE_WARNING = "Archon removes it from its lists, and it cannot be brought back from here or from Archon's console."

/** The conversation whose callout is open, or null. */
const asking = atom<string | null>(null)
/** The conversation whose delete waits for the worker, or null. */
const deleting = atom<string | null>(null)
/** The note in the callout after a delete that did not happen, by conversation. */
const note = atom<{ conversationId: string; text: string } | null>(null)

/** What the Delete tells the thread. */
export type DeleteHooks = {
  keep(view: ConnectionView): void
  /** The conversation no longer exists: the list opens and is read again. */
  deleted(): void
  /** The answer leaves the conversation in doubt, so the thread is read again. */
  refetch(): void
}

/** The person left the thread, or opened another: the callout closes. A delete in flight goes on. */
export function closeDelete(): void {
  set(asking, null)
  set(note, null)
}

function noteOf(outcome: ChatDeleteOutcome): string | null {
  switch (outcome.kind) {
    case 'deleted':
    case 'gone':
      return null
    case 'timeout':
      return `Archon did not answer within ${String(outcome.timeoutMs / 1000)} seconds. The conversation may have been deleted, so it was not sent again.`
    case 'refused':
      return outcome.message
    case 'not-connected':
      return 'Orchon is not connected to Archon. Nothing was deleted.'
  }
}

async function remove(conversationId: string, hooks: DeleteHooks): Promise<void> {
  if (read(deleting) !== null) return
  set(deleting, conversationId)
  set(note, null)
  let text: string | null
  try {
    const answer: ChatDeleteAnswer = await plugin.request('chat.delete', { conversationId })
    hooks.keep(answer.connection)
    text = noteOf(answer.outcome)
    if (text === null) {
      set(deleting, null)
      if (read(asking) === conversationId) closeDelete()
      hooks.deleted()
      return
    }
    if (answer.outcome.kind === 'timeout') hooks.refetch()
  } catch (error) {
    const trouble = nextTrouble(null, rejectionOf(error))
    text = trouble === null ? 'Orchon could not delete the conversation.' : troubleText(trouble)
    hooks.refetch()
  }
  set(deleting, null)
  if (read(asking) === conversationId) set(note, { conversationId, text })
}

/** The header's Delete. `off` is true while the conversation is busy or writes are off. */
export function deleteButton(conversationId: string, off: boolean): OrcaNode {
  return (
    <Button size="sm" variant="ghost" tone="danger" disabled={off || read(deleting) !== null} onPress={() => set(asking, conversationId)}>
      Delete
    </Button>
  )
}

/** The inline confirmation while it is open for this conversation, else null. */
export function deleteCallout(conversationId: string, off: boolean, hooks: DeleteHooks): OrcaNode {
  if (read(asking) !== conversationId) return null
  const pressed = read(deleting) === conversationId
  const held = read(note)
  return (
    <Callout tone="danger" title={DELETE_QUESTION}>
      <Stack gap="xs">
        <Text>{DELETE_WARNING}</Text>
        {held === null || held.conversationId !== conversationId ? null : <Text>{held.text}</Text>}
        <Row gap="sm" wrap>
          <Button size="sm" variant="outline" disabled={pressed} onPress={closeDelete}>
            Keep conversation
          </Button>
          <Button size="sm" tone="danger" disabled={off || read(deleting) !== null} onPress={() => void remove(conversationId, hooks)}>
            {pressed ? 'Deleting…' : 'Delete conversation'}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}
