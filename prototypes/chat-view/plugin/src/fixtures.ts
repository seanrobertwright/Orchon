// PROTOTYPE: throwaway fixture data for the Orchon chat view prototype.

export interface ProtoProject {
  id: string
  name: string
  defaultCwd: string
}

export interface ProtoConversation {
  id: string
  title: string | null
  codebaseId: string
  projectName: string
  defaultCwd: string
  lastActivityAt: number
  busy: boolean
  workingTool?: string
}

export type ProtoMessageKind =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'workflow_dispatch'
  | 'workflow_result'
  | 'error'

export interface ProtoMessage {
  id: string
  kind: ProtoMessageKind
  createdAt: number
  content: string
  files?: string[]
  toolName?: string
  toolInput?: string
  toolOutput?: string
  workflowName?: string
  workerPlatformId?: string
  runId?: string
  runCreated?: boolean
  summary?: string
  truncatedBytes?: number
}

export const PROJECTS: ProtoProject[] = [
  { id: 'proj-orchon', name: 'Orchon', defaultCwd: 'E:\\Projects\\Orchon' },
  { id: 'proj-archon', name: 'Archon', defaultCwd: 'E:\\Projects\\Archon' },
]

const now = Date.now()
const min = 60_000
const hr = 60 * min

export const CONVERSATIONS: ProtoConversation[] = [
  {
    id: 'conv-busy',
    title: 'Fix SSE reconnect backoff in worker',
    codebaseId: 'proj-orchon',
    projectName: 'Orchon',
    defaultCwd: 'E:\\Projects\\Orchon',
    lastActivityAt: now - 15_000,
    busy: true,
    workingTool: 'bash',
  },
  {
    id: 'conv-untitled',
    title: null,
    codebaseId: 'proj-archon',
    projectName: 'Archon',
    defaultCwd: 'E:\\Projects\\Archon',
    lastActivityAt: now - 12 * min,
    busy: false,
  },
  {
    id: 'conv-long',
    title: 'Audit chat message cap and splitting',
    codebaseId: 'proj-orchon',
    projectName: 'Orchon',
    defaultCwd: 'E:\\Projects\\Orchon',
    lastActivityAt: now - 2 * hr,
    busy: false,
  },
  {
    id: 'conv-empty',
    title: 'New chat',
    codebaseId: 'proj-orchon',
    projectName: 'Orchon',
    defaultCwd: 'E:\\Projects\\Orchon',
    lastActivityAt: now - 3 * hr,
    busy: false,
  },
]

export function makeFiftyConversations(): ProtoConversation[] {
  const rows: ProtoConversation[] = [...CONVERSATIONS]
  for (let i = rows.length + 1; i <= 50; i++) {
    const isArchon = i % 3 === 0
    rows.push({
      id: `conv-${i}`,
      title: i % 7 === 0 ? null : `Investigate workflow run #${100 + i} and retry policy`,
      codebaseId: isArchon ? 'proj-archon' : 'proj-orchon',
      projectName: isArchon ? 'Archon' : 'Orchon',
      defaultCwd: isArchon ? 'E:\\Projects\\Archon' : 'E:\\Projects\\Orchon',
      lastActivityAt: now - i * 25 * min,
      busy: false,
    })
  }
  return rows
}

// Build a >16 KiB markdown message to test paragraph-break splitting in Orca's Markdown component.
function makeLongMarkdown(): string {
  const para =
    'This paragraph checks how Orca renders a long assistant reply that exceeds the 16 KiB per-text cap and must be split at paragraph breaks into consecutive Markdown blocks. It includes `inlineCode()`, **bold emphasis**, and a [reference link](https://archon.diy) so we can see whether any vertical gap or border shows at the join.\n\n'
  let out = '### Long reply (>16 KiB, split into blocks)\n\n'
  let i = 1
  while (out.length < 18_500) {
    out += `**Block section ${i}.** ${para}`
    i++
  }
  return out
}

export const LONG_MARKDOWN_TEXT = makeLongMarkdown()

export function splitMarkdownBlocks(text: string, maxBytes = 16_000): string[] {
  if (text.length <= maxBytes) return [text]
  const blocks: string[] = []
  let current = ''
  for (const para of text.split(/\n\n+/)) {
    const candidate = current ? `${current}\n\n${para}` : para
    if (candidate.length > maxBytes && current) {
      blocks.push(current)
      current = para
    } else {
      current = candidate
    }
  }
  if (current) blocks.push(current)
  return blocks
}

export const THREAD_MESSAGES: Record<string, ProtoMessage[]> = {
  'conv-busy': [
    {
      id: 'm-1',
      kind: 'user',
      createdAt: now - 8 * min,
      content: 'Can you check why the SSE stream drops after 30s and kick off `sdlc-fix-issue` if needed?',
      files: ['src/worker/sse.ts', 'package.json'],
    },
    {
      id: 'm-2',
      kind: 'tool_call',
      createdAt: now - 7 * min,
      content: '',
      toolName: 'read_file',
      toolInput: '{"path": "src/worker/sse.ts"}',
      toolOutput: 'export function connectStream(url: string) {\n  // reconnects with 1s, 2s, 4s...\n}',
    },
    {
      id: 'm-3',
      kind: 'assistant',
      createdAt: now - 6 * min,
      content:
        'I checked `src/worker/sse.ts`. The heartbeat timeout is `30_000` ms, which matches Archon’s idle ping interval, so a slight jitter triggers a reconnect.\n\n- Increase heartbeat timeout to `45_000` ms\n- Keep exponential backoff capped at `30_000` ms',
    },
    {
      id: 'm-4',
      kind: 'workflow_dispatch',
      createdAt: now - 5 * min,
      content: '',
      workflowName: 'sdlc-fix-issue',
      workerPlatformId: 'worker-run-42',
      runId: 'run-42',
      runCreated: true,
    },
    {
      id: 'm-5',
      kind: 'workflow_dispatch',
      createdAt: now - 4 * min,
      content: '',
      workflowName: 'sdlc-verify',
      workerPlatformId: 'worker-pending',
      runCreated: false,
    },
    {
      id: 'm-6',
      kind: 'workflow_result',
      createdAt: now - 3 * min,
      content: '',
      workflowName: 'sdlc-fix-issue',
      runId: 'run-42',
      summary: 'Updated heartbeat timeout to 45s in `src/worker/sse.ts` and all 14 unit tests passed.',
    },
    {
      id: 'm-7',
      kind: 'error',
      createdAt: now - 2 * min,
      content: 'Tool `bash` timed out after 30s while running `pnpm test:integration`.',
    },
    {
      id: 'm-8',
      kind: 'user',
      createdAt: now - 45_000,
      content: 'Re-run the unit suite only and report back.',
    },
    {
      id: 'm-9',
      kind: 'tool_call',
      createdAt: now - 20_000,
      content: '',
      toolName: 'bash',
      toolInput: '{"command": "pnpm test:unit"}',
      toolOutput: 'Running 14 tests...',
    },
  ],
  'conv-untitled': [
    {
      id: 'u-1',
      kind: 'user',
      createdAt: now - 15 * min,
      content: 'Where does `listConversations` cap the result count?',
    },
    {
      id: 'u-2',
      kind: 'assistant',
      createdAt: now - 12 * min,
      content: 'In `packages/core/src/db/conversations.ts`, `listConversations` defaults `limit` to `50` ordered by `last_activity_at DESC`.',
    },
  ],
  'conv-long': [
    {
      id: 'l-1',
      kind: 'user',
      createdAt: now - 2 * hr,
      content: 'Show me a >16 KiB reply and a >64 KiB truncated reply.',
    },
    {
      id: 'l-2',
      kind: 'assistant',
      createdAt: now - 2 * hr + 10_000,
      content: LONG_MARKDOWN_TEXT,
      truncatedBytes: 12_400,
    },
  ],
  'conv-empty': [],
}
