// Re-run's draft (#15, #27): what a completed or cancelled run fills the launcher with, built
// from the run's own record in Archon's answer and the workflow list the launcher holds. It is
// pure logic: no host, no network. Model bindings are never filled.
import { cutAt } from './cutter'
import { MESSAGE_CAP, NOTE_NAMES_CAP, type DraftInput } from './launch-view'
import { isRecord, isText, own, ownRecord } from './records'
import type { RunStatus } from './runs-view'
import type { DeclaredInput } from './workflows-list'

/** The states that offer Re-run. */
export const RERUN_STATUSES: readonly RunStatus[] = ['completed', 'cancelled']

/** What Re-run reads off the run: the whole launch message and the recorded inputs, if any. */
export type RerunSource = {
  /** The launch message as Archon recorded it, uncut. */
  message: string
  /** `metadata.inputs`, or null when the run recorded none. */
  inputs: Record<string, unknown> | null
}

/** The run's launch message and inputs from `GET /api/workflows/runs/{id}`'s answer. */
export function rerunSourceOf(value: unknown): RerunSource {
  const run = isRecord(value) ? own(value, 'run') : undefined
  if (!isRecord(run)) return { message: '', inputs: null }
  const message = own(run, 'user_message')
  const inputs = own(ownRecord(run, 'metadata'), 'inputs')
  return { message: typeof message === 'string' ? message : '', inputs: isRecord(inputs) ? inputs : null }
}

/** The names, at most `NOTE_NAMES_CAP`, then "and N more". */
function namesLine(names: readonly string[]): string {
  const shown = names.slice(0, NOTE_NAMES_CAP).join(', ')
  const more = names.length - NOTE_NAMES_CAP
  return more > 0 ? `${shown} and ${String(more)} more` : shown
}

export type RerunDraft = { message: string; inputs: DraftInput[]; notes: string[] }

/**
 * The draft's message and inputs, and the notices beside them. `declared` is the inputs the
 * chosen workflow declares now, or null when no workflow is chosen: then no input is filled and
 * no input notice is said, because the workflow's own notice covers it.
 */
export function rerunDraft(source: RerunSource, declared: readonly DeclaredInput[] | null): RerunDraft {
  const notes: string[] = []
  const message = cutAt(source.message, MESSAGE_CAP)
  if (message.length < source.message.length) {
    notes.push(`The run's message is longer than ${MESSAGE_CAP.toLocaleString('en-US')} characters, so it was cut to fit.`)
  }
  const inputs: DraftInput[] = []
  if (declared !== null && source.inputs !== null) {
    const recorded = source.inputs
    const names = new Set(declared.map((input) => input.name))
    const dropped = Object.keys(recorded).filter((name) => !names.has(name))
    const unreadable: string[] = []
    for (const { name } of declared) {
      if (!Object.hasOwn(recorded, name)) continue
      const value = recorded[name]
      if (isText(value) && value.length <= MESSAGE_CAP) inputs.push({ name, value })
      else unreadable.push(name)
    }
    if (dropped.length > 0) notes.push(`Not filled, because the workflow no longer declares them: ${namesLine(dropped)}.`)
    if (unreadable.length > 0) {
      notes.push(`Not filled, because the run's value is not text of at most ${MESSAGE_CAP.toLocaleString('en-US')} characters: ${namesLine(unreadable)}.`)
    }
  }
  return { message, inputs, notes }
}
