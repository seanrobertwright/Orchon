// PROTOTYPE. Made-up runs with the shape and sizes of a real Archon install: 353 runs, three
// projects, long workflow names, messages up to a few thousand characters (cut to 160 here, as
// the real worker would cut them before they cross to the panel).
import type { Counts, RunRow, RunStatus, RunsListInput, RunsListOutput } from './protocol'

const MATCHED = 'acme/storefront'
const PROJECTS = [MATCHED, MATCHED, MATCHED, 'acme/billing-api', 'acme/billing-api', 'acme/docs-site']
const WORKFLOWS = [
  'archon-fix-github-issue',
  'archon-feature-development',
  'archon-comprehensive-pr-review',
  'archon-assist',
  'acme/sdlc-pack:implement-and-review',
  'archon-resolve-conflicts'
]
const STEPS = ['fetch', 'plan', 'implement', 'gate', 'review', 'address', 'verify', 'publish-pr']
const MESSAGES = [
  'Implement GitHub issue #652 (Shell look: neon accents on live state), a sub-issue of spec #630. Read the issue body for acceptance criteria and open a PR targeting master.',
  'Fix issue #418: checkout total is wrong when a coupon and a gift card are combined.',
  'Review PR #977 for correctness and for the security checklist.',
  'Why does the nightly export job time out on the largest tenant?',
  'Add pagination to the invoices list and an index for the query it runs.',
  'Resolve the merge conflicts on ticket-640 against master.',
  'Upgrade the date helper and sweep every caller that still parses dates by hand.'
]

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Small seeded generator, so every load draws the same runs. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function build(now: number): RunRow[] {
  const random = seeded(7)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
  const rows: RunRow[] = []

  const make = (index: number, status: RunStatus, startedAgo: number): RunRow => {
    const project = pick(PROJECTS)
    const total = 6 + Math.floor(random() * 12)
    const ended = status === 'completed' || status === 'failed' || status === 'cancelled'
    const lasted = Math.round((2 + random() * random() * 180) * MINUTE)
    const done = ended ? total : Math.max(1, Math.floor(random() * total))
    const ticket = 400 + Math.floor(random() * 400)
    const [owner, repo] = project.split('/')
    const worktreeRoll = random()
    return {
      id: (index * 2654435761).toString(16).padStart(8, '0') + 'a3f19c20b7d4e6',
      workflow: pick(WORKFLOWS),
      project,
      message: pick(MESSAGES).slice(0, 160),
      status,
      attention: null,
      startedAt: now - startedAgo,
      endedAt: ended ? now - startedAgo + Math.min(lasted, startedAgo) : null,
      step: status === 'pending' ? null : { name: pick(STEPS), done, total },
      costUsd: status === 'pending' ? null : Math.round(random() * 900) / 100,
      worktree: {
        path: `C:\\Users\\dev\\.archon\\workspaces\\${owner}\\${repo}\\worktrees\\ticket-${ticket}`,
        state: worktreeRoll < 0.2 ? 'in-orca' : worktreeRoll < 0.6 ? 'on-disk' : 'missing'
      }
    }
  }

  let index = 1
  // Live runs first: two paused on a person, three running, one queued.
  const gate = make(index++, 'paused', 42 * MINUTE)
  gate.project = MATCHED
  gate.workflow = 'archon-feature-development'
  gate.attention = { kind: 'awaiting_response', question: 'Approve the plan for issue #652 before implementation starts?' }
  gate.step = { name: 'gate', done: 3, total: 15 }
  gate.worktree.state = 'in-orca'
  const limit = make(index++, 'paused', 3 * HOUR)
  limit.project = 'acme/billing-api'
  limit.attention = { kind: 'usage_limit', question: 'The assistant hit its usage limit. Resume when the limit resets, or switch model.' }
  rows.push(gate, limit)
  for (const ago of [6 * MINUTE, 19 * MINUTE, 71 * MINUTE]) {
    rows.push(make(index++, 'running', ago))
  }
  ;(rows[2] as RunRow).project = MATCHED
  ;(rows[2] as RunRow).worktree.state = 'on-disk'
  rows.push(make(index++, 'pending', 2 * MINUTE))

  // History: 270 completed, 48 failed, 29 cancelled, spread over about three weeks.
  const history: RunStatus[] = [
    ...Array<RunStatus>(270).fill('completed'),
    ...Array<RunStatus>(48).fill('failed'),
    ...Array<RunStatus>(29).fill('cancelled')
  ]
  for (let i = history.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[history[i], history[j]] = [history[j] as RunStatus, history[i] as RunStatus]
  }
  let ago = 4 * HOUR
  for (const status of history) {
    ago += Math.round(random() * 3 * HOUR)
    rows.push(make(index++, status, ago))
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

let cache: { at: number; rows: RunRow[] } | undefined

function allRuns(): RunRow[] {
  // Rebuilt at most once a minute so "started" times stay believable while the panel is open.
  const now = Date.now()
  if (!cache || now - cache.at > MINUTE) {
    cache = { at: now, rows: build(now) }
  }
  return cache.rows
}

function matches(row: RunRow, status: RunsListInput['status']): boolean {
  if (status === 'all') return true
  if (status === 'attention') return row.attention !== null
  return row.status === status
}

export function listRuns(input: RunsListInput): RunsListOutput {
  const matchedProject = input.scenario === 'unmatched' ? null : MATCHED
  const source = input.scenario === 'empty' ? [] : allRuns()
  const scoped =
    input.scope === 'project' && matchedProject
      ? source.filter((row) => row.project === matchedProject)
      : source

  const counts: Counts = {
    all: scoped.length,
    attention: 0,
    running: 0,
    paused: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  }
  const perProject = new Map<string, number>()
  for (const row of scoped) {
    counts[row.status] += 1
    if (row.attention) counts.attention += 1
    perProject.set(row.project, (perProject.get(row.project) ?? 0) + 1)
  }

  const filtered = scoped.filter(
    (row) => matches(row, input.status) && (!input.project || row.project === input.project)
  )
  const limit = Math.min(Math.max(1, input.limit), 100)
  return {
    rows: filtered.slice(input.offset, input.offset + limit),
    total: filtered.length,
    counts,
    projects: [...perProject].map(([name, count]) => ({ name, count })),
    matchedProject
  }
}
