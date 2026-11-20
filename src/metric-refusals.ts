// The refusals of Archon's metrics report and the packs whose card declarations Archon could not
// read, validated by hand in the worker and trimmed to what the Metrics section draws.
//
// A refusal's shape is `metricRefusalSchema` in `packages/workflows/src/schemas/metric.ts`, and a
// pack that could not be read is an entry of `errors` in `metricViewsListingSchema` beside it.
// The words are the console's: `refusalText` and `definitionLabel` in `MetricsDetails.tsx`, in the
// console's metrics folder of Archon 0.14.0 (commit 8def159a6b2c23e832a5283b4131cfffd9af9344).
import { cutAt } from './cutter'
import { isMetricName, METRICS_TEXT_CAP } from './metric-figures'
import { REFUSALS_CAP, type RefusalRow } from './metrics-view'
import { isRecord, isText, own } from './records'
import { UNREADABLE_PACKS_CAP, type UnreadablePack } from './refusals-view'

const cut = (text: string): string => cutAt(text, METRICS_TEXT_CAP)

/** A name's definition as the console writes it, such as "count in items, calibrates sdlc.x", or null. */
function definitionLabel(value: unknown): string | null {
  if (!isRecord(value)) return null
  const kind = own(value, 'kind')
  const unit = own(value, 'unit')
  const calibrates = own(value, 'calibrates')
  if (!isText(kind) || !isText(unit) || !(calibrates === null || isMetricName(calibrates))) return null
  return `${cut(kind)} in ${cut(unit)}${calibrates === null ? '' : `, calibrates ${calibrates}`}`
}

/** Why Archon would not store the output, in the console's words, or null when it cannot be read. */
function refusalText(value: Record<string, unknown>, reason: string): string | null {
  if (reason === 'invalid') {
    const errors = own(value, 'errors')
    if (!Array.isArray(errors) || !(errors as unknown[]).every(isText)) return null
    // Archon's own messages, joined as the console joins them, are cut before the sentence ends.
    return `emitted invalid records: ${cut((errors as string[]).join('; '))}.`
  }
  if (reason === 'definition_conflict') {
    const name = own(value, 'name')
    const offered = definitionLabel(own(value, 'offered'))
    const definition = definitionLabel(own(value, 'definition'))
    if (!isMetricName(name) || offered === null || definition === null) return null
    return `offered ${name} as ${offered}, but it is defined as ${definition}.`
  }
  return `was refused for a reason this version of Orchon does not know: ${cut(reason)}.`
}

type Refusal = Omit<RefusalRow, 'key'>

function parseRefusal(value: unknown): Refusal | null {
  if (!isRecord(value)) return null
  const reason = own(value, 'reason')
  const runId = own(value, 'run_id')
  const workflowName = own(value, 'workflow_name')
  const nodeId = own(value, 'node_id')
  if (!isText(reason) || !isText(runId) || !isText(workflowName) || !isText(nodeId)) return null
  const text = refusalText(value, reason)
  if (text === null) return null
  return { reason: cut(reason), text, runId: cut(runId), workflowName: cut(workflowName), nodeId: cut(nodeId) }
}

/**
 * The first `REFUSALS_CAP` refusals the plugin can read, in Archon's order. One node output can
 * refuse several records with the same run and node, so the key counts repeats.
 */
export function parseRefusals(refused: readonly unknown[]): RefusalRow[] {
  const rows: RefusalRow[] = []
  const seen = new Map<string, number>()
  for (const value of refused) {
    if (rows.length >= REFUSALS_CAP) break
    const refusal = parseRefusal(value)
    if (refusal === null) continue
    const base = `${refusal.runId}/${refusal.nodeId}`
    const times = (seen.get(base) ?? 0) + 1
    seen.set(base, times)
    rows.push({ key: times === 1 ? base : `${base}#${String(times)}`, ...refusal })
  }
  return rows
}

/**
 * The first `UNREADABLE_PACKS_CAP` packs whose declarations Archon could not read, in its order,
 * and how many more it listed, or null when the declarations answer has no list of them.
 */
export function parseUnreadablePacks(views: unknown): { packs: UnreadablePack[]; more: number } | null {
  if (!isRecord(views)) return null
  const errors = own(views, 'errors')
  if (!Array.isArray(errors)) return null
  const packs: UnreadablePack[] = []
  const seen = new Map<string, number>()
  for (const value of errors as unknown[]) {
    if (packs.length >= UNREADABLE_PACKS_CAP) break
    if (!isRecord(value)) continue
    const pack = own(value, 'pack')
    const source = own(value, 'source')
    const error = own(value, 'error')
    if (!isText(pack) || !isText(source) || !isText(error)) continue
    const base = `${cut(source)}:${cut(pack)}`
    const times = (seen.get(base) ?? 0) + 1
    seen.set(base, times)
    packs.push({ key: times === 1 ? base : `${base}#${String(times)}`, pack: cut(pack), source: cut(source), message: cut(error) })
  }
  return { packs, more: errors.length - packs.length }
}
