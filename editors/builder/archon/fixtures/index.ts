/**
 * Named fixture map consumed by the round-trip tests (and, later, PR-2's
 * preview). Each fixture is a wire `WorkflowDefinition` authored already-sparse.
 */
import type { WireWorkflowDefinition } from '../types/index.ts';
import { loopFixture, loopCommandFixture } from './loop.fixture.ts';
import { approvalFixture } from './approval.fixture.ts';
import { cancelFixture } from './cancel.fixture.ts';
import { scriptFixture } from './script.fixture.ts';
import { mixedFixture } from './mixed.fixture.ts';

export {
  loopFixture,
  loopCommandFixture,
  approvalFixture,
  cancelFixture,
  scriptFixture,
  mixedFixture,
};

/** All builder fixtures keyed by name, for table-driven tests. */
export const FIXTURES = {
  loop: loopFixture,
  loopCommand: loopCommandFixture,
  approval: approvalFixture,
  cancel: cancelFixture,
  script: scriptFixture,
  mixed: mixedFixture,
} satisfies Record<string, WireWorkflowDefinition>;
