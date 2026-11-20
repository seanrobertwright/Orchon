// The refusal and the unreadable pack of the spend recording as the worker answers them, for the
// panel's tests and the scenarios of `orca plugin check`. They are view models, the worker's
// output, never Archon's JSON, and were read off `fixtures/0.14.0/spend/metrics/metrics.json`,
// which is SYNTHETIC: the recorder's own pack made them up. It is development tooling: Orca never
// loads it.
import type { RefusalRow } from '../src/metrics-view.ts'
import type { UnreadablePack } from '../src/refusals-view.ts'

/** The recorded run whose output Archon refused. */
export const REFUSED_RUN = 'a877b80b-6cec-449f-9ad9-41007963d5d3'

/** The recorded `definition_conflict` refusal. */
export const RECORDED_REFUSAL: RefusalRow = {
  key: `${REFUSED_RUN}/emit`,
  reason: 'definition_conflict',
  text: 'offered orchon_synthetic.items_opened as score in ratio, but it is defined as count in items.',
  runId: REFUSED_RUN,
  workflowName: 'orchon-recorder-synthetic-metrics',
  nodeId: 'emit'
}

/** The recorded pack whose card declarations Archon could not read. */
export const RECORDED_UNREADABLE: UnreadablePack = {
  key: 'project:orchon-synthetic-unreadable',
  pack: 'orchon-synthetic-unreadable',
  source: 'project',
  message: '.shared/metric-views.json is invalid: cards: Too small: expected array to have >=1 items'
}
