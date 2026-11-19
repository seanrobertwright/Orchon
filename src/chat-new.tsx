// A new chat: the empty thread **New chat** opens in place of the chat list. It names the project
// the chat will be created in and the folder its agent works in, holds the composer, and says
// what Archon chat is. Its first send creates the conversation, always in a project: the panel's
// selected one, or under "All projects" the one chosen in its own select, where nothing is chosen
// for the person. The worker checks the project against Archon's list again before it creates it.
import { atom, Button, EmptyState, Heading, plugin, read, Row, Select, set, Spinner, Stack, Text, type OrcaNode } from 'orca'
import { composer, type ComposerHooks } from './chat-composer'
import type { ChatProject, ChatProjectsAnswer, ChatProjectsRequest, ChatProjectsView } from './chat-send-view'
import type { ConnectionView } from './connection-view'
import { plural } from './plural'
import { nextTrouble, rejectionOf } from './view-fetch'
import { troubleText } from './worker-words'

/** What the empty state says Archon chat is (#18, part 5). */
export const ABOUT_ARCHON_CHAT =
  "Archon chat talks to Archon's agent about this project. It can start workflows, and it works in the project folder named in the header, not in this workspace's terminal."

/** Said when the panel's project is not one Archon lists now. */
export const NOT_LISTED_LINE = 'Archon does not list this project now, so a chat cannot start in it.'

/** Said under a first send that timed out: the conversation may exist. */
export const MAYBE_CREATED_LINE = 'The chat may have been created: look in the list before you send again.'

/** Whether a new chat shows in place of the list, while the panel is open. */
const showing = atom(false)
/** The project the panel's scope chose when the new chat opened, or null under "All projects". */
const scoped = atom<string | null>(null)
const projects = atom<ChatProjectsView | null>(null)
/** The project chosen in the select under "All projects": none until the person chooses. */
const picked = atom<string | null>(null)
const maybeCreated = atom(false)

/** Rises with each read of the projects: only the answer to the newest is applied. */
let asked = 0

/** What the new chat reads from the rest of the Chat section. */
export type NewChatHooks = {
  keep(view: ConnectionView): void
  /** The first send created this conversation: its thread opens. */
  opened(conversationId: string): void
  /** The way back: the list shows again and is read again. */
  back(): void
}

export const newChatShowing = (): boolean => read(showing)

/** Whether the new chat holds an answer to show, as Searching keeps it under its banner. */
export const newChatHasData = (): boolean => read(projects) !== null

function readProjects(): void {
  asked += 1
  const mine = asked
  const codebaseId = read(scoped)
  const request: ChatProjectsRequest = codebaseId === null ? {} : { codebaseId }
  plugin.request('chat.projects', request).then(
    (answer: ChatProjectsAnswer) => {
      if (mine !== asked || !read(showing)) return
      set(projects, answer.projects)
    },
    (error: unknown) => {
      if (mine !== asked || !read(showing)) return
      const trouble = nextTrouble(null, rejectionOf(error))
      set(projects, { kind: 'failed', message: trouble === null ? 'Orchon could not read the projects.' : troubleText(trouble) })
    }
  )
}

/** Opens a new chat in the panel's project, or with none chosen under "All projects". */
export function openNewChat(projectId: string | undefined): void {
  set(showing, true)
  set(scoped, projectId ?? null)
  set(projects, null)
  set(picked, null)
  set(maybeCreated, false)
  readProjects()
}

/** The project scope changed while the new chat shows: it follows it. */
export function rescopeNewChat(projectId: string | undefined): void {
  if (!read(showing) || (projectId ?? null) === read(scoped)) return
  openNewChat(projectId)
}

export function closeNewChat(): void {
  asked += 1
  set(showing, false)
  set(projects, null)
  set(picked, null)
  set(maybeCreated, false)
}

function projectLines(project: ChatProject): OrcaNode {
  return (
    <Stack gap="none">
      <Text muted size="sm">
        {project.name}
      </Text>
      <Text muted size="sm">
        {project.defaultCwd}
      </Text>
    </Stack>
  )
}

/** The project part of the header, and the project the first send would create the chat in. */
function projectPart(view: Extract<ChatProjectsView, { kind: 'ready' }>): { node: OrcaNode; codebaseId: string | null } {
  const scopedId = read(scoped)
  if (scopedId !== null) {
    if (view.chosen === null) return { node: <Text size="sm">{NOT_LISTED_LINE}</Text>, codebaseId: null }
    return { node: projectLines(view.chosen), codebaseId: view.chosen.id }
  }
  const choice = read(picked)
  const chosen = view.projects.find((project) => project.id === choice) ?? null
  return {
    node: (
      <Stack gap="xs">
        <Select
          label="Project"
          placeholder="Choose a project"
          options={view.projects.map((project) => ({ value: project.id, label: project.name }))}
          {...(chosen === null ? {} : { value: chosen.id })}
          onChange={(value) => set(picked, value)}
        />
        {view.more > 0 ? (
          <Text muted size="sm">
            {`${plural(view.more, 'more project is', 'more projects are')} not listed here. Open a workspace of that project to chat in it.`}
          </Text>
        ) : null}
        {view.unreadable > 0 ? (
          <Text muted size="sm">
            {plural(view.unreadable, 'project could not be read and is not listed.', 'projects could not be read and are not listed.')}
          </Text>
        ) : null}
        {chosen === null ? null : projectLines(chosen)}
      </Stack>
    ),
    codebaseId: chosen?.id ?? null
  }
}

/** The new chat in place of the list. `writable` is false when its controls that write are off. */
export function newChatSection(writable: boolean, hooks: NewChatHooks): OrcaNode {
  const view = read(projects)
  const back = (): void => {
    closeNewChat()
    hooks.back()
  }
  const composerHooks: ComposerHooks = {
    keep: hooks.keep,
    sent(conversationId) {
      closeNewChat()
      hooks.opened(conversationId)
    },
    // A first send in doubt: there is no thread to read, so the person is told to look in the list.
    refetch: () => set(maybeCreated, true)
  }
  let body: OrcaNode
  if (view === null) body = <Spinner label="Loading projects…" />
  else if (view.kind === 'not-connected') body = null
  else if (view.kind === 'failed') {
    body = (
      <Stack gap="xs">
        <Text>{view.message}</Text>
        <Row>
          <Button size="sm" variant="outline" onPress={readProjects}>
            Try again
          </Button>
        </Row>
      </Stack>
    )
  } else {
    const part = projectPart(view)
    const draftKey = `new:${read(scoped) ?? 'all'}`
    body = (
      <Stack gap="sm">
        {part.node}
        {composer({ kind: 'new', draftKey, codebaseId: part.codebaseId }, { writable, hooks: composerHooks })}
        {read(maybeCreated) ? (
          <Text size="sm" tone="warning">
            {MAYBE_CREATED_LINE}
          </Text>
        ) : null}
        <EmptyState title="Archon chat" description={ABOUT_ARCHON_CHAT} />
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" wrap>
        <Button size="sm" variant="ghost" tooltip="Back to the conversations" onPress={back}>
          Chats
        </Button>
      </Row>
      <Heading level={3}>New chat</Heading>
      {body}
    </Stack>
  )
}
