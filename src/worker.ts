// The resident worker. Orca starts it when the plugin is enabled, because the manifest has a
// status bar item beside `main`, and loads this file as written: there is no build step.
import type { OrcaWorkerApi } from 'orca/worker'
import { startArtifacts } from './artifacts'
import { startBuilder } from './builder'
import { startBuilderDrafts } from './builder-drafts'
import { startBuilderSave } from './builder-save'
import { startChatDelete } from './chat-delete'
import { startChatDrafts } from './chat-drafts'
import { conversationDraftKey } from './chat-drafts-view'
import { startChatLast } from './chat-last'
import { startChatList } from './chat-list'
import { startChatSend } from './chat-send'
import { createChatStreams } from './chat-stream'
import { startChatRun } from './chat-run'
import { startChatThread } from './chat-thread'
import { startConnection, type WorkerPorts } from './connection'
import { createConversationStreams } from './conversation-streams'
import { startLaunch } from './launch'
import { startMetrics } from './metrics'
import { realPorts } from './ports'
import { startProjectScope } from './project-scope'
import { createQuestionMemory } from './run-answer'
import { startRunControl } from './run-control'
import { startRunDetail } from './run-detail'
import { startRunGraph } from './run-graph'
import { startRunsTable } from './runs-table'
import { startSettingsForms } from './settings-forms'
import { startStepDetail } from './step-detail'
import { startWideTabs } from './wide-tabs'
import { startWorkflowsSection } from './workflows-section'

/**
 * Everything the worker does, on the ports it is given: the real ones in Orca, scripted ones in
 * the tests. Returns what stops it.
 */
export function start(orca: OrcaWorkerApi, ports: WorkerPorts): () => void {
  const connection = startConnection(orca, ports)
  // The status bar item's press, also in the palette. It never opens or closes the sidebar: an
  // open panel hears the hint and shows Runs, and one that mounts within a minute reads it.
  orca.commands.register('show-runs', () => {
    orca.panels.post('show-runs', connection.needsYou.press())
    return connection.showRunsSentence()
  })
  const projectScope = startProjectScope(orca, {
    client: connection.client,
    current: connection.current,
    platform: ports.platform,
    openDisk: ports.openDisk
  })
  const runsTable = startRunsTable(orca, { ...connection, workspaces: projectScope.workspaces })
  // The builder's drafts, which the tabs, the Workflows section and Open in builder share.
  const builderDrafts = startBuilderDrafts(orca, { timers: ports.timers, current: connection.current })
  const wideTabs = startWideTabs(orca, {
    client: connection.client,
    current: connection.current,
    focused: projectScope.focused,
    openDisk: ports.openDisk,
    now: ports.now,
    drafts: builderDrafts
  })
  // The question run detail last read for each run, which an answer is checked against.
  const questions = createQuestionMemory()
  const runDetail = startRunDetail(orca, {
    ...connection,
    workspaces: projectScope.workspaces,
    graphOff: wideTabs.graphOff,
    builderOff: wideTabs.builderOff,
    remote: async () => (await projectScope.focused()).kind === 'remote',
    questionRead: questions.read,
    now: ports.now
  })
  const artifacts = startArtifacts(orca, connection)
  const stepDetail = startStepDetail(orca, { client: connection.client, current: connection.current, now: ports.now, timers: ports.timers })
  const runControl = startRunControl(orca, { ...connection, questions })
  const runGraph = startRunGraph(orca, connection)
  const builder = startBuilder(orca, {
    client: connection.client,
    current: connection.current,
    workspaces: projectScope.workspaces,
    platform: ports.platform,
    drafts: builderDrafts
  })
  const builderSave = startBuilderSave(orca, { client: connection.client, current: connection.current, drafts: builderDrafts })
  // One reader per conversation stream, shared by the launch tracker and chat.
  const streams = createConversationStreams({ client: connection.client, log: (message) => orca.log(message) })
  const launch = startLaunch(orca, {
    client: connection.client,
    streams,
    failed: (notice) => connection.launchFailed(notice),
    current: connection.current,
    focused: projectScope.focused,
    onHint: (listener) => connection.onHint((hint) => listener(hint.types)),
    now: ports.now,
    timers: ports.timers,
    builderOff: wideTabs.builderOff
  })
  const workflows = startWorkflowsSection(orca, {
    client: connection.client,
    current: connection.current,
    focused: projectScope.focused,
    lists: launch.lists,
    builderOff: wideTabs.builderOff,
    drafts: builderDrafts,
    openIdentity: wideTabs.openIdentity
  })
  // Chat's leases on conversation streams, read through the same shared reader as the launcher's.
  const chatStreams = createChatStreams({ streams, now: ports.now, timers: ports.timers, hint: (hint) => orca.panels.post('chat.changed', hint) })
  const chatList = startChatList(orca, { client: connection.client, current: connection.current, chatStreams })
  const chatLast = startChatLast(orca, { now: ports.now })
  const chatThread = startChatThread(orca, { client: connection.client, current: connection.current, chatStreams, answered: chatLast.answered })
  const chatRun = startChatRun(orca, { client: connection.client, current: connection.current })
  const chatDrafts = startChatDrafts(orca, { timers: ports.timers })
  const chatSend = startChatSend(orca, { client: connection.client, current: connection.current, accepted: (key) => chatDrafts.clear(key) })
  const chatDelete = startChatDelete(orca, {
    client: connection.client,
    current: connection.current,
    removed(conversationId) {
      chatDrafts.clear(conversationDraftKey(conversationId))
      chatLast.forget(conversationId)
    }
  })
  const forms = startSettingsForms(orca, { client: connection.client, current: connection.current, now: ports.now })
  const metrics = startMetrics(orca, { client: connection.client, current: connection.current, now: ports.now, timers: ports.timers })
  return () => {
    launch.dispose()
    chatStreams.stop()
    streams.stop()
    workflows.dispose()
    chatList.dispose()
    chatThread.dispose()
    chatSend.dispose()
    chatRun.dispose()
    chatDelete.dispose()
    chatLast.dispose()
    chatDrafts.dispose()
    forms.dispose()
    metrics.dispose()
    wideTabs.dispose()
    runGraph.dispose()
    builder.dispose()
    builderSave.dispose()
    builderDrafts.dispose()
    projectScope.dispose()
    runsTable.dispose()
    runDetail.dispose()
    artifacts.dispose()
    stepDetail.dispose()
    runControl.dispose()
    connection.stop()
  }
}

let stop: (() => void) | undefined

export default function activate(orca: OrcaWorkerApi): void {
  stop = start(orca, realPorts())
}

/** Orca awaits this before it stops the worker: no timer or request outlives it. */
export function deactivate(): void {
  stop?.()
  stop = undefined
}
