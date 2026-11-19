// The Launch section of the panel: the form (a project, a workflow, a message and Start), the
// Starting view that replaces it after Start, and the callout at the top of the panel for a run a
// launch started while its Starting view no longer showed. It draws only the worker's view model,
// reads it under the shared per-view fetch rules, and keeps nothing of its own but what the person
// is typing, because the draft and the launches live in the worker.
import {
  atom,
  Button,
  Callout,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  type OrcaNode,
  type PanelContext
} from 'orca'
import type { Connected, ConnectionView } from './connection-view'
import { now } from './dates'
import { frameTimers } from './frame-timers'
import {
  FILTER_FROM,
  LOOKING_TEXT,
  MESSAGE_CAP,
  QUEUED_TEXT,
  RECORDS_CAP,
  WORKFLOWS_CAP,
  type LaunchAnswer,
  type LaunchEdit,
  type LaunchNotice,
  type LaunchRequest,
  type LaunchView,
  type NoticesAnswer,
  type StartingView,
  type WorkflowsView
} from './launch-view'
import { createViewFetch, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { problemLine, type ReadProblem } from './view-notices'
import { NOT_CONNECTED_TEXT, offersTryAgain, troubleText } from './worker-words'

type Ready = Extract<LaunchView, { kind: 'ready' }>

/** The worker's last answer for the section, or null before its first. */
const loaded = atom<LaunchView | null>(null)
const problem = atom<ReadProblem | null>(null)
const lastGood = atom<number | null>(null)
/** The message as typed, or null to show the worker's draft. */
const typed = atom<string | null>(null)
const search = atom<string>('')
const filter = atom<string>('')
/** A Start sent and not answered: a second press is ignored. */
const posting = atom<boolean>(false)
/** The callouts of runs launches started. */
const notices = atom<LaunchNotice[]>([])
/**
 * Whether a launch from this workspace still looks for its run or has a callout, kept because Orca
 * unmounts a hidden panel: a panel that mounts again asks for the callouts only then.
 */
const pending = atom<unknown>('launch-pending', false, { persist: 'workspace' })
/** The callouts dismissed in this panel run, so an answer sent before the dismiss cannot bring one back. */
const dismissed = atom<readonly string[]>([])

/** How long the panel waits after the last keystroke before it gives the worker the draft. */
export const DRAFT_PAUSE_MS = 500
/** The least time between two reads of the section that no person asked for. */
const LAUNCH_GAP_MS = 1_000

/** What the section reads from the rest of the panel. */
export type LaunchSectionHooks = {
  connection(): ConnectionView | null
  /** Whether the Launch section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** The panel's project: the Archon project of "This project", or undefined. */
  project(): string | undefined
  /** Whether the project scope is known, so the default project is the right one. */
  settled(): boolean
  /** Shows a run's detail in the Runs section. */
  openRun(runId: string): void
}

let fetcher: ViewFetch | undefined
let hooks: LaunchSectionHooks | undefined
/** The next read asks the worker to read Archon again: the section opened, or Refresh. */
let reload = true
let draftTimer: unknown
let searchTimer: unknown

/** A search or filter typed: the section is read again after a pause, so a keystroke is not a request. */
function searchAfterPause(): void {
  if (searchTimer !== undefined) frameTimers.clear(searchTimer)
  searchTimer = frameTimers.set(() => {
    searchTimer = undefined
    fetcher?.restart()
  }, DRAFT_PAUSE_MS)
}

function report(message: string, tryAgain = true): void {
  set(problem, { message, lastGood: read(lastGood), tryAgain })
}

/** A run found while its Starting view still shows: its detail opens, and it needs no callout. */
function openFound(view: LaunchView): void {
  if (view.kind !== 'ready' || view.starting?.state !== 'found' || view.starting.runId === undefined) return
  if (hooks?.showing() !== true) return
  const { launchId, runId } = view.starting
  hooks.openRun(runId)
  dismiss(launchId)
}

function apply(answer: LaunchAnswer | null): void {
  if (answer === null) return
  hooks?.keep(answer.connection)
  set(loaded, answer.launch)
  set(notices, answer.notices)
  set(problem, null)
  set(lastGood, now())
  openFound(answer.launch)
}

function keepNotices(answer: NoticesAnswer): void {
  hooks?.keep(answer.connection)
  set(notices, answer.notices)
  set(pending, answer.looking > 0 || answer.notices.length > 0)
}

/** Reads the callouts. A failed read changes nothing. */
function readNotices(): void {
  plugin.request('launch.notices').then(keepNotices, () => {})
}

function dismiss(launchId: string): void {
  set(dismissed, [...read(dismissed), launchId].slice(-RECORDS_CAP))
  plugin.request('launch.dismiss', { launchId }).then(keepNotices, () => {})
}

/** Starts the section's fetch rules for this panel run. They stop when the panel closes. */
export function startLaunchSection(ctx: PanelContext, given: LaunchSectionHooks): void {
  hooks = given
  reload = true
  const view = createViewFetch<LaunchAnswer | null>({
    load(signal) {
      if (given.connection()?.kind !== 'connected' || !given.showing() || !given.settled()) return Promise.resolve(null)
      const request: LaunchRequest = {}
      const project = given.project()
      if (project !== undefined) request.project = project
      if (read(search) !== '') request.search = read(search)
      if (read(filter) !== '') request.filter = read(filter)
      if (reload) request.reload = true
      reload = false
      return plugin.request('launch.read', request, { signal })
    },
    apply,
    fail(_error, trouble) {
      if (trouble !== null) report(troubleText(trouble), offersTryAgain(trouble))
    },
    minGapMs: LAUNCH_GAP_MS,
    safetyMs: () => SAFETY_REFETCH_MS,
    now,
    timers: frameTimers
  })
  fetcher = view
  // A launch changed: the Starting view, or a callout, has news.
  ctx.subscriptions.push(
    plugin.on('launch.changed', () => {
      view.restart()
      readNotices()
    })
  )
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (draftTimer !== undefined) frameTimers.clear(draftTimer)
      if (searchTimer !== undefined) frameTimers.clear(searchTimer)
      draftTimer = undefined
      searchTimer = undefined
      if (fetcher === view) fetcher = undefined
    }
  })
  if (read(pending) === true) readNotices()
}

/** The section began to show, or Refresh: the lists are read from Archon again. */
export function openLaunch(): void {
  reload = true
  fetcher?.restart()
}

/** Reads the section again at once, as when the project scope changed. */
export function restartLaunch(): void {
  fetcher?.restart()
}

/** Whether the section holds an answer to show, as Searching keeps it under its banner. */
export function launchHasData(): boolean {
  return read(loaded) !== null
}

/** A different Archon store: what the section held belongs to the old one. */
export function clearLaunch(): void {
  set(loaded, null)
  set(problem, null)
  set(notices, [])
  set(typed, null)
}

function edit(change: LaunchEdit): void {
  plugin.request('launch.edit', change).then(apply, () => {})
}

/** The message as typed goes to the worker's draft after a pause, so a keystroke is not a request. */
function typeMessage(text: string): void {
  set(typed, text)
  if (draftTimer !== undefined) frameTimers.clear(draftTimer)
  draftTimer = frameTimers.set(() => {
    draftTimer = undefined
    edit({ message: text })
  }, DRAFT_PAUSE_MS)
}

function messageOf(view: Ready): string {
  return read(typed) ?? view.message
}

/** Start: sent once. A press while one is posted is ignored. */
function start(view: Ready, message: string): void {
  if (read(posting) || view.codebaseId === null || view.workflow === null) return
  if (draftTimer !== undefined) frameTimers.clear(draftTimer)
  draftTimer = undefined
  set(posting, true)
  plugin
    .request('launch.start', { codebaseId: view.codebaseId, workflow: view.workflow, message })
    .then(
      (answer) => {
        apply(answer)
        if (answer.launch.kind === 'ready' && answer.launch.starting !== undefined) {
          set(typed, null)
          set(pending, true)
        }
      },
      () => report("Orchon's background process did not answer, so it is not known whether the run started. Check the Runs section.", false)
    )
    .finally(() => set(posting, false))
}

function another(): void {
  plugin.request('launch.another').then(apply, () => {})
}

function keepWaiting(launchId: string): void {
  plugin.request('launch.wait', { launchId }).then(apply, () => {})
}

/** Why Start is off, or null when it may be pressed. */
function startReason(view: Ready, message: string, writable: boolean): string | null {
  if (!writable) return NOT_CONNECTED_TEXT
  if (view.codebaseId === null) return 'Choose a project.'
  if (view.workflow === null) return 'Choose a workflow.'
  if (message.trim() === '') return 'Type a message.'
  if (message.length > MESSAGE_CAP) return 'The message is longer than 16,000 characters.'
  if (read(posting) || view.posting) return 'Starting…'
  return null
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${String(count)} ${many}`
}

function workflowPart(view: Ready): OrcaNode {
  const workflows: WorkflowsView = view.workflows
  if (workflows.kind === 'none') {
    return <Select label="Workflow" placeholder="Choose a project first" options={[]} disabled />
  }
  if (workflows.kind === 'too-large') return <Text>Archon's workflow list for this project is too large to show.</Text>
  if (workflows.kind === 'failed') return <Text>{`Orchon could not read the workflows. ${workflows.message}`}</Text>
  const options = workflows.rows.map((row) => ({ value: row.name, label: row.recommended ? `${row.name} (recommended)` : row.name }))
  const hidden = Math.max(0, workflows.matching - WORKFLOWS_CAP)
  return (
    <Stack gap="xs">
      {workflows.total > FILTER_FROM ? (
        <Input
          label="Filter workflows"
          type="search"
          value={read(filter)}
          maxLength={200}
          onChange={(value) => {
            set(filter, value)
            searchAfterPause()
          }}
        />
      ) : null}
      <Select
        label="Workflow"
        placeholder="Choose a workflow"
        value={view.workflow ?? undefined}
        options={options}
        onChange={(value) => edit({ workflow: value })}
      />
      {view.description === '' ? null : (
        <Text muted size="sm">
          {view.description}
        </Text>
      )}
      {hidden > 0 ? (
        <Text muted size="sm">
          {`${plural(hidden, 'more workflow matches', 'more workflows match')} and ${hidden === 1 ? 'is' : 'are'} not shown. Filter to narrow the list.`}
        </Text>
      ) : null}
      {workflows.unreadable > 0 ? (
        <Text muted size="sm">
          {`${plural(workflows.unreadable, 'workflow', 'workflows')} could not be read and ${workflows.unreadable === 1 ? 'is' : 'are'} not shown.`}
        </Text>
      ) : null}
    </Stack>
  )
}

function form(view: Ready, writable: boolean): OrcaNode {
  const message = messageOf(view)
  const reason = startReason(view, message, writable)
  const { projects } = view
  return (
    <Stack gap="sm">
      <Input
        label="Search projects"
        type="search"
        value={read(search)}
        maxLength={200}
        onChange={(value) => {
          set(search, value)
          searchAfterPause()
        }}
      />
      <Select
        label="Project"
        placeholder="Choose a project"
        value={view.codebaseId ?? undefined}
        options={projects.rows.map((project) => ({ value: project.id, label: project.name }))}
        onChange={(value) => edit({ codebaseId: value })}
      />
      {projects.more > 0 ? (
        <Text muted size="sm">
          {`${plural(projects.more, 'more Archon project is', 'more Archon projects are')} not shown. Search to find one.`}
        </Text>
      ) : null}
      {projects.unreadable > 0 ? (
        <Text muted size="sm">
          {`${plural(projects.unreadable, 'Archon project', 'Archon projects')} could not be read and ${projects.unreadable === 1 ? 'is' : 'are'} not shown.`}
        </Text>
      ) : null}
      {workflowPart(view)}
      <Textarea label="Message" rows={6} maxLength={MESSAGE_CAP} value={message} onChange={typeMessage} />
      <Text muted size="sm">
        To attach a file, save it in the project and name its path in the message.
      </Text>
      {view.error === undefined ? null : (
        <Callout tone="danger" title="The run did not start">
          <Text>{view.error}</Text>
        </Callout>
      )}
      <Row gap="sm" align="center" wrap>
        <Button disabled={reason !== null} onPress={() => start(view, message)}>
          Start
        </Button>
        {reason === null ? null : (
          <Text muted size="sm">
            {reason}
          </Text>
        )}
      </Row>
    </Stack>
  )
}

function startingView(starting: StartingView): OrcaNode {
  let line: OrcaNode
  if (starting.state === 'found') line = <Text>The run has started.</Text>
  else if (starting.late) line = <Text>Archon has not shown the run after a minute.</Text>
  else if (starting.state === 'queued') line = <Spinner label={QUEUED_TEXT} />
  else if (starting.state === 'looking') line = <Spinner label={LOOKING_TEXT} />
  else line = <Spinner label="Starting the run…" />
  const runId = starting.runId
  return (
    <Stack gap="sm">
      <Text weight="semibold">{starting.workflow}</Text>
      <Text muted>{starting.project}</Text>
      {line}
      <Row gap="sm" wrap>
        {runId === undefined ? null : (
          <Button size="sm" onPress={() => hooks?.openRun(runId)}>
            Open run
          </Button>
        )}
        {starting.late && runId === undefined ? (
          <Button size="sm" variant="outline" onPress={() => keepWaiting(starting.launchId)}>
            Keep waiting
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onPress={another}>
          Launch another
        </Button>
      </Row>
    </Stack>
  )
}

/**
 * The section while connected or under the Searching banner. `writable` is false when Start is
 * off. `notice` is the project scope's notice: the unmatched one with Link and Register, or the
 * remote one, under which there is no launcher.
 */
export function launchSection(_state: Connected, writable: boolean, notice: OrcaNode): OrcaNode {
  const view = read(loaded)
  const held = read(problem)
  let body: OrcaNode
  if (view === null) body = held === null ? <Spinner label="Loading the launcher…" /> : null
  else if (view.kind === 'remote' || view.kind === 'not-connected') body = null
  else if (view.kind === 'failed') body = <Text>{`Orchon could not read Archon's projects. ${view.message}`}</Text>
  else if (view.starting !== undefined) body = startingView(view.starting)
  else body = form(view, writable)
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center">
        <IconButton icon="refresh" label="Refresh the launcher" onPress={openLaunch} />
      </Row>
      {notice}
      {held === null ? null : problemLine(held, view !== null, openLaunch)}
      {body}
    </Stack>
  )
}

/**
 * The callouts at the top of the panel: one per run a launch started after its Starting view
 * stopped showing, with Open run and dismiss. At most the worker's 20 launch records.
 */
export function launchNotices(): OrcaNode {
  const view = read(loaded)
  // The run its Starting view shows opens there, so it needs no callout.
  const showing = hooks?.showing() === true && view?.kind === 'ready' ? view.starting?.launchId : undefined
  const gone = read(dismissed)
  const shown = read(notices).filter((notice) => notice.launchId !== showing && !gone.includes(notice.launchId))
  if (shown.length === 0) return null
  return (
    <Stack gap="xs">
      {shown.map((notice) => (
        <Callout key={notice.launchId} tone="accent" icon="info">
          <Row gap="sm" align="center" wrap>
            <Text>{`Your run of ${notice.workflow} has started`}</Text>
            <Button
              size="sm"
              onPress={() => {
                hooks?.openRun(notice.runId)
                dismiss(notice.launchId)
              }}
            >
              Open run
            </Button>
            <IconButton icon="close" label={`Dismiss: your run of ${notice.workflow} has started`} onPress={() => dismiss(notice.launchId)} />
          </Row>
        </Callout>
      ))}
    </Stack>
  )
}
