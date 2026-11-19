// What the builder tab shows of a definition (#16, #28): every node with its kind and whether the
// builder can edit it, the arrows between nodes, the issues opening and the local rules found, and
// the YAML a save would write. The copied Archon logic reads the definition; this module gathers
// what the tab draws, once per definition, so nothing is derived again on a redraw. It is pure.
import { fromWorkflowDefinition, toWorkflowDefinition } from './archon/model/index.ts'
import type { BuilderNode, Issue, OpaqueKind, Severity, WireWorkflowDefinition } from './archon/types/index.ts'
import { runValidation } from './archon/validation/index.ts'
import { serializeToYaml } from './archon/yaml/index.ts'
import { notEditableHere } from './not-editable.ts'

/** One node as the canvas, the outline and the inspector show it. */
export type NodeFacts = {
  /** The node's id as the workflow spells it. Two nodes may share one; they are told apart by position. */
  id: string
  /** Its kind in words, such as `prompt` or `loop group`. */
  kind: string
  /** A node the builder cannot edit: shown read-only and saved unchanged. */
  readOnly: boolean
  /** Why it is read-only, as a sentence, or null when it is not. */
  reason: string | null
  /** The ids it depends on, as the workflow names them. */
  dependsOn: string[]
  /** It has a `when`, so an arrow into it is drawn dashed. */
  conditional: boolean
  /** The fields with no editor, listed under "Not editable here"; a nested field by its path. */
  notEditable: string[]
  /** The node as a save writes it, as YAML. */
  yaml: string
}

/** An arrow from the node at position `from`, a dependency, to the node at position `to`. */
export type EdgeFacts = { from: number; to: number }

/** One issue, with its severity as a word so it is never told by colour alone. */
export type IssueFacts = { severity: 'Error' | 'Warning' | 'Info'; rule: string; message: string; nodeId: string | null }

export type WorkflowFacts = {
  name: string
  description: string
  nodes: NodeFacts[]
  edges: EdgeFacts[]
  /** Errors first, then warnings, then information, each in the order found. */
  issues: IssueFacts[]
  /** The workflow as a save writes it, as YAML. */
  yaml: string
  /** The workflow-level keys other than `name`, `description` and `nodes`, as YAML, or empty. */
  settingsYaml: string
}

const OPAQUE_KIND: Record<OpaqueKind, { kind: string; reason: string }> = {
  loop_group: { kind: 'loop group', reason: 'A loop group has no editor here.' },
  workflow: { kind: 'workflow', reason: 'A node that runs another workflow has no editor here.' },
  include: { kind: 'include', reason: 'An include has no editor here.' },
  unrecognised: { kind: 'unknown kind', reason: 'This node is of a kind the builder does not know.' },
  script_without_runtime: { kind: 'script with no runtime', reason: 'This script node names no runtime.' },
  loop_with_prompt_and_command: { kind: 'loop with prompt and command', reason: 'This loop node has both a prompt and a command.' }
}

const SEVERITY: Record<Severity, IssueFacts['severity']> = { error: 'Error', warning: 'Warning', info: 'Info' }
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

const texts = (value: unknown): string[] => (Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === 'string') : [])

/** The YAML a save writes for one node: its item under `nodes:`, unindented. */
function nodeYaml(node: BuilderNode): string {
  const whole = serializeToYaml(toWorkflowDefinition({ name: '', description: '', meta: {}, nodes: [node] }))
  const lines = whole.split('\n')
  const start = lines.indexOf('nodes:')
  return lines
    .slice(start + 1)
    .filter((line) => line !== '')
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
}

/** The YAML of the workflow-level keys other than `name`, `description` and `nodes`, or empty. */
function settingsYaml(meta: Record<string, unknown>): string {
  if (Object.keys(meta).length === 0) return ''
  const whole = serializeToYaml({ name: '', description: '', ...meta, nodes: [] } as unknown as Parameters<typeof serializeToYaml>[0])
  const lines = whole.split('\n')
  const end = lines.indexOf('nodes:')
  return lines
    .slice(1, end)
    .filter((line) => line !== '')
    .join('\n')
}

function nodeFacts(node: BuilderNode): NodeFacts {
  const opaque = node.variant === 'opaque' ? OPAQUE_KIND[node.data.kind] : null
  return {
    id: typeof node.id === 'string' ? node.id : '',
    kind: opaque?.kind ?? node.variant,
    readOnly: opaque !== null,
    reason: opaque?.reason ?? null,
    dependsOn: texts(node.base.depends_on),
    conditional: typeof node.base.when === 'string' && node.base.when !== '',
    notEditable: notEditableHere(node),
    yaml: nodeYaml(node)
  }
}

const issueFacts = (issue: Issue): IssueFacts => ({ severity: SEVERITY[issue.severity], rule: issue.rule, message: issue.message, nodeId: issue.path.nodeId ?? null })

/** What the tab shows of a definition the worker checked, or null when the copied logic cannot read it. */
export function workflowFacts(definition: Record<string, unknown>): WorkflowFacts | null {
  if (!Array.isArray(definition.nodes)) return null
  try {
    const { workflow, issues } = fromWorkflowDefinition(definition as unknown as WireWorkflowDefinition)
    const nodes = workflow.nodes.map(nodeFacts)
    const first = new Map<string, number>()
    nodes.forEach((node, index) => {
      if (!first.has(node.id)) first.set(node.id, index)
    })
    const edges: EdgeFacts[] = []
    nodes.forEach((node, to) => {
      for (const id of node.dependsOn) {
        const from = first.get(id)
        if (from !== undefined && from !== to) edges.push({ from, to })
      }
    })
    edges.sort((a, b) => a.from - b.from || a.to - b.to)
    const found = [...issues, ...runValidation(workflow)]
      .map((issue, at) => ({ issue, at }))
      .sort((a, b) => RANK[a.issue.severity] - RANK[b.issue.severity] || a.at - b.at)
      .map(({ issue }) => issueFacts(issue))
    return {
      name: typeof workflow.name === 'string' ? workflow.name : '',
      description: typeof workflow.description === 'string' ? workflow.description : '',
      nodes,
      edges,
      issues: found,
      yaml: serializeToYaml(toWorkflowDefinition(workflow)),
      settingsYaml: settingsYaml(workflow.meta as Record<string, unknown>)
    }
  } catch {
    return null
  }
}
