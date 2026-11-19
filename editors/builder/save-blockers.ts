// Which local validation findings stop the builder's Save. Only the four graph rules do; every
// other finding, such as an unknown variable or a `when:` that does not parse, is a warning or
// a note and leaves Save to the server's validation, which is final.
import type { Issue } from './archon/types/index.ts'

/** The rules whose findings block a save. The copied validation gives each the severity `error`. */
export const SAVE_BLOCKING_RULES: readonly string[] = [
  'structural.id.empty',
  'structural.id.duplicate',
  'graph.ref.unknown',
  'graph.cycle'
]

/** The findings that block a save, in the order given. */
export function saveBlockers(issues: readonly Issue[]): Issue[] {
  return issues.filter((issue) => SAVE_BLOCKING_RULES.includes(issue.rule))
}
