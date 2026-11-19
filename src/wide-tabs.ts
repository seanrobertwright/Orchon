// The wide tabs in the worker (#33, "The panel shell"): when one may open, and the pointer files
// behind it. The worker writes only inside `.orchon/` at the root of the focused local workspace,
// through the disk module opened on that folder alone: the folder, its `.gitignore` and its own
// pointer files. It sweeps a workspace's folder the first time that workspace is focused after the
// worker starts, and again on each write there; it touches nothing else there.
// A write that fails turns the wide tabs off for that workspace, with the reason, until the
// worker starts again.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import type { ConnectionView } from './connection-view'
import type { Disk } from './disk'
import { GITIGNORE_TEXT, POINTER_FOLDER, runPointerName, runPointerText, sweepPlan } from './pointer-files'
import type { FocusedWorkspace } from './project-scope'
import { errorText, parseOneText } from './records'
import { readRun } from './run-detail'
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
  const runId = parseOneText(input, { name: 'Open graph', shape: 'Open graph takes a run id.', key: 'runId', field: 'The run id', cap: RUN_ID_CAP })
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
  /** Why Open graph is off for a run with or without a project, or null when it is on. */
  graphOff(hasProject: boolean): Promise<string | null>
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

  /** The workspaces whose folder this worker has swept since it started, by id. */
  const swept = new Set<string>()

  /**
   * The start sweep: the focused workspace's folder, when it is local and not yet swept since the
   * worker started. It runs on start and on each change of focus, so a workspace focused after
   * start, or none focused at start, is swept once it is focused.
   */
  async function sweepFocused(): Promise<void> {
    const focused = await ports.focused()
    if (focused.kind !== 'local' || swept.has(focused.workspaceId)) return
    swept.add(focused.workspaceId)
    const folder = folderOf(focused.root)
    await sweep(ports.openDisk([folder]), folder)
  }

  const sweepLogged = (): Promise<void> =>
    sweepFocused().catch((error: unknown) => {
      orca.log(`Orchon could not sweep its tab files: ${errorText(error)}`)
    })

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
    const fetched = await readRun(ports.client, connection, request.runId, signal)
    if (fetched.kind !== 'run') return refused(fetched.kind === 'gone' ? RUN_GONE : fetched.message)
    const { run } = fetched
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
      return refused(`Orca could not open the tab: ${errorText(error)}`)
    }
    return { opened: true }
  }

  void sweepLogged()

  const subscriptions = [
    orca.panels.handle('graph.open', (input, context) => openGraph(parseGraphOpenRequest(input), context.signal)),
    orca.events.on('workspace.changed', sweepLogged)
  ]
  return {
    async graphOff(hasProject) {
      return (await offReason()) ?? (hasProject ? null : NO_PROJECT_GRAPH)
    },
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
