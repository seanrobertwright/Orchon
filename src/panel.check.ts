// `orca plugin check` renders the panel once per scenario. Orca itself never loads this file.
//
// Every scenario scripts the worker's connection answer. Check also starts the real worker, which
// looks for Archon on the machine it runs on: without a scripted answer, what a scenario drew
// would depend on whether an Archon happens to be running there.
import { defineCheck, hostError } from 'orca/testing'
import {
  answering,
  connected,
  connectedWithMetrics,
  noHome,
  notRunning,
  oneBadSetting,
  searching,
  systemRead,
  twoBadSettings,
  unsupported
} from '../scripts/connection-samples.ts'
import { formsWithEdits } from '../scripts/forms-samples.ts'
import { answeringRun, answeringRuns, busyRuns, busyRunsNeedingYou, sampleDetail } from '../scripts/runs-samples.ts'
import { answeringLaunch, webForm } from '../scripts/launch-samples.ts'
import { answeringWorkflows, draftedWorkflows, webWorkflows } from '../scripts/workflows-samples.ts'
import { answeringMetrics, sampleReport } from '../scripts/metrics-samples.ts'
import { answeringChats, sampleChats } from '../scripts/chat-samples.ts'
import { answeringThread, sampleDispatch, sampleResult, sampleThread, sampleThreadWith } from '../scripts/chat-thread-samples.ts'
import { answeringScope, matchedWeb, remote, unmatchedGit } from '../scripts/scope-samples.ts'
import type { RunsRequest } from './runs-view'

/**
 * Searching with data: the panel was Connected and has the runs table, then the worker says it
 * is Searching. A scenario cannot post, so the runs answer carries the newer state.
 */
const searchingWithRuns = {
  requests: {
    ...answeringRuns((request) => busyRuns(40, request)).requests,
    'runs.read': (request: RunsRequest) => ({
      connection: { ...searching, since: connected.since + 1 },
      runs: busyRuns(40, request)
    })
  }
}

/** Worker unreachable: Orca rejects the panel's requests to its worker as `unavailable`. */
const workerUnreachable = {
  requests: {
    ...answering(connected).requests,
    'connection.read': () => {
      throw hostError('unavailable')
    }
  }
}

/** Run detail, opened on a paused run of the busy list: the panel reopens on the run last shown. */
const onRun = { persisted: { workspace: { section: 'runs', openRun: 'run-1' } } }
const runDetail = answeringRun(
  (request) => busyRuns(40, request),
  () => ({ kind: 'ready', detail: sampleDetail(1) })
)
const runWaitingOnSubRuns = answeringRun(
  (request) => busyRuns(40, request),
  () => ({
    kind: 'ready',
    detail: sampleDetail(1, {
      waiting: {
        kind: 'children',
        children: [
          { id: 'run-7', workflow: 'workflow-7', status: 'running' },
          { id: 'run-8', workflow: null, status: null }
        ],
        more: 3
      }
    })
  })
)

const onSettings = { persisted: { workspace: { section: 'settings' } } }
const onMetrics = { persisted: { workspace: { section: 'metrics' } } }
const onLaunch = { persisted: { workspace: { section: 'launch' } } }
const onWorkflows = { persisted: { workspace: { section: 'workflows' } } }
const onChat = { persisted: { workspace: { section: 'chat' } } }

export default defineCheck({
  connected: answering(connected),
  'runs, empty': answering(connected),
  'runs, busy': answeringRuns((request) => busyRuns(140, request, 2)),
  'runs, busy with attention': answeringRuns((request) => busyRunsNeedingYou(140, 13, request)),
  // A press of "Orchon: Show runs" the worker remembers: the panel opens on the "Needs you" filter.
  'runs, needs you filter': {
    requests: {
      ...answeringRuns((request) => busyRunsNeedingYou(140, 13, request)).requests,
      'connection.read': { connection: connected, showRuns: { at: 1, needsYou: true } }
    }
  },
  'runs, this project': answeringScope(() => matchedWeb, (request) => busyRuns(40, request)),
  'runs, unmatched project': answeringScope(() => unmatchedGit, (request) => busyRuns(40, request)),
  'run detail': { ...runDetail, ...onRun },
  'run detail, waiting on sub-runs': { ...runWaitingOnSubRuns, ...onRun },
  'run detail, no longer exists': { ...answeringRun((request) => busyRuns(40, request), () => ({ kind: 'gone' })), ...onRun },
  'runs, remote workspace': answeringScope(() => remote, (request) => busyRuns(40, request)),
  'connected, reopened on settings': { ...answering(connected), ...onSettings },
  'searching with nothing loaded': answering(searching),
  'searching with data': searchingWithRuns,
  'worker unreachable': workerUnreachable,
  'not found, Archon is not running': answering(notRunning),
  'not found, no Archon home folder': answering(noHome),
  'bad setting, one refused': answering(oneBadSetting),
  'bad setting, two refused': answering(twoBadSettings),
  unsupported: answering(unsupported),
  launcher: { ...answeringLaunch({ launch: () => webForm }), ...onLaunch },
  'launcher, starting': {
    ...answeringLaunch({
      launch: () => ({ ...webForm, starting: { launchId: 'launch-1', workflow: 'deliver', project: 'acme/web', state: 'started', late: false } })
    }),
    ...onLaunch
  },
  'launcher, declared inputs': {
    ...answeringLaunch({
      launch: () => ({
        ...webForm,
        fields: {
          kind: 'ready',
          rows: [
            { name: 'target', required: true, description: 'What to deliver.', placeholder: '' },
            { name: 'branch', required: false, description: 'The branch to open from.', placeholder: 'main' }
          ]
        },
        values: { target: 'the fix' },
        bindings: [{ name: 'small', model: 'haiku' }]
      })
    }),
    ...onLaunch
  },
  'launcher, refused after a 200': {
    ...answeringLaunch({
      launch: () => ({
        ...webForm,
        starting: {
          launchId: 'launch-1',
          workflow: 'deliver',
          project: 'acme/web',
          state: 'refused',
          late: false,
          reason: "This workflow requires input 'target', and none was supplied."
        }
      })
    }),
    ...onLaunch
  },
  'launcher, unmatched project': { ...answeringLaunch({ launch: () => ({ ...webForm, codebaseId: null, workflows: { kind: 'none' }, workflow: null, description: '' }), scope: () => unmatchedGit }), ...onLaunch },
  workflows: { ...answeringWorkflows({ workflows: () => ({ ...webWorkflows, readFrom: 'C:/Projects/web' }) }), ...onWorkflows },
  'workflows with builder drafts': { ...answeringWorkflows({ workflows: () => draftedWorkflows }), ...onWorkflows },
  chat: { ...answeringChats((request) => sampleChats(8, request)), ...onChat },
  'chat, all projects at 50': { ...answeringChats((request) => sampleChats(50, request), { scope: () => unmatchedGit }), ...onChat },
  'chat, empty': { ...answeringChats((request) => sampleChats(0, request)), ...onChat },
  'chat thread': {
    ...answeringThread((request) => sampleThread(60, request, { unreadable: 1 })),
    persisted: { workspace: { section: 'chat', openChat: 'web-chat-0' } }
  },
  'chat thread with a workflow dispatch and its result': {
    ...answeringThread(sampleThreadWith(3, sampleResult(), sampleDispatch('web-worker-5'))),
    persisted: { workspace: { section: 'chat', openChat: 'web-chat-0' } }
  },
  'metrics without the metrics paths': { ...answering(connected), ...onMetrics },
  'metrics with the metrics paths': { ...answering(connectedWithMetrics), ...onMetrics },
  'metrics details': { ...answeringMetrics(() => sampleReport('7d', undefined, { more: 4 })), ...onMetrics },
  'metrics, timed out': { ...answeringMetrics(() => ({ kind: 'timeout' })), ...onMetrics },
  'settings while searching, with data': { ...answering(searching, systemRead), ...onSettings },
  'settings with unsaved edits and an outside change': { ...answering(connected, systemRead, formsWithEdits), ...onSettings },
  'settings while not found': { ...answering(notRunning), ...onSettings },
  'settings while unsupported': { ...answering(unsupported), ...onSettings },
  'settings with two refused settings': { ...answering(twoBadSettings), ...onSettings }
})
