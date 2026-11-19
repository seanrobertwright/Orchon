// The inspector's form for a node (#16, #28): which fields it edits for each node kind, with a
// label each, and how a value typed into one is read and set on the node. A field is named by
// the key a save writes, a field inside `loop`, `approval` or `wait` by its path, such as
// `loop.prompt`. Setting a field changes that field alone: every other field of the node, the
// ones the builder does not recognise included, is carried over as it was. It is pure.
import { isRecord } from '../shared/records.ts'
import { WIRE_KEY_ROLES, type BuilderNode } from './archon/types/index.ts'

/** How a field is edited: one line, several lines, a whole number, a box to tick, a choice, or one item per line. */
export type FieldInput = 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'lines'

export type FieldOption = { value: string; label: string }

export type FormField = {
  /** The key a save writes, or its path inside `loop`, `approval` or `wait`. `wait.mode` chooses what a wait waits for. */
  key: string
  label: string
  input: FieldInput
  /** For a select, the choices in order. An optional select starts with an empty "(not set)" choice. */
  options?: readonly FieldOption[]
  /** The field is always written: an empty text stays empty, and a select has no "(not set)". */
  required: boolean
  /** The value as the input shows it. */
  value: string | boolean
}

export type Applied = { ok: true; node: BuilderNode } | { ok: false; error: string }

/** Says a whole number is wanted, for a number field that does not hold one. */
export const WHOLE_NUMBER = 'Enter a whole number, 0 or more.'
const NOT_A_CHOICE = 'Choose one of the listed values.'

const NOT_SET: FieldOption = { value: '', label: '(not set)' }
const TRIGGER_RULES: readonly FieldOption[] = ['all_success', 'one_success', 'none_failed_min_one_success', 'all_done'].map((value) => ({ value, label: value }))
const RUNTIMES: readonly FieldOption[] = [
  { value: 'bun', label: 'bun' },
  { value: 'uv', label: 'uv' }
]
/** What a wait waits for, each with the keys it writes and its value when chosen. */
const WAIT_MODES: readonly { value: string; label: string; start: Record<string, unknown> }[] = [
  { value: 'duration_ms', label: 'A length of time', start: { duration_ms: 60_000 } },
  { value: 'until', label: 'A moment in time', start: { until: '' } },
  { value: 'event', label: 'An event', start: { event: '', deadline_ms: 60_000 } },
  { value: 'attention', label: 'A person', start: { attention: '' } }
]
const WAIT_MODE_KEYS = ['duration_ms', 'until', 'event', 'deadline_ms', 'attention']

type Spec = Omit<FormField, 'value'>
const text = (key: string, label: string, required = false): Spec => ({ key, label, input: 'text', required })
const area = (key: string, label: string, required = false): Spec => ({ key, label, input: 'textarea', required })
const whole = (key: string, label: string, required = false): Spec => ({ key, label, input: 'number', required })
const tick = (key: string, label: string): Spec => ({ key, label, input: 'checkbox', required: false })

/** The fields every node has, a read-only one included. The dependencies are edited in their own list. */
const SHARED: readonly Spec[] = [
  text('description', 'Description'),
  text('when', 'Runs when'),
  { key: 'trigger_rule', label: 'Trigger rule', input: 'select', options: [NOT_SET, ...TRIGGER_RULES], required: false },
  text('output_type', 'Output type')
]

/** The fields of a node kind that calls a provider. `model` only while it is one string. */
const ai = (node: BuilderNode): Spec[] => [
  text('provider', 'Provider'),
  ...(Array.isArray(node.base.model) ? [] : [text('model', 'Model')]),
  tick('persist_session', 'Keep the session for later nodes')
]

/** Which keys a wait carries decide what it waits for; one with none of them is edited as a length of time. */
function waitMode(data: Record<string, unknown>): string {
  return WAIT_MODES.find((mode) => Object.hasOwn(data, mode.value))?.value ?? 'duration_ms'
}

function waitFields(data: Record<string, unknown>): Spec[] {
  const mode = waitMode(data)
  const chooser: Spec = { key: 'wait.mode', label: 'Wait for', input: 'select', options: WAIT_MODES.map(({ value, label }) => ({ value, label })), required: true }
  switch (mode) {
    case 'until':
      return [chooser, text('wait.until', 'Until (a UTC time, such as 2026-01-31T09:00:00Z)', true)]
    case 'event':
      return [chooser, text('wait.event', 'Event', true), whole('wait.deadline_ms', 'Deadline (ms)', true)]
    case 'attention':
      return [chooser, area('wait.attention', 'Question for the person', true)]
    default:
      return [chooser, whole('wait.duration_ms', 'Duration (ms)', true)]
  }
}

function kindFields(node: BuilderNode): Spec[] {
  switch (node.variant) {
    case 'opaque':
      return []
    case 'prompt':
      return [area('prompt', 'Prompt', true), ...ai(node)]
    case 'command':
      return [text('command', 'Command', true), ...ai(node)]
    case 'bash':
      return [area('bash', 'Bash script', true), whole('timeout', 'Timeout (ms)')]
    case 'script':
      return [
        area('script', 'Script', true),
        { key: 'runtime', label: 'Runtime', input: 'select', options: RUNTIMES, required: true },
        { key: 'deps', label: 'Dependencies, one per line', input: 'lines', required: false },
        whole('timeout', 'Timeout (ms)')
      ]
    case 'loop':
      return [
        node.data.command === undefined ? area('loop.prompt', 'Prompt for each iteration', true) : text('loop.command', 'Command for each iteration', true),
        whole('loop.max_iterations', 'Most iterations', true),
        text('loop.until', 'Until (the signal that ends the loop)'),
        text('loop.until_bash', 'Until (a bash check, exit 0 ends the loop)'),
        text('loop.until_field', 'Until (an output field that ends the loop)'),
        tick('loop.fresh_context', 'Fresh context each iteration'),
        tick('loop.interactive', 'Ask a person between iterations'),
        text('loop.gate_message', 'Message to the person'),
        whole('timeout', 'Timeout (ms)'),
        ...ai(node)
      ]
    case 'approval':
      return [
        area('approval.message', 'Message', true),
        tick('approval.capture_response', "Keep the person's response"),
        area('approval.on_reject.prompt', 'On reject, the prompt to run'),
        whole('approval.on_reject.max_attempts', 'On reject, most attempts')
      ]
    case 'wait':
      return waitFields(node.data as Record<string, unknown>)
    case 'cancel':
      return [area('cancel', 'Reason', true)]
  }
}

const BASE_KEYS: ReadonlySet<string> = new Set(Object.entries(WIRE_KEY_ROLES).filter(([, role]) => role === 'base').map(([key]) => key))

/** Where a field lives on a node: in its shared fields or its kind's data, and the path inside. */
function locate(node: BuilderNode, key: string): { where: 'base' | 'data'; path: string[] } {
  if (BASE_KEYS.has(key)) return { where: 'base', path: [key] }
  if (node.variant === 'cancel' && key === 'cancel') return { where: 'data', path: ['reason'] }
  const [outer, ...inner] = key.split('.')
  if ((node.variant === 'loop' || node.variant === 'approval' || node.variant === 'wait') && outer === node.variant && inner.length > 0) return { where: 'data', path: inner }
  return { where: 'data', path: [key] }
}

function read(record: Record<string, unknown>, path: readonly string[]): unknown {
  let at: unknown = record
  for (const part of path) {
    if (!isRecord(at) || !Object.hasOwn(at, part)) return undefined
    at = at[part]
  }
  return at
}

/** `record` without its field `key`. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([held]) => held !== key))
}

/** `record` with the value at `path` set, or removed when `value` is undefined. An object left empty by a removal is removed too. */
function written(record: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path
  if (head === undefined) return record
  if (rest.length === 0) {
    return value === undefined ? without(record, head) : { ...record, [head]: value }
  }
  const inner = isRecord(record[head]) ? record[head] : {}
  const next = written(inner, rest, value)
  return Object.keys(next).length === 0 ? without(record, head) : { ...record, [head]: next }
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * How each kind of input shows the value a node holds, and reads what is typed back into the
 * value the node holds; a parsed undefined removes the field. A new kind of input is added here.
 */
const INPUTS: Record<FieldInput, { show(value: unknown): string | boolean; parse(field: FormField, raw: string | boolean): Parsed }> = {
  text: { show: asText, parse: parseText },
  textarea: { show: asText, parse: parseText },
  checkbox: {
    show: (value) => value === true,
    parse: (_field, raw) => ({ ok: true, value: raw === true ? true : undefined })
  },
  number: {
    show: (value) => (typeof value === 'number' ? String(value) : ''),
    parse(field, raw) {
      const trimmed = asText(raw).trim()
      if (trimmed === '') return field.required ? { ok: false, error: WHOLE_NUMBER } : { ok: true, value: undefined }
      if (!/^\d+$/.test(trimmed)) return { ok: false, error: WHOLE_NUMBER }
      const value = Number(trimmed)
      return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, error: WHOLE_NUMBER }
    }
  },
  lines: {
    show: (value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('\n') : ''),
    parse(_field, raw) {
      const items = asText(raw)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      return { ok: true, value: items.length === 0 ? undefined : items }
    }
  },
  select: {
    show: asText,
    parse(field, raw) {
      const typed = asText(raw)
      if (typed === '' && !field.required) return { ok: true, value: undefined }
      return field.options?.some((option) => option.value === typed) === true ? { ok: true, value: typed } : { ok: false, error: NOT_A_CHOICE }
    }
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseText(field: FormField, raw: string | boolean): Parsed {
  const typed = asText(raw)
  return { ok: true, value: typed === '' && !field.required ? undefined : typed }
}

function shown(node: BuilderNode, spec: Spec): string | boolean {
  if (spec.key === 'wait.mode') return waitMode(node.data as Record<string, unknown>)
  const { where, path } = locate(node, spec.key)
  return INPUTS[spec.input].show(read((where === 'base' ? node.base : node.data) as Record<string, unknown>, path))
}

/** The fields the inspector shows for a node, with the values it holds. A read-only node has the shared fields alone. */
export function formFields(node: BuilderNode): FormField[] {
  return [...kindFields(node), ...SHARED].map((spec) => ({ ...spec, value: shown(node, spec) }))
}

/**
 * The node with one field set from what its input holds, every other field as it was. A value the
 * field cannot hold, such as a number field holding letters, is refused with a sentence that says why.
 */
export function applyField(node: BuilderNode, field: FormField, raw: string | boolean): Applied {
  const value = INPUTS[field.input].parse(field, raw)
  if (!value.ok) return value
  if (field.key === 'wait.mode') {
    const mode = WAIT_MODES.find((candidate) => candidate.value === value.value)
    if (mode === undefined || node.variant !== 'wait') return { ok: false, error: NOT_A_CHOICE }
    const data = node.data as Record<string, unknown>
    if (waitMode(data) === mode.value) return { ok: true, node }
    const kept = Object.fromEntries(Object.entries(data).filter(([key]) => !WAIT_MODE_KEYS.includes(key)))
    return { ok: true, node: { ...node, data: { ...mode.start, ...kept } } }
  }
  const { where, path } = locate(node, field.key)
  if (where === 'base') return { ok: true, node: { ...node, base: written(node.base as Record<string, unknown>, path, value.value) } as BuilderNode }
  return { ok: true, node: { ...node, data: written(node.data as Record<string, unknown>, path, value.value) } as BuilderNode }
}
