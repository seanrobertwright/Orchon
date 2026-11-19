// The hint as a frame gets it: a worker post saying runs changed in Archon. It is types only, so
// the panel and the worker read one contract and no code crosses between them.

/** The two dashboard frames the plugin acts on, the same two Archon's console acts on. */
export type HintType = 'workflow_status' | 'dag_node'

/**
 * Runs changed. It carries the frame types seen and the ids of the runs they named, or `many`,
 * which a frame treats as every run. It never carries run data.
 */
export type RunsHint = {
  types: HintType[]
  runs: string[] | 'many'
}
