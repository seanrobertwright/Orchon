// The only workflows the recorder launches: its own, written into the throwaway project, with
// no agent in them; in spend mode's agent-step scenario alone, one agent step of its own; and in
// its metrics scenario alone, the synthetic metrics pack's one shell step. No
// bundled workflow is ever launched, so the recording that spends nothing spends no workflow
// tokens and `archon-worktree-cleanup` cannot be reached.

import type { SpendScenarioName } from './spend.ts'

/** Workflows the recorder must never launch, whatever else changes. */
export const FORBIDDEN_WORKFLOWS: readonly string[] = ['archon-worktree-cleanup']

/** The run statuses after which a run does nothing more. */
export const TERMINAL: readonly string[] = ['completed', 'failed', 'cancelled']

/** A launch was refused by the recorder itself, before any request was sent. */
export class LaunchRefused extends Error {
  override name = 'LaunchRefused'
}

export interface WorkflowDefinition {
  name: string
  description: string
  worktree: { enabled: false }
  inputs?: Record<string, { required?: boolean; description?: string }>
  nodes: Record<string, unknown>[]
}

const base = (name: string, description: string): Pick<WorkflowDefinition, 'name' | 'description' | 'worktree'> => ({
  name: `orchon-recorder-${name}`,
  description,
  // The checkout is never changed, so no run needs a worktree of its own.
  worktree: { enabled: false }
})

/** One shell step that writes a text artifact and prints a line. */
const ECHO: WorkflowDefinition = {
  ...base('echo', 'Orchon fixture recorder: one shell step, no agent.'),
  nodes: [
    {
      id: 'write',
      bash: [
        'mkdir -p "$ARTIFACTS_DIR/notes"',
        'printf \'# Recorded\\n\\nWritten by the Orchon fixture recorder.\\n\' > "$ARTIFACTS_DIR/notes/recorded.md"',
        'echo "recorded"'
      ].join(' && ')
    }
  ]
}

/** The same step behind one required input, for launches Archon refuses after answering 200. */
const INPUTS: WorkflowDefinition = {
  ...base('inputs', 'Orchon fixture recorder: one shell step behind a required input, no agent.'),
  inputs: { item: { required: true, description: 'Any text.' } },
  nodes: [{ id: 'print', bash: 'echo "recorded"' }]
}

/** An approval gate, then an attention wait, then one shell step. */
const GATE: WorkflowDefinition = {
  ...base('gate', 'Orchon fixture recorder: an approval gate and an attention wait, no agent.'),
  nodes: [
    { id: 'gate', approval: { message: 'Recorded gate: approve to go on.' } },
    {
      id: 'ask',
      depends_on: ['gate'],
      wait: {
        attention: 'Recorded question: pick one.',
        form: 'select',
        options: [
          { id: 'first', label: 'The first option' },
          { id: 'second', label: 'The second option' }
        ]
      }
    },
    { id: 'done', depends_on: ['ask'], bash: 'echo "recorded"' }
  ]
}

/** One shell step that fails, for the answers a failed run gives to resume and abandon. */
const FAIL: WorkflowDefinition = {
  ...base('fail', 'Orchon fixture recorder: one shell step that fails, no agent.'),
  nodes: [{ id: 'fail', bash: 'echo "recorded failure" >&2; exit 1' }]
}

/** One shell step that sleeps, so that a run has live work when it is cancelled. */
const SLOW: WorkflowDefinition = {
  ...base('slow', 'Orchon fixture recorder: one shell step that sleeps, no agent.'),
  nodes: [{ id: 'sleep', bash: 'sleep 30; echo "recorded"' }]
}

export const RECORDER_WORKFLOWS = { echo: ECHO, inputs: INPUTS, gate: GATE, fail: FAIL, slow: SLOW } as const

/** The kinds of step that run no agent and that the recorder's workflows are made of. */
const AGENTLESS_KINDS: readonly string[] = ['bash', 'approval', 'wait']

/** Keys that make a step run an agent, start another workflow or run code the recorder did not write. */
const REFUSED_NODE_KEYS: readonly string[] = [
  'prompt',
  'command',
  'loop',
  'loop_group',
  'script',
  'workflow',
  'include',
  'fan_out',
  'provider',
  'model',
  'skills',
  'mcp',
  'hooks',
  'agents'
]

function nodesOf(workflow: unknown): unknown[] {
  if (typeof workflow !== 'object' || workflow === null || !Object.hasOwn(workflow, 'nodes')) {
    throw new LaunchRefused('The workflow has no list of steps, so it cannot be checked.')
  }
  const nodes: unknown = (workflow as Record<string, unknown>).nodes
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new LaunchRefused('The workflow has no list of steps, so it cannot be checked.')
  }
  return nodes
}

/**
 * Fails unless every step of `workflow`, as it is written, is a shell step, an approval gate or
 * a wait. It is run on each of the recorder's own definitions before its file is written.
 */
export function assertNoAgent(workflow: unknown): void {
  for (const node of nodesOf(workflow)) {
    if (typeof node !== 'object' || node === null) throw new LaunchRefused('A step is not an object.')
    const keys = Object.keys(node).filter((key) => (node as Record<string, unknown>)[key] != null)
    const refused = keys.filter((key) => REFUSED_NODE_KEYS.includes(key))
    if (refused.length > 0) throw new LaunchRefused(`A step has ${refused.join(', ')}: it may run an agent.`)
    if (keys.filter((key) => AGENTLESS_KINDS.includes(key)).length !== 1) {
      throw new LaunchRefused('A step is not exactly one of a shell step, an approval gate or a wait.')
    }
  }
}

/**
 * Fails unless every step of Archon's own reading of a workflow is a gate, a wait or a shell
 * step. Archon gives each step a `kind`, and a shell step is `exec` with the runtime `sh`; an
 * agent, a loop and a script in any other runtime are refused. It is run before every launch.
 */
export function assertReadWithoutAgent(workflow: unknown): void {
  for (const node of nodesOf(workflow)) {
    const kind: unknown = typeof node === 'object' && node !== null ? (node as Record<string, unknown>).kind : undefined
    const runtime: unknown = typeof node === 'object' && node !== null ? (node as Record<string, unknown>).runtime : undefined
    const agentless = kind === 'gate' || kind === 'wait' || (kind === 'exec' && runtime === 'sh')
    if (!agentless) throw new LaunchRefused(`Archon reads a step as ${String(kind)}: it is not a gate, a wait or a shell step.`)
  }
}

// ---------------------------------------------------------------------------------------------
// Spend mode: the one workflow with an agent step, written into the throwaway project only for
// the agent-step scenario, and the one chat message the chat-turn scenario sends.
// ---------------------------------------------------------------------------------------------

/** The agent step's whole prompt: two or three tool calls at most. */
export const AGENT_STEP_PROMPT = 'List the files in this folder, then stop.'

/** The tier the agent step runs on. The throwaway home's config pins it to Haiku. */
export const SMALL_TIER = 'small'

/** The one tool the agent step may use. Listing files needs no other. */
export const AGENT_STEP_TOOLS: readonly string[] = ['Glob']

/**
 * One agent step on the small tier that lists the files of the throwaway project. Only Glob is
 * allowed, only the project's own Claude settings are read, it is tried once, and Claude itself
 * stops it past a small budget: a second guard beside the recorder's own ceilings.
 */
export const AGENT_STEP = {
  name: 'orchon-recorder-agent-step',
  description: 'Orchon fixture recorder, spend mode: one agent step on the small tier that lists the files of the throwaway project.',
  worktree: { enabled: false },
  nodes: [
    {
      id: 'list',
      prompt: AGENT_STEP_PROMPT,
      model: SMALL_TIER,
      allowed_tools: [...AGENT_STEP_TOOLS],
      settingSources: ['project'],
      maxBudgetUsd: 0.3,
      retry: { max_attempts: 1 }
    }
  ]
} as const

/** The chat turn's whole message: it asks Archon to run the recorder's shell-step workflow. */
export const CHAT_TURN_MESSAGE = `run workflow ${RECORDER_WORKFLOWS.echo.name}`

/** The agent step's file for the throwaway project. JSON is YAML. */
export function agentStepFile(): { name: string; text: string } {
  return { name: `${AGENT_STEP.name}.yaml`, text: `${JSON.stringify(AGENT_STEP, null, 2)}\n` }
}

const sameList = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])

/**
 * Fails unless Archon reads the agent-step workflow as the recorder wrote it: one agent step
 * with the recorder's prompt, the small tier and Glob alone. Run before it is launched.
 */
export function assertAgentStepAsRead(workflow: unknown): void {
  const nodes = nodesOf(workflow)
  const [node] = nodes
  if (nodes.length !== 1 || typeof node !== 'object' || node === null) throw new LaunchRefused('Archon reads the agent step as more than one step.')
  const step = node as Record<string, unknown>
  const source = step.source as Record<string, unknown> | undefined
  if (step.kind !== 'agent' || typeof source !== 'object' || source === null || source.kind !== 'inline' || source.prompt !== AGENT_STEP_PROMPT) {
    throw new LaunchRefused('Archon does not read the agent step as one agent with the recorder prompt.')
  }
  if (step.model !== SMALL_TIER) throw new LaunchRefused(`Archon reads the agent step's model as ${String(step.model)}, not the ${SMALL_TIER} tier.`)
  if (!sameList(step.allowed_tools, AGENT_STEP_TOOLS)) throw new LaunchRefused('Archon reads the agent step with tools other than Glob.')
}

// ---------------------------------------------------------------------------------------------
// The synthetic metrics pack, written into the throwaway project only for spend mode's metrics
// scenario, which spends nothing. One shell step prints made-up metric records, so Archon's
// metrics reports have something to aggregate without a model, a forge plugin or GitHub.
//
// How Archon 0.14.0 reads it, from coleam00/Archon at 8def159a6b2c23e832a5283b4131cfffd9af9344:
// a node's output is a metric source when its structured output has a top-level `metrics` array
// (`packages/core/src/db/workflow-metrics.ts`); a `bash:` node that declares an `output_format`
// has its stdout parsed as one JSON document and kept as its structured output
// (`packages/workflows/src/dag/nodes/exec/exec-output.ts`); and a pack's overview cards are read
// from `<project>/.archon/workflows/<pack>/.shared/metric-views.json`
// (`packages/workflows/src/metric-views.ts`).
// ---------------------------------------------------------------------------------------------

/** The prefix of every synthetic metric name: no real pack's metric starts with it. */
export const SYNTHETIC_METRIC_PREFIX = 'orchon_synthetic.'

/** The pack folder that declares the synthetic overview cards. */
export const SYNTHETIC_PACK = 'orchon-synthetic'

/** A second pack folder whose declaration Archon cannot accept, so its listing reports an unreadable pack. */
export const SYNTHETIC_UNREADABLE_PACK = 'orchon-synthetic-unreadable'

type SyntheticRecord = Readonly<Record<string, string | number | null>>

const metric = (name: string): string => `${SYNTHETIC_METRIC_PREFIX}${name}`

const syntheticRecord = (name: string, kind: 'count' | 'score', unit: string, subject: string, value: number, more: Record<string, string> = {}): SyntheticRecord => ({
  name: metric(name),
  kind,
  unit,
  subject: `synthetic-${subject}`,
  value,
  ...more
})

const CALIBRATES = { calibrates: metric('tests_useless') }

/**
 * The records the pack prints, every number made up and fixed. Every record has a subject, so a
 * second run replaces the first one's records instead of adding to them. None names `at` or
 * `runs`: each falls in a window by when its step completed and belongs to the run that printed
 * it. The last one gives `items_opened` a second definition, which Archon refuses and reports.
 */
export const SYNTHETIC_METRIC_RECORDS: readonly SyntheticRecord[] = [
  ...[1, 2, 3, 4].map((item) => syntheticRecord('items_opened', 'count', 'items', `item-${item}`, 1)),
  ...[1, 2].map((item) => syntheticRecord('items_merged', 'count', 'items', `item-${item}`, 1)),
  syntheticRecord('items_abandoned', 'count', 'items', 'item-4', 1),
  syntheticRecord('tests_added', 'count', 'tests', 'item-1', 5),
  syntheticRecord('tests_added', 'count', 'tests', 'item-2', 3),
  syntheticRecord('tests_useless', 'count', 'tests', 'item-1', 1),
  syntheticRecord('tests_useless', 'count', 'tests', 'item-2', 1),
  ...[1, 1, 0, 1].map((value, index) => syntheticRecord('useless_tests_caught', 'score', 'ratio', `case-${index + 1}`, value, CALIBRATES)),
  ...[0.5, 0.7, 0.9].map((value, index) => syntheticRecord('review_score', 'score', 'ratio', `item-${index + 1}`, value)),
  syntheticRecord('items_opened', 'score', 'ratio', 'item-5', 0.5)
]

/** The names the synthetic records carry, once each. */
export const SYNTHETIC_METRIC_NAMES: readonly string[] = [...new Set(SYNTHETIC_METRIC_RECORDS.map((record) => String(record.name)))]

/** The one shell step: it prints the records and nothing else. */
export const SYNTHETIC_METRICS: WorkflowDefinition = {
  ...base('synthetic-metrics', 'Orchon fixture recorder: one shell step that prints made-up metric records, no agent.'),
  nodes: [
    {
      id: 'emit',
      bash: `echo '${JSON.stringify({ metrics: SYNTHETIC_METRIC_RECORDS })}'`,
      output_format: { type: 'object', required: ['metrics'], properties: { metrics: { type: 'array' } } }
    }
  ]
}

/** The overview cards, one of each shape Archon 0.14.0 knows. */
const SYNTHETIC_VIEWS = {
  names: {
    [metric('items_opened')]: 'Synthetic items opened',
    [metric('items_merged')]: 'Synthetic items merged',
    [metric('items_abandoned')]: 'Synthetic items abandoned',
    [metric('tests_added')]: 'Synthetic new tests',
    [metric('tests_useless')]: 'Synthetic useless tests',
    [metric('useless_tests_caught')]: 'Synthetic judge catch rate',
    [metric('review_score')]: 'Synthetic review score'
  },
  cards: [
    {
      shape: 'count',
      title: 'Synthetic items merged',
      metric: metric('items_merged'),
      breakdown: [
        { metric: metric('items_opened'), label: 'opened' },
        { metric: metric('items_abandoned'), label: 'abandoned' }
      ]
    },
    {
      shape: 'ratio',
      title: 'Synthetic useless tests',
      numerator: metric('tests_useless'),
      denominator: metric('tests_added'),
      denominator_label: 'new tests',
      calibration: { metric: metric('useless_tests_caught'), label: 'judge catches', rough_below: 0.8 }
    },
    { shape: 'cost_per', title: 'Synthetic cost per item', metric: metric('items_merged'), cost_of: metric('items_opened') }
  ]
}

/**
 * The pack's files, by path inside the project's `.archon/workflows` folder: the workflow, its
 * overview cards, and a declaration with no cards, which Archon lists as unreadable.
 */
export function syntheticPackFiles(): { path: string; text: string }[] {
  const workflow = workflowFile(SYNTHETIC_METRICS)
  return [
    { path: workflow.name, text: workflow.text },
    { path: `${SYNTHETIC_PACK}/.shared/metric-views.json`, text: `${JSON.stringify(SYNTHETIC_VIEWS, null, 2)}\n` },
    { path: `${SYNTHETIC_UNREADABLE_PACK}/.shared/metric-views.json`, text: `${JSON.stringify({ cards: [] }, null, 2)}\n` }
  ]
}

/**
 * The files a spend scenario adds to the throwaway project, by path inside its
 * `.archon/workflows` folder: the agent step for `agent-step`, the synthetic pack for `metrics`,
 * and none for any other scenario or for the recording that spends nothing.
 */
export function scenarioFiles(scenario: SpendScenarioName | undefined): { path: string; text: string }[] {
  if (scenario === 'agent-step') {
    const file = agentStepFile()
    return [{ path: file.name, text: file.text }]
  }
  return scenario === 'metrics' ? syntheticPackFiles() : []
}

/** Shows a name in a sentence: as it is, or in code quotes for Markdown. */
type Quote = (name: string) => string

/** What a recording says when the synthetic pack ran and Archon reported its records. */
export function syntheticDescription(quote: Quote = (name) => name): string {
  return `every metric record here, and the overview cards of ${quote(SYNTHETIC_PACK)}, were made up by the recorder's own pack (workflow ${quote(
    SYNTHETIC_METRICS.name
  )}, one shell step, fixed numbers, names starting ${quote(SYNTHETIC_METRIC_PREFIX)}). They measure nothing`
}

/** What a recording says when the synthetic pack was launched but its records were not confirmed. */
export function possiblySyntheticDescription(why: string, quote: Quote = (name) => name): string {
  return `the recorder's synthetic pack was launched but its records were not confirmed (${why}), so any metric record here named ${quote(
    `${SYNTHETIC_METRIC_PREFIX}*`
  )}, and the overview cards of ${quote(SYNTHETIC_PACK)}, were made up by it. They measure nothing`
}

/** What a recording says when the synthetic pack was never launched. */
export function emptyStoreDescription(why: string, quote: Quote = (name) => name): string {
  return `the recorder's synthetic pack was never launched (${why}), so the reports were read over an empty store. Any overview cards of ${quote(SYNTHETIC_PACK)} are still made up`
}

/** Fails unless `name` is one of the recorder's own workflows. Called before every launch. */
export function assertLaunchable(name: string): void {
  if (FORBIDDEN_WORKFLOWS.includes(name)) throw new LaunchRefused(`The recorder never launches ${name}.`)
  const own = Object.values(RECORDER_WORKFLOWS).some((workflow) => workflow.name === name)
  if (!own) throw new LaunchRefused(`The recorder launches only its own workflows, and ${name} is not one.`)
}

/**
 * A definition as the file the recorder writes into the throwaway project. JSON is YAML, so the
 * file needs no YAML writer and holds exactly the object that was checked.
 */
export function workflowFile(workflow: WorkflowDefinition): { name: string; text: string } {
  assertNoAgent(workflow)
  return { name: `${workflow.name}.yaml`, text: `${JSON.stringify(workflow, null, 2)}\n` }
}
