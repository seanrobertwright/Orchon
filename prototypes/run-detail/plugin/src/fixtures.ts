// PROTOTYPE. One made-up run of a 16-step workflow, stopped at four different points, with the
// sizes measured on a real install: about 330 activity items in the busiest step, 13 artifact
// files in a typical run and 8,905 in the largest, a 69 KB Markdown artifact.
import type {
  ActivityPage,
  ArtifactBody,
  ArtifactList,
  ArtifactRow,
  ItemKind,
  ItemPreview,
  ItemRow,
  RunDetail,
  Scenario,
  Split,
  StepRow,
  StepState,
  StepView
} from './protocol'

const NOW = Date.now()
const SEC = 1000
const MIN = 60 * SEC
/** Under Orca's 16 KiB limit for one text, with room for a fence the splitter re-opens. */
const BLOCK = 16_000
const OUTPUT_CAP = 256 * 1024
const FILE_CAP = 256 * 1024
const PAGE = 50

function rng(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(text: string): number {
  let value = 7
  for (const char of text) value = (Math.imul(value, 31) + char.charCodeAt(0)) | 0
  return value
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T
}

// ---------------------------------------------------------------------------------- steps

type Plan = { id: string; kind: string; secs: number; items: number; ran?: number }

const PLAN: Plan[] = [
  { id: 'fetch-issue', kind: 'bash', secs: 4, items: 0 },
  { id: 'classify', kind: 'prompt', secs: 38, items: 9 },
  { id: 'investigate', kind: 'prompt', secs: 412, items: 142 },
  { id: 'plan', kind: 'prompt', secs: 265, items: 61 },
  { id: 'approve-plan', kind: 'approval', secs: 95, items: 0 },
  { id: 'implement', kind: 'loop', secs: 1870, items: 0, ran: 3 },
  { id: 'implement.build', kind: 'prompt', secs: 1120, items: 330, ran: 3 },
  { id: 'implement.test', kind: 'bash', secs: 310, items: 0, ran: 3 },
  { id: 'implement.review', kind: 'prompt', secs: 440, items: 88, ran: 3 },
  { id: 'lint', kind: 'bash', secs: 21, items: 0 },
  { id: 'typecheck', kind: 'bash', secs: 47, items: 0 },
  { id: 'unit-tests', kind: 'bash', secs: 133, items: 0 },
  { id: 'e2e-tests', kind: 'prompt', secs: 0, items: 0 },
  { id: 'security-review', kind: 'prompt', secs: 201, items: 47 },
  { id: 'update-docs', kind: 'prompt', secs: 118, items: 26 },
  { id: 'confirm-scope', kind: 'wait', secs: 0, items: 0 },
  { id: 'commit', kind: 'bash', secs: 6, items: 0 },
  { id: 'open-pr', kind: 'prompt', secs: 74, items: 18 },
  { id: 'summary', kind: 'prompt', secs: 52, items: 7 }
]

/** The step each scenario stopped at, and the state that step is in. */
const STOP: Record<Scenario, { at: string | null; state: StepState }> = {
  paused: { at: 'confirm-scope', state: 'paused' },
  running: { at: 'implement', state: 'running' },
  failed: { at: 'unit-tests', state: 'failed' },
  completed: { at: null, state: 'completed' }
}

function topLevel(id: string): string {
  return id.split('.')[0] as string
}

function buildSteps(scenario: Scenario): { steps: StepRow[]; startedAt: number; endedAt: number | null } {
  const stop = STOP[scenario]
  const order = PLAN.filter((plan) => !plan.id.includes('.')).map((plan) => plan.id)
  const stopIndex = stop.at === null ? order.length : order.indexOf(stop.at)

  let elapsed = 0
  for (const [index, id] of order.entries()) {
    if (index <= stopIndex) elapsed += (PLAN.find((plan) => plan.id === id) as Plan).secs * SEC
  }
  // A paused run has been waiting 12 minutes; a finished one ended 3 hours ago.
  const idle = scenario === 'paused' ? 12 * MIN : scenario === 'running' ? 0 : 3 * 60 * MIN
  const startedAt = NOW - elapsed - idle

  const steps: StepRow[] = []
  let cursor = startedAt
  for (const plan of PLAN) {
    const top = topLevel(plan.id)
    const index = order.indexOf(top)
    const inner = plan.id.includes('.')
    let state: StepState = index < stopIndex ? 'completed' : index === stopIndex ? stop.state : 'pending'
    if (plan.id === 'e2e-tests' && state === 'completed') state = 'skipped'
    if (inner && state === 'running') state = plan.id === 'implement.review' ? 'running' : 'completed'

    const reached = state !== 'pending' && state !== 'skipped'
    const loop = inner ? (steps.find((step) => step.id === top) as StepRow) : null
    const begin = inner
      ? (loop?.startedAt ?? cursor) + (plan.id.endsWith('build') ? 0 : plan.id.endsWith('test') ? 1120 : 1430) * SEC
      : cursor
    const done = state === 'completed' || state === 'failed'
    steps.push({
      id: plan.id,
      name: inner ? (plan.id.split('.')[1] as string) : plan.id,
      parent: inner ? top : null,
      kind: plan.kind,
      state,
      startedAt: reached ? begin : null,
      endedAt: done ? begin + plan.secs * SEC : null,
      ran: reached ? (plan.ran ?? 1) : 0
    })
    if (!inner && reached) cursor += plan.secs * SEC
  }
  const ended = scenario === 'completed' || scenario === 'failed' ? cursor : null
  return { steps, startedAt, endedAt: ended }
}

const MESSAGE =
  'Fix issue #412: the setup wizard marks setup complete before the admin account is written, so a ' +
  'crash between the two leaves an install that skips the wizard and has no admin. Make the two ' +
  'writes one transaction, add a regression test that kills the process between them, and update ' +
  'the setup docs. Do not change the public shape of declareSetupComplete. '

export function getRun(scenario: Scenario): RunDetail {
  const { steps, startedAt, endedAt } = buildSteps(scenario)
  const long = scenario === 'completed'
  return {
    scenario,
    id: { paused: '7c2e91ab', running: 'b40f33d1', failed: '19ad07c4', completed: 'e5518f02' }[scenario] + '-4f6a-4b1e-9d0c-2a7f5e1c8b90',
    workflow: 'archon-fix-github-issue',
    project: 'acme/storefront',
    status: scenario,
    attention:
      scenario === 'paused'
        ? {
            question:
              'The fix touches `packages/core/src/dal/setup.ts` and **also** the migration runner, which the issue did not mention.\n\nKeep the migration change in this pull request?',
            options: ['Keep it in this pull request', 'Split it into a second pull request', 'Drop the migration change']
          }
        : null,
    startedAt,
    endedAt,
    costUsd: { paused: 3.18, running: 1.42, failed: 2.07, completed: 3.61 }[scenario],
    // The completed run carries a launch message past the 2,000 character cut.
    message: long ? MESSAGE.repeat(6).slice(0, 2000) : MESSAGE.trim(),
    messageCut: long,
    worktree: 'C:/Users/dev/.archon/workspaces/acme/storefront/worktrees/archon/task-fix-issue-412',
    hasConversation: scenario !== 'failed',
    steps
  }
}

// ---------------------------------------------------------------------------------- text

const FILES = [
  'packages/core/src/dal/setup.ts',
  'packages/core/src/dal/setup.test.ts',
  'packages/core/src/db/migrate.ts',
  'packages/core/src/db/transaction.ts',
  'packages/server/src/routes/setup.ts',
  'packages/server/src/routes/setup.test.ts',
  'packages/web/src/routes/SetupWizard.tsx',
  'docs/setup.md',
  'docs/adr/0014-setup-transaction.md',
  'packages/core/src/config/config-loader.ts'
]

const SENTENCES = [
  'The wizard writes the admin row first and the completion flag second, in two separate statements.',
  'A crash between them leaves the flag unset, which is the safe direction, but the reverse order is what the route does.',
  'declareSetupComplete is called from three places, and only one of them holds a transaction.',
  'The migration runner opens its own connection, so it cannot join the caller\u2019s transaction as written.',
  'I will pass the transaction handle down instead of opening a second connection.',
  'The regression test needs a seam to stop the process between the two writes.',
  'The existing tests pass a fake clock, so the new test can reuse that harness.',
  'The public shape of declareSetupComplete stays the same: the new parameter is optional.',
  'Two call sites in the server package still use the old helper and need the same change.',
  'The docs describe the old order and have to be corrected in the same change.'
]

function prose(random: () => number, sentences: number): string {
  const out: string[] = []
  for (let index = 0; index < sentences; index++) out.push(pick(random, SENTENCES))
  return out.join(' ')
}

/** Hard-wraps prose at about 92 columns, the way an agent writes a Markdown file. */
function wrap(text: string): string {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > 92) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

function cut(text: string, limit: number): { text: string; cut: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), cut: true } : { text, cut: false }
}

// ---------------------------------------------------------------------------------- activity

type Item = ItemRow & { seed: number; tool: string | null }

const TOOLS = ['Read', 'Read', 'Grep', 'Edit', 'Edit', 'Bash', 'Bash', 'Write', 'TodoWrite'] as const
const COMMANDS = ['pnpm test --filter core', 'pnpm typecheck', 'git diff --stat', 'pnpm lint packages/core', 'git status --short']
const PATTERNS = ['declareSetupComplete', 'setup_complete', 'withTransaction\\(', 'adminUser']

function toolTitle(random: () => number, tool: string): string {
  if (tool === 'Bash') return `Bash ${pick(random, COMMANDS)}`
  if (tool === 'Grep') return `Grep "${pick(random, PATTERNS)}"`
  if (tool === 'TodoWrite') return 'TodoWrite 6 items'
  return `${tool} ${pick(random, FILES)}`
}

const cache = new Map<string, Item[]>()

function itemsOf(scenario: Scenario, step: StepRow): Item[] {
  const key = `${scenario}:${step.id}`
  const cached = cache.get(key)
  if (cached) return cached
  const plan = PLAN.find((entry) => entry.id === step.id) as Plan
  const count = step.startedAt === null ? 0 : plan.items
  const random = rng(hash(step.id))
  const begin = step.startedAt ?? NOW
  const span = (step.endedAt ?? NOW) - begin
  const attempts = Math.max(1, step.ran)
  const items: Item[] = []
  for (let index = 0; index < count; index++) {
    const attempt = Math.min(attempts, Math.floor((index * attempts) / count) + 1)
    const firstOfAttempt = index === 0 || attempt !== (items[index - 1] as Item).attempt
    const roll = random()
    let kind: ItemKind =
      firstOfAttempt ? 'thought' : roll < 0.6 ? 'tool' : roll < 0.8 ? 'text' : roll < 0.9 ? 'thought' : roll < 0.95 ? 'subtask' : roll < 0.98 ? 'warning' : 'hook'
    let tool: string | null = kind === 'tool' ? pick(random, TOOLS) : null
    // The newest six items are fixed, so a capture can select each kind by key.
    const fromEnd = count - 1 - index
    if (count >= 20 && fromEnd < 6) {
      kind = (['tool', 'text', 'tool', 'warning', 'hook', 'subtask'] as const)[fromEnd] as ItemKind
      tool = fromEnd === 0 ? 'Bash' : fromEnd === 2 ? 'Edit' : null
    }
    let title: string
    let state = ''
    if (kind === 'tool') {
      title = toolTitle(random, tool as string)
      state = step.state === 'running' && fromEnd === 0 ? 'in progress' : random() < 0.06 ? 'failed' : 'completed'
    } else if (kind === 'text') {
      title = prose(random, 1)
    } else if (kind === 'thought') {
      title = `Thinking: ${prose(random, 1)}`
    } else if (kind === 'subtask') {
      title = `Subtask: explore ${pick(random, FILES)}`
      state = 'completed'
    } else if (kind === 'warning') {
      title = 'Rate limit close: the provider asked for a pause of 8 seconds'
    } else {
      title = 'Hook failed: post-tool-use lint (exit 2)'
      state = 'failed'
    }
    items.push({
      key: `i${index}`,
      kind,
      title,
      state,
      at: begin + Math.floor((span * index) / Math.max(1, count)),
      attempt,
      firstOfAttempt,
      seed: hash(`${step.id}:${index}`),
      tool
    })
  }
  cache.set(key, items)
  return items
}

function findStep(scenario: Scenario, id: string): StepRow {
  const step = buildSteps(scenario).steps.find((entry) => entry.id === id)
  if (!step) throw new Error(`no step ${id}`)
  return step
}

function toRow(item: Item): ItemRow {
  return {
    key: item.key,
    kind: item.kind,
    title: item.title,
    state: item.state,
    at: item.at,
    attempt: item.attempt,
    firstOfAttempt: item.firstOfAttempt
  }
}

export function getActivityPage(scenario: Scenario, stepId: string, before: string | null): ActivityPage {
  const items = itemsOf(scenario, findStep(scenario, stepId))
  const end = before === null ? items.length : Math.max(0, items.findIndex((item) => item.key === before))
  const start = Math.max(0, end - PAGE)
  return { rows: items.slice(start, end).map(toRow), earlier: start }
}

function testLog(random: () => number, bytes: number): string {
  const lines: string[] = ['> core@0.14.0 test', '> vitest run --reporter=verbose', '']
  let size = 0
  let index = 0
  while (size < bytes) {
    const file = pick(random, FILES)
    const line = ` ${random() < 0.97 ? '\u2713' : '\u2717'} ${file} > case ${index++} (${Math.floor(random() * 90)} ms)`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

export function getItem(scenario: Scenario, stepId: string, key: string): ItemPreview {
  const items = itemsOf(scenario, findStep(scenario, stepId))
  const item = items.find((entry) => entry.key === key)
  if (!item) throw new Error(`no item ${key}`)
  const random = rng(item.seed)
  const newest = items.length >= 20 && item === items[items.length - 1]
  const base: ItemPreview = {
    key: item.key,
    kind: item.kind,
    title: item.title,
    state: item.state,
    at: item.at,
    text: null,
    textCut: false,
    input: null,
    inputCut: false,
    output: null,
    outputCut: false,
    archonTruncated: false
  }
  if (item.kind !== 'tool') {
    // One agent text in each busy step is longer than Orca's limit for one text.
    const long = items.length >= 20 && item === items[items.length - 2]
    const paragraphs = long ? 40 : item.kind === 'text' || item.kind === 'thought' ? 1 + Math.floor(random() * 3) : 1
    const body =
      item.kind === 'warning' || item.kind === 'hook'
        ? `${item.title}\n\npackages/core/src/dal/setup.ts\n  41:7  error  'tx' is assigned a value but never used  no-unused-vars`
        : Array.from({ length: paragraphs }, () => prose(random, 5)).join('\n\n')
    const trimmed = cut(body, BLOCK)
    return { ...base, text: trimmed.text, textCut: trimmed.cut }
  }
  const file = pick(random, FILES)
  let input: string
  let output: string
  let archonTruncated = false
  if (item.tool === 'Bash') {
    input = JSON.stringify({ command: item.title.slice(5), timeout: 120000, description: 'Run the package tests' }, null, 2)
    // Archon stores at most 16,384 characters of a tool call's output.
    output = testLog(random, newest ? 16_384 : 600 + Math.floor(random() * 2400)).slice(0, 16_384)
    archonTruncated = newest
  } else if (item.tool === 'Edit') {
    // A tool call's input reached 18 KB on the charting machine; the third newest is that big.
    const big = items.length >= 20 && item === items[items.length - 3]
    const body = Array.from({ length: big ? 150 : 6 }, (_, line) => `  const step${line} = await tx.run(statement${line}) // ${prose(random, 1).slice(0, 60)}`).join('\n')
    input = JSON.stringify({ file_path: file, old_string: body.slice(0, Math.floor(body.length / 2)), new_string: body }, null, 2)
    output = `The file ${file} has been updated.`
  } else if (item.tool === 'Grep') {
    input = JSON.stringify({ pattern: item.title.slice(6, -1), output_mode: 'content', '-n': true }, null, 2)
    output = FILES.slice(0, 6).map((entry, line) => `${entry}:${12 + line * 7}:  await declareSetupComplete(db)`).join('\n')
  } else if (item.tool === 'TodoWrite') {
    input = JSON.stringify({ todos: SENTENCES.slice(0, 6).map((content, line) => ({ content, status: line < 2 ? 'completed' : 'pending' })) }, null, 2)
    output = 'Todos have been modified successfully.'
  } else {
    input = JSON.stringify({ file_path: file }, null, 2)
    output = Array.from({ length: 40 }, (_, line) => `${String(line + 1).padStart(4)}  ${line % 9 === 0 ? 'export async function' : '  const value ='} line${line}()`).join('\n')
  }
  const inputCut = cut(input, BLOCK)
  const outputCut = cut(output, BLOCK)
  return {
    ...base,
    input: inputCut.text,
    inputCut: inputCut.cut,
    output: item.state === 'in progress' ? null : outputCut.text,
    outputCut: outputCut.cut,
    archonTruncated
  }
}

export function getStep(scenario: Scenario, stepId: string): StepView {
  const { steps } = buildSteps(scenario)
  const index = steps.findIndex((entry) => entry.id === stepId)
  const step = steps[index]
  if (!step) throw new Error(`no step ${stepId}`)
  const plan = PLAN.find((entry) => entry.id === stepId) as Plan
  const random = rng(hash(stepId) + 3)
  const agent = plan.kind === 'prompt'
  const reached = step.startedAt !== null
  const items = itemsOf(scenario, step)

  // One step's output runs past the 256 KiB cap; one is three blocks long; the rest are short.
  let full = ''
  if (reached && step.state !== 'running') {
    if (stepId === 'security-review') full = Array.from({ length: 2300 }, () => prose(random, 2)).join('\n')
    else if (stepId === 'investigate') full = Array.from({ length: 150 }, () => wrap(prose(random, 3))).join('\n\n')
    else if (plan.kind === 'bash') full = testLog(random, 1800)
    else if (plan.kind === 'loop') full = 'Loop ended after 3 iterations: the review step reported no findings.'
    else if (plan.kind === 'approval') full = 'Approved: "Plan looks right, go ahead."'
    else full = wrap(prose(random, 8))
  }
  const outputCut = full.length > OUTPUT_CAP
  const shown = full.slice(0, OUTPUT_CAP)

  return {
    step,
    index: index + 1,
    total: steps.length,
    prev: steps[index - 1]?.id ?? null,
    next: steps[index + 1]?.id ?? null,
    costUsd: agent && reached ? Math.round((0.05 + plan.items * 0.004) * 100) / 100 : null,
    tokensIn: agent && reached ? 1200 + plan.items * 410 : null,
    tokensOut: agent && reached ? 300 + plan.items * 55 : null,
    model: agent ? 'claude-sonnet-5-5' : null,
    provider: agent ? 'claude' : null,
    turns: agent && reached ? Math.max(1, Math.round(plan.items / 4)) : null,
    stopReason: agent && step.state === 'completed' ? 'end_turn' : null,
    skipReason: step.state === 'skipped' ? 'The condition `$classify.output.has_ui == "true"` was false.' : null,
    output: shown ? splitLines(shown) : [],
    outputBytes: full.length,
    outputCut,
    error:
      step.state === 'failed'
        ? 'Command failed with exit code 1: pnpm test\n\n \u2717 packages/core/src/dal/setup.test.ts > survives a crash between the two writes\n   AssertionError: expected setup_complete to be false, got true'
        : null,
    items: items.length,
    attempts: Math.max(1, step.ran),
    hidden: agent && reached ? plan.items * 11 : 0
  }
}

// ---------------------------------------------------------------------------------- splitting

/** The decided rule: blocks of at most 16 KiB, cut at a line break and nowhere else. */
export function splitLines(text: string, limit = BLOCK): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let size = 0
  for (const line of text.split('\n')) {
    if (size + line.length + 1 > limit && current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
      size = 0
    }
    current.push(line)
    size += line.length + 1
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

/**
 * The alternative: prefer a blank line outside a code fence or a table. When a fence or a table
 * is itself longer than a block, close it at the cut and open it again in the next block (a
 * fence with its opening line, a table with its header rows).
 */
export function splitBlocks(text: string, limit = BLOCK): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let size = 0
  let fence: string | null = null
  let table: string[] | null = null
  /** Index in `current` of the last blank line that sits outside a fence and a table. */
  let safe = -1

  const flush = (upTo: number, carry: string[]): void => {
    const rest = current.slice(upTo)
    blocks.push(current.slice(0, upTo).join('\n'))
    current = [...carry, ...rest]
    size = current.reduce((sum, line) => sum + line.length + 1, 0)
    safe = -1
  }

  for (const [index, line] of lines.entries()) {
    if (size + line.length + 1 > limit && current.length > 0) {
      if (safe > current.length / 2) {
        flush(safe, [])
      } else if (fence !== null) {
        current.push('```')
        flush(current.length, [fence])
      } else if (table !== null && line.startsWith('|')) {
        flush(current.length, table)
      } else if (safe > 0) {
        flush(safe, [])
      } else {
        flush(current.length, [])
      }
    }
    const isFence = line.startsWith('```')
    if (isFence) fence = fence === null ? line : null
    if (fence === null && !isFence) {
      if (line.startsWith('|')) {
        if (table === null) table = [line, lines[index + 1] ?? '']
      } else {
        table = null
        if (line.trim() === '') safe = current.length
      }
    }
    current.push(line)
    size += line.length + 1
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

// ---------------------------------------------------------------------------------- artifacts

/** About 69 KB, with a code fence, a table and a nested list each lying across a 16 KiB cut. */
function planMarkdown(): string {
  const random = rng(4120)
  const parts: string[] = ['# Implementation plan: issue #412', '', wrap(prose(random, 4)), '']
  const size = (): number => parts.join('\n').length
  let section = 1
  const fillTo = (target: number): void => {
    while (size() < target) {
      if (random() < 0.25) parts.push(`## ${section++}. ${pick(random, SENTENCES).split(' ').slice(0, 6).join(' ')}`, '')
      const paragraph = wrap(prose(random, 3 + Math.floor(random() * 4)))
      parts.push(random() < 0.2 ? paragraph.split('\n').map((line) => `> ${line}`).join('\n') : paragraph, '')
      if (random() < 0.2) parts.push(...FILES.slice(0, 4).map((file) => `- \`${file}\`: ${pick(random, SENTENCES)}`), '')
    }
  }

  fillTo(14_600)
  parts.push('### The new transaction helper', '', '```ts')
  for (let line = 0; line < 70; line++) {
    parts.push(line % 10 === 0 ? `export async function step${line}(tx: Transaction): Promise<void> {` : line % 10 === 9 ? '}' : `  await tx.run(sql\`update setup set stage = ${line} where id = 1\`) // line ${line}`)
  }
  parts.push('```', '')

  fillTo(30_800)
  parts.push('### Call sites to change', '', '| File | Symbol | Change | Risk |', '| --- | --- | --- | --- |')
  for (let row = 0; row < 60; row++) {
    parts.push(`| \`${pick(random, FILES)}\` | \`handler${row}\` | pass the transaction handle down | ${pick(random, ['low', 'low', 'medium', 'high'])} |`)
  }
  parts.push('')

  fillTo(47_000)
  parts.push('### Order of work', '')
  for (let step = 1; step <= 40; step++) {
    parts.push(`${step}. ${pick(random, SENTENCES)}`, `   - touches \`${pick(random, FILES)}\``, `   - check: ${pick(random, COMMANDS)}`)
  }
  parts.push('')

  fillTo(68_500)
  parts.push('## Links', '', '- [The issue](https://github.com/acme/storefront/issues/412)', '- [A link the plugin must refuse](javascript:alert(1))', '')
  return parts.join('\n')
}

const PLAN_MD = planMarkdown()

/** `limit` is the block size for the four small cut-demo files, so a cut shows on one screen. */
type FileSpec = { path: string; size: number; content?: string; limit?: number }

const LONG = 'The wizard writes the admin row first and the completion flag second, in two separate statements, '

// Four small files, each cut once (at 420 bytes instead of 16 KiB) inside one Markdown construct.
const CUT_DEMOS: FileSpec[] = [
  {
    path: 'cut-demo/in-a-code-fence.md',
    size: 0,
    limit: 420,
    content: ['Text before the fence.', '', '```ts', ...Array.from({ length: 12 }, (_, line) => `const step${line} = await tx.run(statement${line}) // code line ${line}`), '```', '', 'Text after the fence, with **bold** and `code`.', '', '- a list item after the fence'].join('\n')
  },
  {
    path: 'cut-demo/in-a-table.md',
    size: 0,
    limit: 420,
    content: ['Text before the table.', '', '| File | Change | Risk |', '| --- | --- | --- |', ...Array.from({ length: 12 }, (_, row) => `| \`setup-${row}.ts\` | pass the handle down | ${row % 3 === 0 ? 'high' : 'low'} |`), '', 'Text after the table.'].join('\n')
  },
  {
    path: 'cut-demo/in-a-list.md',
    size: 0,
    limit: 190,
    content: ['Text before the list.', '', ...Array.from({ length: 5 }, (_, row) => [`${row + 1}. Step ${row + 1} of the work`, `   - touches \`setup-${row}.ts\``, '   - check: pnpm test']).flat(), '', 'Text after the list.'].join('\n')
  },
  {
    path: 'cut-demo/in-a-paragraph.md',
    size: 0,
    limit: 420,
    content: ['## A heading', '', wrap(LONG.repeat(8)), '', '> A quote after the paragraph.'].join('\n')
  }
]

const FILES_13: FileSpec[] = [
  { path: 'plan.md', size: PLAN_MD.length, content: PLAN_MD },
  { path: 'investigation.md', size: 0, content: `# Investigation\n\n${wrap(prose(rng(11), 30))}\n` },
  { path: 'review/findings.md', size: 0, content: `# Review findings\n\n- ${SENTENCES.slice(0, 5).join('\n- ')}\n` },
  { path: 'review/security.md', size: 0, content: '# Security review\n\nNo findings.\n' },
  { path: 'test-output.txt', size: 0, content: testLog(rng(12), 48_000) },
  { path: 'lint.json', size: 0, content: JSON.stringify({ errorCount: 0, warningCount: 2, files: FILES }, null, 2) },
  { path: 'diff.patch', size: 310_442 },
  { path: 'screenshots/before.png', size: 182_011 },
  { path: 'screenshots/after.png', size: 176_530 },
  { path: 'pr-body.md', size: 0, content: '## Summary\n\nMakes the two setup writes one transaction.\n\n## Test plan\n\n- [x] regression test\n- [ ] manual run of the wizard\n' },
  { path: 'summary.md', size: 0, content: `# Summary\n\n${wrap(prose(rng(13), 6))}\n` },
  { path: 'coverage/lcov.info', size: 1_204_118 },
  { path: 'notes/scope.md', size: 0, content: '# Scope\n\nThe migration runner change was not in the issue.\n' },
  ...CUT_DEMOS
]

let big: FileSpec[] | null = null

function filesOf(scenario: Scenario): FileSpec[] {
  const base = FILES_13.map((file) => ({ ...file, size: file.content ? file.content.length : file.size }))
  if (scenario !== 'completed') return base
  if (!big) {
    const random = rng(8905)
    big = [...base]
    const folders = ['coverage/html/packages/core/src/dal', 'coverage/html/packages/core/src/db', 'coverage/html/packages/server/src/routes', 'coverage/html/packages/web/src/routes', 'traces/e2e', 'logs/steps']
    while (big.length < 8905) {
      const index = big.length
      big.push({ path: `${pick(random, folders)}/file-${String(index).padStart(5, '0')}.${pick(random, ['html', 'html', 'json', 'log'])}`, size: 400 + Math.floor(random() * 90_000) })
    }
  }
  return big
}

export function listArtifacts(scenario: Scenario, filter: string): ArtifactList {
  const all = filesOf(scenario)
  const needle = filter.trim().toLowerCase()
  const matching = needle ? all.filter((file) => file.path.toLowerCase().includes(needle)) : all
  const rows: ArtifactRow[] = [...matching]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 200)
    .map((file, index) => ({ path: file.path, size: file.size, modifiedAt: NOW - (20 + index) * MIN }))
  return { rows, matching: matching.length, total: all.length }
}

export function readArtifact(scenario: Scenario, path: string, split: Split): ArtifactBody {
  const file = filesOf(scenario).find((entry) => entry.path === path)
  if (!file) throw new Error(`no artifact ${path}`)
  if (file.size > FILE_CAP) return { path, size: file.size, kind: 'too-large', blocks: [] }
  if (file.content === undefined) {
    if (path.endsWith('.png')) return { path, size: file.size, kind: 'binary', blocks: [] }
    const text = testLog(rng(hash(path)), Math.min(file.size, 6000))
    return { path, size: file.size, kind: 'text', blocks: splitLines(text) }
  }
  const markdown = path.endsWith('.md') || path.endsWith('.mdx')
  return {
    path,
    size: file.size,
    kind: markdown ? 'markdown' : 'text',
    blocks: markdown && split === 'blocks' ? splitBlocks(file.content, file.limit) : splitLines(file.content, file.limit)
  }
}
