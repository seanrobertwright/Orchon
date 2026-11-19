// The Launch section as the worker would answer it, for the panel's tests and for the scenarios of
// `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { MockHostOptions } from 'orca/testing'
import type { ConnectionView } from '../src/connection-view.ts'
import type { LaunchAnswer, LaunchEdit, LaunchNotice, LaunchStart, LaunchView, LaunchWorkflow, NoticesAnswer } from '../src/launch-view.ts'
import type { ScopeView } from '../src/scope-view.ts'
import { connected } from './connection-samples.ts'
import { answeringScope, choices, matchedWeb } from './scope-samples.ts'
import { busyRuns } from './runs-samples.ts'

export const deliver: LaunchWorkflow = { name: 'deliver', description: 'Delivers one change, end to end.', source: 'bundled', recommended: true }
export const review: LaunchWorkflow = { name: 'review', description: 'Reviews a pull request.', source: 'bundled', recommended: false }

/** The form for the panel's project, acme/web, with two workflows and nothing typed. */
export const webForm: Extract<LaunchView, { kind: 'ready' }> = {
  kind: 'ready',
  projects: { rows: choices.projects, more: 0, unreadable: 0 },
  codebaseId: 'cb-web',
  workflows: { kind: 'ready', rows: [deliver, review], total: 2, matching: 2, unreadable: 0 },
  workflow: 'deliver',
  description: deliver.description,
  inputs: { kind: 'ready', rows: [] },
  message: '',
  posting: false
}

/** The form with no project chosen, as under "All projects" or in an unmatched workspace. */
export const emptyForm: Extract<LaunchView, { kind: 'ready' }> = {
  ...webForm,
  codebaseId: null,
  workflows: { kind: 'none' },
  workflow: null,
  description: ''
}

/** What a scripted worker for the Launch section answers, each as it stands at the request. */
export type LaunchScript = {
  launch: () => LaunchView
  start?: (input: LaunchStart) => LaunchView
  edit?: (input: LaunchEdit) => LaunchView
  notices?: () => LaunchNotice[]
  looking?: () => number
  scope?: () => ScopeView
  connection?: ConnectionView
}

/**
 * A stand-in for the worker that answers the Launch requests as `script` says, and the scope and
 * the runs table as `answeringScope` does.
 */
export function answeringLaunch(script: LaunchScript): MockHostOptions {
  const connection = script.connection ?? connected
  const base = answeringScope(script.scope ?? (() => matchedWeb), (request) => busyRuns(3, request), { connection })
  const answer = (launch: LaunchView): LaunchAnswer => ({ connection, launch, notices: script.notices?.() ?? [] })
  const notices = (): NoticesAnswer => ({ connection, notices: script.notices?.() ?? [], looking: script.looking?.() ?? 0 })
  return {
    requests: {
      ...base.requests,
      'launch.read': () => answer(script.launch()),
      'launch.edit': (input: LaunchEdit) => answer(script.edit?.(input) ?? script.launch()),
      'launch.start': (input: LaunchStart) => answer(script.start?.(input) ?? script.launch()),
      'launch.another': () => answer(script.launch()),
      'launch.wait': () => answer(script.launch()),
      'launch.notices': notices,
      'launch.dismiss': notices
    }
  }
}
