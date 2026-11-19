// Which fields of a node the builder lists under "Not editable here". Such a field is kept on its
// node and written back unchanged; the builder shows it as read-only YAML.
//
// The fields that do have an editor are the ones Archon's own builder inspector edits at v0.14.0
// (components/Inspector.tsx and components/inspector/*Fields.tsx, which the plugin does not copy).
import { toWorkflowDefinition } from './archon/model/index.ts'
import type { BuilderNode, VariantId } from './archon/types/index.ts'

/** Fields every editable node kind edits. */
const COMMON = ['id', 'depends_on', 'when', 'trigger_rule', 'output_type']

/** Fields a node kind that calls a provider also edits. `model` only while it is one string. */
const AI = ['provider', 'model', 'persist_session']

/** The node fields that hold an object whose own fields the inspector edits one by one, with those fields. */
const NESTED: Record<string, readonly string[]> = {
  loop: ['prompt', 'command', 'until', 'until_bash', 'until_field', 'max_iterations', 'fresh_context', 'interactive', 'gate_message'],
  approval: ['message', 'capture_response', 'on_reject'],
  wait: ['duration_ms', 'until', 'event', 'deadline_ms', 'attention']
}

/** The edited fields inside the object `key` holds, each named by its path, such as `loop.prompt`. */
const nested = (key: string): string[] => (NESTED[key] ?? []).map((inner) => `${key}.${inner}`)

/** The fields each editable node kind edits. A field inside `loop`, `approval` or `wait` is named by its path. */
const EDITED: Record<VariantId, readonly string[]> = {
  prompt: [...COMMON, ...AI, 'prompt'],
  command: [...COMMON, ...AI, 'command'],
  bash: [...COMMON, 'bash', 'timeout'],
  script: [...COMMON, 'script', 'runtime', 'deps', 'timeout'],
  loop: [...COMMON, ...AI, 'timeout', ...nested('loop')],
  approval: [...COMMON, ...nested('approval')],
  wait: [...COMMON, ...nested('wait')],
  cancel: [...COMMON, 'cancel']
}

/**
 * The fields of `node` that have no editor, in the order a save writes them. A field inside
 * `loop`, `approval` or `wait` is named by its path, such as `loop.signal_completes`. Every field
 * but `id` of a node the builder shows read-only is listed.
 */
export function notEditableHere(node: BuilderNode): string[] {
  const [saved] = toWorkflowDefinition({ name: '', description: '', meta: {}, nodes: [node] }).nodes
  if (saved === undefined) return []
  const fields = Object.entries(saved as Record<string, unknown>)
  if (node.variant === 'opaque') return fields.map(([key]) => key).filter((key) => key !== 'id')

  const edited = EDITED[node.variant]
  const listed: string[] = []
  for (const [key, value] of fields) {
    if (Object.hasOwn(NESTED, key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const inner of Object.keys(value)) {
        if (!edited.includes(`${key}.${inner}`)) listed.push(`${key}.${inner}`)
      }
    } else if (!edited.includes(key) || (key === 'model' && Array.isArray(value))) {
      listed.push(key)
    }
  }
  return listed
}
