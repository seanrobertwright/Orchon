// PROTOTYPE: throwaway UI exploring the Orchon Chat list and thread layouts.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  List,
  ListItem,
  Markdown,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  Textarea,
  type PanelContext,
} from 'orca'
import {
  CONVERSATIONS,
  makeFiftyConversations,
  PROJECTS,
  splitMarkdownBlocks,
  THREAD_MESSAGES,
  type ProtoConversation,
  type ProtoMessage,
} from './fixtures'
import './protocol'

type Variant = 'A' | 'B'
type ViewMode = 'list' | 'thread'
type ScopeMode = 'project' | 'all'
type Scenario = 'normal' | 'fifty' | 'tools' | 'long' | 'empty' | 'delete' | 'cap500'

const variantAtom = atom<Variant>('proto.variant', 'A', { persist: 'plugin' })
const viewAtom = atom<ViewMode>('proto.view', 'list', { persist: 'plugin' })
const activeConvIdAtom = atom<string>('proto.convId', 'conv-busy', { persist: 'plugin' })
const scopeAtom = atom<ScopeMode>('proto.scope', 'all', { persist: 'plugin' })
const scenarioAtom = atom<Scenario>('proto.scenario', 'normal', { persist: 'plugin' })

// Set non-null temporarily when capturing live screenshots while Orca's window is open.
const SHOT_OVERRIDE: {
  view?: ViewMode
  variant?: Variant
  scenario?: Scenario
} | null = null

const showToolsAtom = atom<boolean>(false)
const confirmDeleteAtom = atom<boolean>(false)
const earlierCountAtom = atom<number>(50)
const draftAtom = atom<string>('')
const extraMessagesAtom = atom<ProtoMessage[]>([])
const pollEnabledAtom = atom<boolean>(false)
const tickCountAtom = atom<number>(0)
const lastEventAtom = atom<string>('Ready')

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('chat.tick', ({ tick }) => {
      set(tickCountAtom, tick)
      set(lastEventAtom, `Refetch tick #${tick} at ${new Date().toLocaleTimeString()}`)
    }),
  )
}

function SectionBar() {
  return (
    <Tabs label="Orchon sections" value="chat" onChange={(v) => set(lastEventAtom, `Switched tab: ${v}`)}>
      <Tab value="runs" label="Runs" />
      <Tab value="launch" label="Launch" />
      <Tab value="chat" label="Chat" />
      <Tab value="metrics" label="Metrics" />
      <Tab value="settings" label="Settings" />
    </Tabs>
  )
}

function PrototypeBar() {
  const variant = read(variantAtom)
  const view = read(viewAtom)
  const scenario = read(scenarioAtom)
  const pollEnabled = read(pollEnabledAtom)
  const tickCount = read(tickCountAtom)
  const lastEvent = read(lastEventAtom)

  async function togglePoll(next: boolean): Promise<void> {
    set(pollEnabledAtom, next)
    await plugin.request('chat.togglePoll', { enabled: next })
  }

  function addFakeReply(): void {
    const idx = read(extraMessagesAtom).length + 1
    set(extraMessagesAtom, [
      ...read(extraMessagesAtom),
      {
        id: `extra-${idx}`,
        kind: 'assistant',
        createdAt: Date.now(),
        content: `Simulated reply #${idx}: checking whether adding a message keeps the newest message in view.`,
      },
    ])
    set(lastEventAtom, `Added simulated reply #${idx}`)
  }

  return (
    <Box padding="xs" border background="muted" radius="sm" gap="xs">
      <Row justify="between" align="center" wrap>
        <Text size="xs" weight="semibold" muted>
          PROTOTYPE ({view === 'list' ? 'List' : `Thread · Variant ${variant}`})
        </Text>
        <Row gap="xs" wrap>
          <Button
            size="xs"
            variant={variant === 'A' ? 'solid' : 'outline'}
            onPress={() => set(variantAtom, 'A')}
          >
            A: Bottom
          </Button>
          <Button
            size="xs"
            variant={variant === 'B' ? 'solid' : 'outline'}
            onPress={() => set(variantAtom, 'B')}
          >
            B: Top
          </Button>
          <Button
            size="xs"
            variant="outline"
            onPress={() => set(viewAtom, view === 'list' ? 'thread' : 'list')}
          >
            {view === 'list' ? 'Open thread' : 'Show list'}
          </Button>
          {view === 'thread' && (
            <Button size="xs" variant="outline" onPress={addFakeReply}>
              + Reply
            </Button>
          )}
        </Row>
      </Row>
      <Row justify="between" align="center" wrap>
        <Switch label="3s refetch" checked={pollEnabled} onChange={togglePoll} />
        <Text size="xs" muted>
          ticks: {tickCount} · scenario: {scenario}
        </Text>
      </Row>
      <Text size="xs" muted truncate>
        {lastEvent}
      </Text>
    </Box>
  )
}

function ChatListView({
  conversations,
  isFiftyCap,
}: {
  conversations: ProtoConversation[]
  isFiftyCap: boolean
}) {
  const scope = read(scopeAtom)
  const currentProject = PROJECTS[0]
  const visible =
    scope === 'project'
      ? conversations.filter((c) => c.codebaseId === currentProject.id)
      : conversations

  function openConv(conv: ProtoConversation): void {
    set(activeConvIdAtom, conv.id)
    set(viewAtom, 'thread')
    set(confirmDeleteAtom, false)
    set(extraMessagesAtom, [])
    set(lastEventAtom, `Opened ${conv.title ?? 'Untitled'}`)
  }

  function startNewChat(): void {
    set(activeConvIdAtom, 'conv-empty')
    set(viewAtom, 'thread')
    set(confirmDeleteAtom, false)
    set(extraMessagesAtom, [])
    set(lastEventAtom, 'Started new chat')
  }

  return (
    <Stack gap="sm">
      <RadioGroup
        label="Project scope"
        labelHidden
        orientation="horizontal"
        value={scope}
        onChange={(v) => set(scopeAtom, v as ScopeMode)}
        options={[
          { value: 'project', label: 'This project', description: currentProject.name },
          { value: 'all', label: 'All projects' },
        ]}
      />

      <Row justify="between" align="center" wrap>
        <Heading level={3}>Conversations</Heading>
        <Button size="sm" icon="add" onPress={startNewChat}>
          New chat
        </Button>
      </Row>

      {isFiftyCap && (
        <Callout tone="neutral">
          Showing the 50 most recent conversations. Narrow by project or open Archon’s console for older threads.
        </Callout>
      )}

      {visible.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description={`Start a new chat with Archon’s agent for ${currentProject.name}.`}
          icon="bot"
        />
      ) : (
        <List label="Chat conversations">
          {visible.map((conv) => (
            <ListItem
              key={conv.id}
              title={conv.title ?? 'Untitled'}
              icon={conv.busy ? 'activity' : 'bot'}
              onPress={() => openConv(conv)}
            >
              <Row gap="xs" align="center" wrap>
                {conv.busy && <Badge tone="accent">Working</Badge>}
                {scope === 'all' && (
                  <Text size="xs" muted>
                    {conv.projectName}
                  </Text>
                )}
                <Text size="xs" muted>
                  <RelativeTime at={conv.lastActivityAt} format="short" />
                </Text>
              </Row>
            </ListItem>
          ))}
        </List>
      )}
    </Stack>
  )
}

function MessageView({
  msg,
  showTools,
}: {
  msg: ProtoMessage
  showTools: boolean
}) {
  if (msg.kind === 'tool_call') {
    if (!showTools) return null
    return (
      <Collapsible title={`Tool: ${msg.toolName ?? 'unknown'}`} description="Completed">
        <Stack gap="xs">
          {msg.toolInput && <CodeView code={msg.toolInput} language="json" label="Input" maxHeight="sm" />}
          {msg.toolOutput && <CodeView code={msg.toolOutput} label="Output" maxHeight="sm" />}
        </Stack>
      </Collapsible>
    )
  }

  if (msg.kind === 'error') {
    return (
      <Callout tone="danger" title="Agent error">
        {msg.content}
      </Callout>
    )
  }

  if (msg.kind === 'workflow_dispatch') {
    return (
      <Box padding="sm" border radius="sm" background="card" gap="xs">
        <Row justify="between" align="center" wrap>
          <Row gap="xs" align="center">
            <Badge tone="accent">Started workflow</Badge>
            <Text size="sm" weight="medium">
              {msg.workflowName}
            </Text>
          </Row>
          {msg.runCreated ? (
            <Button
              size="xs"
              variant="outline"
              onPress={() => set(lastEventAtom, `Open run ${msg.runId}`)}
            >
              Open run
            </Button>
          ) : (
            <Text size="xs" muted>
              Run has not been created yet
            </Text>
          )}
        </Row>
      </Box>
    )
  }

  if (msg.kind === 'workflow_result') {
    return (
      <Card title={`Workflow finished: ${msg.workflowName}`} description={msg.summary}>
        <Row justify="between" align="center">
          <Badge tone="success">Completed</Badge>
          <Button
            size="xs"
            variant="outline"
            onPress={() => set(lastEventAtom, `Open run ${msg.runId}`)}
          >
            Open run
          </Button>
        </Row>
      </Card>
    )
  }

  const isUser = msg.kind === 'user'
  const blocks = splitMarkdownBlocks(msg.content)

  return (
    <Box
      padding="sm"
      border
      radius="md"
      background={isUser ? 'muted' : 'card'}
      gap="xs"
    >
      <Row justify="between" align="center">
        <Text size="xs" weight="semibold" tone={isUser ? 'accent' : 'neutral'}>
          {isUser ? 'You' : 'Archon'}
        </Text>
        <Text size="xs" muted>
          <RelativeTime at={msg.createdAt} format="short" />
        </Text>
      </Row>
      {blocks.map((block, idx) => (
        <Markdown key={`${msg.id}-b-${idx}`} content={block} />
      ))}
      {msg.files && msg.files.length > 0 && (
        <Row gap="xs" wrap>
          <Text size="xs" muted>
            Attached:
          </Text>
          {msg.files.map((f) => (
            <Code key={f}>{f}</Code>
          ))}
        </Row>
      )}
      {msg.truncatedBytes && msg.truncatedBytes > 0 && (
        <Text size="xs" muted>
          Truncated: {Math.round(msg.truncatedBytes / 1024)} KiB not shown (64 KiB cap). Open Archon’s console to read the rest.
        </Text>
      )}
    </Box>
  )
}

function WorkingLine({ busy, tool }: { busy: boolean; tool?: string }) {
  if (!busy) return null
  return (
    <Row gap="xs" align="center">
      <Spinner label="Agent working" labelHidden />
      <Text size="xs" muted>
        {tool ? `Working · using ${tool}…` : 'Working…'}
      </Text>
    </Row>
  )
}

function Composer({
  draft,
  busy,
  onSend,
}: {
  draft: string
  busy: boolean
  onSend: (text: string) => void
}) {
  return (
    <Stack gap="xs">
      <Textarea
        label="Message Archon"
        labelHidden
        rows={2}
        placeholder="Ask Archon’s agent or start a workflow… (Ctrl+Enter to send)"
        value={draft}
        onChange={(v) => set(draftAtom, v)}
        onSubmit={(v) => onSend(v)}
      />
      <Row justify="between" align="center">
        <Text size="xs" muted>
          {busy ? 'Turn in flight' : 'Enter adds a line · Ctrl+Enter sends'}
        </Text>
        <Button size="sm" onPress={() => onSend(draft)} disabled={!draft.trim()}>
          Send
        </Button>
      </Row>
    </Stack>
  )
}

function ChatThreadView({
  conv,
  messages,
  variant,
  showTools,
  confirmDelete,
  atCap500,
}: {
  conv: ProtoConversation
  messages: ProtoMessage[]
  variant: Variant
  showTools: boolean
  confirmDelete: boolean
  atCap500: boolean
}) {
  const draft = read(draftAtom)

  function handleSend(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    set(extraMessagesAtom, [
      ...read(extraMessagesAtom),
      {
        id: `sent-${Date.now()}`,
        kind: 'user',
        createdAt: Date.now(),
        content: trimmed,
      },
    ])
    set(draftAtom, '')
    set(lastEventAtom, `Sent message (${trimmed.length} chars)`)
  }

  const ordered = variant === 'A' ? messages : [...messages].reverse()

  const emptyNode = (
    <EmptyState
      title={`Chat with Archon (${conv.projectName})`}
      description={`Talks to Archon’s agent about ${conv.projectName}, can start workflows, and works in ${conv.defaultCwd} — not in your Orca workspace terminal.`}
      icon="bot"
    />
  )

  const earlierNode = atCap500 ? (
    <Text size="xs" muted>
      Showing the newest 500 messages. Older messages cannot be fetched from Archon.
    </Text>
  ) : (
    messages.length > 0 && (
      <Button
        size="xs"
        variant="ghost"
        onPress={() => {
          set(earlierCountAtom, Math.min(500, read(earlierCountAtom) + 50))
          set(lastEventAtom, `Loaded earlier (limit ${read(earlierCountAtom)})`)
        }}
      >
        Show earlier
      </Button>
    )
  )

  return (
    <Stack gap="sm">
      {/* Header */}
      <Row justify="between" align="center" wrap>
        <Button size="xs" variant="ghost" onPress={() => set(viewAtom, 'list')}>
          ← Back to chats
        </Button>
        <Row gap="xs" align="center">
          <Switch
            label="Show tool calls"
            checked={showTools}
            onChange={(v) => set(showToolsAtom, v)}
          />
          {!confirmDelete && (
            <Button
              size="xs"
              variant="ghost"
              tone="danger"
              disabled={conv.busy}
              onPress={() => set(confirmDeleteAtom, true)}
            >
              Delete
            </Button>
          )}
        </Row>
      </Row>

      <Stack gap="none">
        <Heading level={3}>{conv.title ?? 'Untitled'}</Heading>
        <Text size="xs" muted truncate>
          {conv.projectName} · {conv.defaultCwd}
        </Text>
      </Stack>

      {confirmDelete && (
        <Callout tone="danger" title="Delete this conversation?">
          <Stack gap="xs">
            <Text size="xs">This removes the conversation from Archon and cannot be undone.</Text>
            <Row gap="xs">
              <Button
                size="xs"
                tone="danger"
                onPress={() => {
                  set(confirmDeleteAtom, false)
                  set(viewAtom, 'list')
                  set(lastEventAtom, `Deleted ${conv.title ?? 'Untitled'}`)
                }}
              >
                Confirm delete
              </Button>
              <Button size="xs" variant="ghost" onPress={() => set(confirmDeleteAtom, false)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      )}

      <Separator />

      {variant === 'A' ? (
        <>
          <Box scroll="y" height={320} gap="sm" padding="xs" border radius="sm">
            {earlierNode}
            {ordered.length === 0
              ? emptyNode
              : ordered.map((m) => <MessageView key={m.id} msg={m} showTools={showTools} />)}
            <WorkingLine busy={conv.busy} tool={conv.workingTool} />
          </Box>
          <Composer draft={draft} busy={conv.busy} onSend={handleSend} />
        </>
      ) : (
        <>
          <Composer draft={draft} busy={conv.busy} onSend={handleSend} />
          <WorkingLine busy={conv.busy} tool={conv.workingTool} />
          <Stack gap="sm">
            {ordered.length === 0
              ? emptyNode
              : ordered.map((m) => <MessageView key={m.id} msg={m} showTools={showTools} />)}
            {earlierNode}
          </Stack>
        </>
      )}
    </Stack>
  )
}

export default function Panel() {
  const variant = SHOT_OVERRIDE?.variant ?? read(variantAtom)
  const view = SHOT_OVERRIDE?.view ?? read(viewAtom)
  const convId = read(activeConvIdAtom)
  const scenario = SHOT_OVERRIDE?.scenario ?? read(scenarioAtom)
  const showTools = read(showToolsAtom) || scenario === 'tools'
  const confirmDelete = read(confirmDeleteAtom) || scenario === 'delete'
  const extra = read(extraMessagesAtom)

  const isFiftyCap = scenario === 'fifty'
  const conversations = isFiftyCap ? makeFiftyConversations() : CONVERSATIONS

  const effectiveConvId =
    scenario === 'long' ? 'conv-long' : scenario === 'empty' ? 'conv-empty' : convId
  const conv = conversations.find((c) => c.id === effectiveConvId) ?? conversations[0]
  const baseMessages = THREAD_MESSAGES[conv.id] ?? []
  const messages = [...baseMessages, ...extra]

  return (
    <Stack gap="md">
      <SectionBar />
      {view === 'list' ? (
        <ChatListView conversations={conversations} isFiftyCap={isFiftyCap} />
      ) : (
        <ChatThreadView
          conv={conv}
          messages={messages}
          variant={variant}
          showTools={showTools}
          confirmDelete={confirmDelete}
          atCap500={scenario === 'cap500'}
        />
      )}
      <Separator />
      <PrototypeBar />
    </Stack>
  )
}
