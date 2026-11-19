// The Workflows section as the worker would answer it, for the panel's tests and for the scenarios
// of `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { MockHostOptions } from 'orca/testing'
import type { ConnectionView } from '../src/connection-view.ts'
import type { ScopeView } from '../src/scope-view.ts'
import type { BuilderOpenAnswer, BuilderOpenRequest } from '../src/wide-tabs-view.ts'
import { SECTION_WORKFLOWS_CAP, type DeleteAnswer, type DeleteOutcome, type SectionWorkflow, type WorkflowDelete, type WorkflowsAnswer, type WorkflowsRequest, type WorkflowsSectionView } from '../src/workflows-section-view.ts'
import { connected } from './connection-samples.ts'
import { answeringScope, choices, matchedWeb } from './scope-samples.ts'
import { busyRuns } from './runs-samples.ts'

export const shipIt: SectionWorkflow = { name: 'ship-it', description: 'Ships the web app.', source: 'project', deletable: true }
export const tidy: SectionWorkflow = { name: 'tidy', description: 'Tidies every repository.', source: 'global', deletable: true }
export const deliverWorkflow: SectionWorkflow = { name: 'deliver', description: 'Delivers one change, end to end.', source: 'bundled', deletable: false }
export const packed: SectionWorkflow = { name: 'acme/pack:review', description: 'Reviews from a pack.', source: 'installed', deletable: false }

/** The section for acme/web, read from its own folder, with one workflow of each source. */
export const webWorkflows: Extract<WorkflowsSectionView, { kind: 'ready' }> = {
  kind: 'ready',
  projects: { rows: choices.projects, more: 0, unreadable: 0 },
  codebaseId: 'cb-web',
  folder: 'C:/Projects/web',
  readFrom: null,
  list: { kind: 'ready', rows: [packed, deliverWorkflow, shipIt, tidy], total: 4, matching: 4, unreadable: 0 }
}

/** The section with no project: global, bundled and installed workflows. */
export const unscopedWorkflows: Extract<WorkflowsSectionView, { kind: 'ready' }> = {
  ...webWorkflows,
  codebaseId: null,
  folder: null,
  list: { kind: 'ready', rows: [packed, deliverWorkflow, tidy], total: 3, matching: 3, unreadable: 0 }
}

/** An install with `count` bundled workflows, of which the worker sends the first `SECTION_WORKFLOWS_CAP`. */
export function manyWorkflows(count: number): Extract<WorkflowsSectionView, { kind: 'ready' }> {
  const rows = Array.from({ length: Math.min(count, SECTION_WORKFLOWS_CAP) }, (_, index) => ({ ...deliverWorkflow, name: `wf-${String(index).padStart(3, '0')}` }))
  return { ...webWorkflows, list: { kind: 'ready', rows, total: count, matching: count, unreadable: 0 } }
}

/** What a scripted worker for the Workflows section answers, each as it stands at the request. */
export type WorkflowsScript = {
  workflows: (request: WorkflowsRequest) => WorkflowsSectionView
  remove?: (input: WorkflowDelete) => DeleteOutcome
  open?: (input: BuilderOpenRequest) => BuilderOpenAnswer
  scope?: () => ScopeView
  connection?: ConnectionView
}

/**
 * A stand-in for the worker that answers the Workflows requests as `script` says, and the scope and
 * the runs table as `answeringScope` does.
 */
export function answeringWorkflows(script: WorkflowsScript): MockHostOptions {
  const connection = script.connection ?? connected
  const base = answeringScope(script.scope ?? (() => matchedWeb), (request) => busyRuns(3, request), { connection })
  const answer = (request: WorkflowsRequest): WorkflowsAnswer => ({ connection, workflows: script.workflows(request) })
  return {
    requests: {
      ...base.requests,
      'workflows.read': answer,
      'workflows.delete': (input: WorkflowDelete): DeleteAnswer => ({
        ...answer(input.codebaseId === null ? {} : { project: input.codebaseId }),
        outcome: script.remove?.(input) ?? { kind: 'deleted', name: input.name }
      }),
      'builder.open': (input: BuilderOpenRequest): BuilderOpenAnswer => script.open?.(input) ?? { opened: true }
    }
  }
}
