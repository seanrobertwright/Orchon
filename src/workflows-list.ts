// The validator of `GET /api/workflows`: the workflows Archon lists for one project folder,
// trimmed to what launching reads (name, description, source and declared inputs), all present at
// the floor (Archon 0.12.1). Node definitions are never kept. A row that fails is dropped and
// counted; an answer with no list is an error.
import { isRecord, isText, own } from './records'

export const WORKFLOWS_PATH = '/api/workflows'

/** The read cap of the workflow list (#9): 32 MiB, past which nothing partial is shown. */
export const WORKFLOWS_CAP_BYTES = 32 * 1024 * 1024

/** At most this many declared inputs are kept per workflow (#15). */
export const DECLARED_INPUTS_CAP = 50

/** One declared input: its name, whether it is required, and its description. */
export type DeclaredInput = { name: string; required: boolean; description: string }

/** A workflow trimmed for launching. */
export type ListedWorkflow = {
  name: string
  description: string
  source: string
  /** The declared inputs, at most `DECLARED_INPUTS_CAP`. */
  inputs: DeclaredInput[]
  /** How many inputs it declares, kept or not. */
  inputCount: number
}

export type WorkflowList = { workflows: ListedWorkflow[]; recommended: string[]; unreadable: number }

function parseInputs(value: unknown): { inputs: DeclaredInput[]; count: number } | null {
  if (value === undefined || value === null) return { inputs: [], count: 0 }
  if (!isRecord(value)) return null
  const inputs: DeclaredInput[] = []
  const names = Object.keys(value)
  for (const name of names.slice(0, DECLARED_INPUTS_CAP)) {
    const input = own(value, name)
    const fields = isRecord(input) ? input : {}
    const description = own(fields, 'description')
    inputs.push({ name, required: own(fields, 'required') === true, description: typeof description === 'string' ? description : '' })
  }
  return { inputs, count: names.length }
}

/** One row, or null when it has no name or a field of the wrong type. */
export function parseListedWorkflow(value: unknown): ListedWorkflow | null {
  if (!isRecord(value)) return null
  const workflow = own(value, 'workflow')
  const source = own(value, 'source')
  if (!isRecord(workflow) || !isText(source)) return null
  const name = own(workflow, 'name')
  const description = own(workflow, 'description')
  if (!isText(name)) return null
  if (description !== undefined && description !== null && typeof description !== 'string') return null
  const inputs = parseInputs(own(workflow, 'inputs'))
  if (inputs === null) return null
  return { name, description: typeof description === 'string' ? description : '', source, inputs: inputs.inputs, inputCount: inputs.count }
}

/** The list, or null when Archon's answer as a whole is not one. */
export function parseWorkflowList(value: unknown): WorkflowList | null {
  if (!isRecord(value)) return null
  const rows = own(value, 'workflows')
  const recommended = own(value, 'recommended')
  if (!Array.isArray(rows)) return null
  const workflows: ListedWorkflow[] = []
  for (const row of rows as unknown[]) {
    const parsed = parseListedWorkflow(row)
    if (parsed !== null) workflows.push(parsed)
  }
  const named = Array.isArray(recommended) ? (recommended as unknown[]).filter(isText) : []
  return { workflows, recommended: named, unreadable: rows.length - workflows.length }
}
