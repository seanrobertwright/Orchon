// The project scope as the worker would answer it, for the panel's tests and for the scenarios of
// `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { MockHostOptions } from 'orca/testing'
import type { ConnectionView } from '../src/connection-view.ts'
import type { RunsRequest, RunsView } from '../src/runs-view.ts'
import type { LinkChoices, ScopeAnswer, ScopeView } from '../src/scope-view.ts'
import { answeringRuns, connected } from './connection-samples.ts'

export const choices: LinkChoices = {
  projects: [
    { id: 'cb-api', name: 'acme/api' },
    { id: 'cb-web', name: 'acme/web' }
  ],
  more: 0,
  unreadable: 0
}

export const matchedWeb: ScopeView = { kind: 'matched', project: { id: 'cb-web', name: 'acme/web' }, by: 'path', choices }
export const linkedApi: ScopeView = { kind: 'matched', project: { id: 'cb-api', name: 'acme/api' }, by: 'link', choices }
export const unmatchedGit: ScopeView = { kind: 'unmatched', registerFolder: 'C:/Projects/shop', choices }
export const unmatchedFolder: ScopeView = { kind: 'unmatched', choices }
export const remote: ScopeView = { kind: 'remote' }

/**
 * A stand-in for the worker that answers as `answeringRuns` does, and the scope requests with
 * `scope()` as it stands at each request, so a test can change it between them. Link, clear and
 * Register answer with `after()` when given.
 */
export function answeringScope(
  scope: () => ScopeView,
  runs: RunsView | ((request: RunsRequest) => RunsView),
  options: { connection?: ConnectionView; after?: () => ScopeAnswer } = {}
): MockHostOptions {
  const connection = options.connection ?? connected
  const base = answeringRuns(runs, connection)
  const answer = (): ScopeAnswer => ({ connection, scope: scope() })
  const press = (): ScopeAnswer => options.after?.() ?? answer()
  return {
    requests: {
      ...base.requests,
      'scope.read': answer,
      'scope.link': press,
      'scope.unlink': press,
      'scope.register': press,
      'workspace.open': null
    }
  }
}
