// The question of a paused run, read from Archon's answer: a gate from `metadata.approval`, an
// attention wait from the run's `attention` of kind `attention`. Only fields present at the floor
// (Archon 0.12.1) are needed; `does` and `recommendation`, from 0.14.0, are read when sent.
// A question that cannot be read is none: the run then offers nothing to answer.
import { BLOCK_LIMIT, cutMarkdown } from './cutter'
import { isRecord, isText, own, ownRecord } from './records'
import { OPTIONS_CAP, type GateDecision, type Question, type WaitForm, type WaitOption } from './run-answer-view'

/** What a gate offers when it declares no decisions. */
const DEFAULT_DECISIONS: readonly GateDecision[] = [
  { id: 'approve', label: null },
  { id: 'reject', label: null }
]

/** A question's message as Markdown in one block Orca can draw, and whether it was cut. */
function messageOf(value: unknown): { message: string; messageCut: boolean } {
  const text = typeof value === 'string' ? value : ''
  const cut = cutMarkdown(text, BLOCK_LIMIT)
  const first = cut.blocks[0]?.text ?? ''
  return { message: first, messageCut: cut.notShown > 0 || cut.blocks.length > 1 }
}

const optionalText = (value: unknown): string | null => (isText(value) ? value : null)

function decisionOf(value: unknown): GateDecision | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  return isText(id) ? { id, label: optionalText(own(value, 'label')) } : null
}

/** A gate from the run's `metadata.approval`, or null when it has none or it cannot be read. */
function gateOf(metadata: Record<string, unknown>): Question | null {
  const approval = own(metadata, 'approval')
  if (!isRecord(approval)) return null
  const nodeId = own(approval, 'nodeId')
  if (!isText(nodeId)) return null
  const list = own(approval, 'decisions')
  const read = (Array.isArray(list) ? (list as unknown[]) : []).map(decisionOf).filter((decision) => decision !== null)
  const ids = new Set(read.map((decision) => decision.id))
  const decisions = read.filter((decision, index) => read.findIndex((other) => other.id === decision.id) === index)
  return {
    kind: 'gate',
    nodeId,
    pauseId: optionalText(own(approval, 'pauseId')),
    ...messageOf(own(approval, 'message')),
    decisions: ids.size === 0 ? [...DEFAULT_DECISIONS] : decisions,
    authored: own(approval, 'decisionsAuthored') === true && ids.size > 0,
    completionSignaled: own(approval, 'completionSignaled') === true
  }
}

const FORMS: readonly WaitForm[] = ['message', 'approval', 'select', 'multi_select']

function optionOf(value: unknown): WaitOption | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  return isText(id) ? { id, label: optionalText(own(value, 'label')), does: optionalText(own(value, 'does')) } : null
}

/** An attention wait from the run's `attention`, or null when it is not one or cannot be read. */
function waitOf(attention: Record<string, unknown>): Question | null {
  const nodeId = own(attention, 'nodeId')
  const occurrence = own(attention, 'occurrence')
  if (!isText(nodeId) || !isText(occurrence)) return null
  const given = own(attention, 'form')
  const form: WaitForm = occurrence.startsWith('legacy:') ? 'legacy' : (FORMS.find((known) => known === given) ?? 'unknown')
  const list = own(attention, 'options')
  const read = (Array.isArray(list) ? (list as unknown[]) : []).map(optionOf).filter((option) => option !== null)
  const options = read.filter((option, index) => read.findIndex((other) => other.id === option.id) === index)
  const shown = form === 'message' || form === 'legacy' || form === 'unknown' ? [] : options.slice(0, OPTIONS_CAP)
  const recommended = ownRecord(attention, 'recommendation')
  const option = own(recommended, 'option')
  const why = own(recommended, 'why')
  return {
    kind: 'wait',
    nodeId,
    occurrence,
    form,
    ...messageOf(own(attention, 'message')),
    options: shown,
    moreOptions: shown.length === 0 ? 0 : options.length - shown.length,
    recommendation: isText(option) && shown.some((held) => held.id === option) ? { option, why: typeof why === 'string' ? why : '' } : null
  }
}

/**
 * The question a paused run waits on, or null. An `attention` of kind `attention` is a wait; any
 * other kind but `awaiting_response` is a waiting state with nothing to answer; otherwise the
 * run's `metadata.approval` is its gate.
 */
export function questionOf(run: Record<string, unknown>, metadata: Record<string, unknown>): Question | null {
  if (own(run, 'status') !== 'paused') return null
  const attention = own(run, 'attention')
  if (isRecord(attention)) {
    const kind = own(attention, 'kind')
    if (kind === 'attention') return waitOf(attention)
    if (kind !== 'awaiting_response') return null
  }
  return gateOf(metadata)
}
