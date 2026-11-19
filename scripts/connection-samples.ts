// One connection state of each kind, as the worker would answer it, for the panel's tests and
// for the scenarios of `orca plugin check`. It is development tooling: Orca never loads it.
import type {
  BadSetting,
  Connected,
  ConnectionView,
  NotFound,
  Searching,
  SettingsView,
  Unsupported
} from '../src/connection-view.ts'
import type { FormsAnswer, FormsView } from '../src/forms-view.ts'
import type { LaunchAnswer, LaunchView } from '../src/launch-view.ts'
import { EMPTY_COUNTS, type RunsAnswer, type RunsRequest, type RunsView } from '../src/runs-view.ts'
import type { ScopeAnswer } from '../src/scope-view.ts'
import type { SystemAnswer, SystemView } from '../src/system-view.ts'
import { formsRead, formsUnread } from './forms-samples.ts'

export const HOME = '/home/ada/.archon'
export const OTHER_HOME = '/srv/archon-home'
const UNSET: SettingsView = { baseUrl: '', archonHome: '', homeFolder: HOME }

export const searching: Searching = { kind: 'searching', since: 10, settings: UNSET }

export const connected: Connected = {
  kind: 'connected',
  since: 20,
  settings: UNSET,
  baseUrl: 'http://127.0.0.1:3090',
  source: 'default',
  version: '0.12.1',
  storeId: '00000000-0000-4000-8000-000000000000',
  features: { metrics: false },
  live: true
}

/** Connected to a server whose path list has the metrics paths. */
export const connectedWithMetrics: Connected = { ...connected, version: '0.14.0', features: { metrics: true } }

export const connectedFromRecord: Connected = { ...connected, baseUrl: 'http://127.0.0.1:4100', source: 'server-json' }

/** Not found, home folder exists: the "not running" wording. */
export const notRunning: NotFound = {
  kind: 'not-found',
  since: 30,
  settings: UNSET,
  address: 'http://127.0.0.1:3090',
  source: 'default',
  home: 'exists'
}

export const notRunningAtSetting: NotFound = {
  ...notRunning,
  settings: { ...UNSET, baseUrl: 'http://localhost:4000' },
  address: 'http://localhost:4000',
  source: 'setting',
  home: 'unchecked'
}

export const notRunningAtRecord: NotFound = { ...notRunning, address: 'http://127.0.0.1:4100', source: 'server-json' }

/** Not found, home folder missing: the "could not find Archon" wording. */
export const noHome: NotFound = { ...notRunning, home: 'missing' }

export const noHomeFromSetting: NotFound = {
  ...noHome,
  settings: { baseUrl: '', archonHome: OTHER_HOME, homeFolder: OTHER_HOME }
}

export const oneBadSetting: BadSetting = {
  kind: 'bad-setting',
  since: 40,
  settings: { baseUrl: 'https://archon.example.com:3090', archonHome: '', homeFolder: HOME },
  refused: [
    {
      key: 'baseUrl',
      value: 'https://archon.example.com:3090',
      reason: 'The address must start with `http://`.'
    }
  ]
}

export const twoBadSettings: BadSetting = {
  kind: 'bad-setting',
  since: 50,
  settings: { baseUrl: 'http://192.168.1.20:3090', archonHome: 'archon', homeFolder: null },
  refused: [
    {
      key: 'baseUrl',
      value: 'http://192.168.1.20:3090',
      reason: 'Orchon works only with an Archon on this computer. Use `127.0.0.1`, `localhost` or `[::1]`.'
    },
    { key: 'archonHome', value: 'archon', reason: 'The folder must be a full path.' }
  ]
}

/** A server that answers health and lacks a required path, as a release before the floor does. */
export const unsupported: Unsupported = {
  kind: 'unsupported',
  since: 60,
  settings: UNSET,
  baseUrl: 'http://127.0.0.1:3090',
  source: 'default',
  version: '0.11.1'
}

export const unsupportedAtSetting: Unsupported = {
  ...unsupported,
  settings: { ...UNSET, baseUrl: 'http://localhost:4000' },
  baseUrl: 'http://localhost:4000',
  source: 'setting',
  version: null
}

/** The System group before health has answered. */
export const systemUnread: SystemView = {
  since: 5,
  health: null,
  readAt: null,
  failure: null,
  updates: { kind: 'checking' }
}

/** The System group as the worker answers it from a floor release with a newer one out. */
export const systemRead: SystemView = {
  since: 25,
  health: {
    status: 'ok',
    adapter: 'web',
    database: null,
    version: '0.12.1',
    storeId: '00000000-0000-4000-8000-000000000000',
    concurrency: { active: 2, max: 10 },
    runningWorkflows: 1,
    platforms: { names: ['Web'], more: 0 }
  },
  readAt: 20,
  failure: null,
  updates: {
    kind: 'available',
    version: '0.14.0',
    releaseUrl: 'https://github.com/coleam00/Archon/releases/tag/v0.14.0'
  }
}

/** No runs at all, as the worker answers the runs table of an Archon that has run nothing. */
export const noRuns: Extract<RunsView, { kind: 'ready' }> = { kind: 'ready', counts: EMPTY_COUNTS, total: 0, rows: [], unreadable: 0 }

type Answers = {
  'connection.read': { connection: ConnectionView }
  'connection.retry': { connection: ConnectionView }
  'runs.read': (request: RunsRequest) => RunsAnswer
  'system.open': SystemAnswer
  'system.refresh': SystemAnswer
  'system.close': null
  'scope.read': ScopeAnswer
  'forms.read': FormsAnswer
  'forms.edit': FormsAnswer
  'forms.discard': FormsAnswer
  'forms.save': FormsAnswer
  'forms.resolve': FormsAnswer
  'launch.read': LaunchAnswer
}

/** The launcher of an Archon with no projects: nothing to choose, nothing typed. */
export const noProjectsLaunch: LaunchView = {
  kind: 'ready',
  projects: { rows: [], more: 0, unreadable: 0 },
  codebaseId: null,
  workflows: { kind: 'none' },
  workflow: null,
  description: '',
  inputs: { kind: 'ready', rows: [] },
  message: '',
  posting: false
}

/**
 * A stand-in for the worker that answers every connection request with one state, the runs table
 * as `runs` says, and every System and forms request with one view: by default the read one while
 * Connected and the unread one otherwise.
 */
export function answeringRuns(
  runs: RunsView | ((request: RunsRequest) => RunsView),
  connection: ConnectionView = connected,
  system: SystemView = connection.kind === 'connected' ? systemRead : systemUnread,
  forms: FormsView = connection.kind === 'connected' ? formsRead : formsUnread
): { requests: Answers } {
  const formsAnswer: FormsAnswer = { connection, forms }
  return {
    requests: {
      'connection.read': { connection },
      'connection.retry': { connection },
      'runs.read': (request) => ({ connection, runs: typeof runs === 'function' ? runs(request) : runs }),
      'system.open': { connection, system },
      'system.refresh': { connection, system },
      'system.close': null,
      // No workspace is focused, so the Runs section shows every project.
      'scope.read': { connection, scope: { kind: 'no-workspace' } },
      'forms.read': formsAnswer,
      'forms.edit': formsAnswer,
      'forms.discard': formsAnswer,
      'forms.save': formsAnswer,
      'forms.resolve': formsAnswer,
      'launch.read': { connection, launch: connection.kind === 'connected' ? noProjectsLaunch : { kind: 'not-connected' }, notices: [] }
    }
  }
}

/**
 * A stand-in for the worker that answers every connection request with one state, the runs table
 * with no runs, and every System and forms request as `answeringRuns` does.
 */
export const answering = (connection: ConnectionView, system?: SystemView, forms?: FormsView): { requests: Answers } =>
  answeringRuns(noRuns, connection, system, forms)
