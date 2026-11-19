// The hint as a frame gets it: a worker post saying runs changed in Archon. It holds the contract
// and the one list it is built from, so the panel and the worker read the same thing.

/** The two dashboard frames the plugin acts on, the same two Archon's console acts on. */
export const HINT_TYPES = ['workflow_status', 'dag_node'] as const
export type HintType = (typeof HINT_TYPES)[number]

/**
 * Runs changed. It carries the frame types seen and the ids of the runs they named, or `many`,
 * which a frame treats as every run. It never carries run data.
 */
export type RunsHint = {
  types: HintType[]
  runs: string[] | 'many'
}
