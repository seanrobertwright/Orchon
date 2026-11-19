// The wide tabs in the worker (#33, "The panel shell"): when one may open, and the pointer files
// behind it. The worker writes only inside `.orchon/` at the root of the focused local workspace,
// through the disk module opened on that folder alone: the folder, its `.gitignore` and its own
// pointer files. On start and on each write it sweeps the focused workspace's folder; it touches nothing else there.
// A write that fails turns the wide tabs off for that workspace, with the reason, until the
// worker starts again.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import type { ConnectionView } from './connection-view'
import type { Disk } from './disk'
import { GITIGNORE_TEXT, POINTER_FOLDER, runPointerName, runPointerText, sweepPlan } from './pointer-files'
import type { FocusedWorkspace } from './project-scope'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, own, refuseRequest } from './records'
import { parseRunDetail, RUN_PATH } from './run-detail'
import { RUN_ID_CAP } from './run-detail-view'
import { REMOTE_WORKSPACE } from './scope-view'
import type { GraphOpenAnswer, GraphOpenRequest } from './wide-tabs-view'

export type { GraphOpenAnswer } from './wide-tabs-view'

export const NO_WORKSPACE_TAB = 'No workspace is focused in Orca. Wide tabs open in a workspace on this computer.'
export const NO_PROJECT_GRAPH = 'This run has no Archon project, so it has no graph.'
export const WRITE_FAILED =
  'Orchon could not write its tab file into .orchon/ in this workspace, so wide tabs are off here until Orca restarts the plugin.'
const NOT_CONNECTED = 'Orchon is not connected to Archon.'
const RUN_GONE = 'This run no longer exists.'

/** The longest `.gitignore` the worker reads back before it decides to write its own. */
const GITIGNORE_CAP_BYTES = 1024

/** Open graph's input, or a refusal: a run id of 1 to the cap and nothing else. */
export function parseGraphOpenRequest(input: unknown): GraphOpenRequest {
  if (!isRecord(input)) refuseRequest('Open graph takes a run id.')
  const runId = own(input, 'runId')
  if (!isCappedText(runId, RUN_ID_CAP)) refuseRequest(cappedTextRefusal('The run id', RUN_ID_CAP))
  for (const key of Object.keys(input)) if (key !== 'runId') refuseRequest(`Open graph does not take ${key}.`)
  return { runId }
}

/** A folder with no separator at its end, so a name can follow a `/`. Windows reads `/` too. */
const folderOf = (root: string): string => `${root.replace(/[\\/]+$/, '')}/${POINTER_FOLDER}`

export type WideTabsPorts = {
  client: Client
  current(): Promise<ConnectionView>
  focused(): Promise<FocusedWorkspace>
  openDisk(roots: readonly string[]): Disk
  now(): number
}

export type WideTabs = Disposable & {
  /** Why a wide tab cannot open in the focused workspace now, or null when one can. */
  offReason(): Promise<string | null>
}

export function startWideTabs(orca: OrcaWorkerApi, ports: WideTabsPorts): WideTabs {
  /** The workspaces whose last write failed, by id, with the reason. */
  const off = new Map<string, string>()

  /** Deletes what the sweep plan names. A delete that fails is passed over and tried at the next sweep. */
  async function sweep(disk: Disk, folder: string, keep?: string): Promise<void> {
    const entries = await disk.listFolder(folder)
    if (entries === null) return
    for (const name of sweepPlan(entries, ports.now(), keep)) {
      if ((await disk.remove(`${folder}/${name}`)) !== 'ok') orca.log(`Orchon could not delete ${name} in ${folder}.`)
    }
  }

  /** The start sweep: the focused workspace's folder, when it is local. */
  async function sweepFocused(): Promise<void> {
    const focused = await ports.focused()
    if (focused.kind !== 'local') return
    const folder = folderOf(focused.root)
    await sweep(ports.openDisk([folder]), folder)
  }

  async function offReason(): Promise<string | null> {
    const focused = await ports.focused()
    if (focused.kind === 'none') return NO_WORKSPACE_TAB
    if (focused.kind === 'remote') return REMOTE_WORKSPACE
    return off.get(focused.workspaceId) ?? null
  }

  /** Writes the folder, its `.gitignore` and the pointer file. False when a write failed. */
  async function writePointer(disk: Disk, folder: string, name: string, text: string): Promise<boolean> {
    if ((await disk.makeFolder(folder)) !== 'ok') return false
    const ignore = await disk.readText(`${folder}/.gitignore`, GITIGNORE_CAP_BYTES)
    if (!(ignore.kind === 'text' && ignore.text === GITIGNORE_TEXT)) {
      if ((await disk.writeText(`${folder}/.gitignore`, GITIGNORE_TEXT)) !== 'ok') return false
    }
    return (await disk.writeText(`${folder}/${name}`, text)) === 'ok'
  }

  async function openGraph(request: GraphOpenRequest, signal: AbortSignal): Promise<GraphOpenAnswer> {
    const refused = (reason: string): GraphOpenAnswer => ({ opened: false, reason })
    const connection = await ports.current()
    if (connection.kind !== 'connected') return refused(NOT_CONNECTED)
    const focused = await ports.focused()
    if (focused.kind !== 'local') return refused(focused.kind === 'none' ? NO_WORKSPACE_TAB : REMOTE_WORKSPACE)
    const held = off.get(focused.workspaceId)
    if (held !== undefined) return refused(held)
    const answer = await ports.client.request({
      baseUrl: connection.baseUrl,
      path: `${RUN_PATH}${encodeURIComponent(request.runId)}`,
      timeout: 'read',
      signal
    })
    if (!answer.ok) {
      return refused(answer.failure.kind === 'status' && answer.failure.status === 404 ? RUN_GONE : readFailureText(answer.failure))
    }
    const run = parseRunDetail(answer.value)
    if (run === null) return refused(unreadableAnswerText(connection.version))
    if (run.codebaseId === null) return refused(NO_PROJECT_GRAPH)
    const folder = folderOf(focused.root)
    const name = runPointerName(run.workflow, run.id)
    const disk = ports.openDisk([folder])
    if (!(await writePointer(disk, folder, name, runPointerText(run.id)))) {
      off.set(focused.workspaceId, WRITE_FAILED)
      return refused(WRITE_FAILED)
    }
    await sweep(disk, folder, name)
    try {
      await orca.host.call('editor.open', { workspaceId: focused.workspaceId, path: `${POINTER_FOLDER}/${name}` })
    } catch (error) {
      return refused(`Orca could not open the tab: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { opened: true }
  }

  void sweepFocused().catch((error: unknown) => {
    orca.log(`Orchon could not sweep its tab files: ${error instanceof Error ? error.message : String(error)}`)
  })

  const subscription = orca.panels.handle('graph.open', (input, context) => openGraph(parseGraphOpenRequest(input), context.signal))
  return {
    offReason,
    dispose() {
      subscription.dispose()
    }
  }
}
