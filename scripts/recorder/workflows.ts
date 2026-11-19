// The only workflows the recorder launches: its own, written into the throwaway project, with
// no agent in them. No bundled workflow is ever launched, so no launch spends workflow tokens
// and `archon-worktree-cleanup` cannot be reached.

/** Workflows the recorder must never launch, whatever else changes. */
export const FORBIDDEN_WORKFLOWS: readonly string[] = ['archon-worktree-cleanup']

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
