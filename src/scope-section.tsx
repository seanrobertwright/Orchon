// The project scope in the panel: the scope switch at the top of the Runs section, the notice an
// unmatched or remote workspace gets, and Link and Register. It draws only the worker's scope
// view, reads it under the shared per-view fetch rules, and tells the Runs section when the
// project its table is filtered by changes.
import { atom, Button, Callout, Code, plugin, RadioGroup, read, Row, Select, set, Stack, Text, type OrcaNode, type PanelContext } from 'orca'
import type { ConnectionView } from './connection-view'
import { now } from './dates'
import { frameTimers } from './frame-timers'
import { REMOTE_WORKSPACE, type LinkChoices, type ScopeAnswer, type ScopeView } from './scope-view'
import { createViewFetch, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'

/** The scope the worker last answered, or null before its first answer. */
const scope = atom<ScopeView | null>(null)
/** Whether the scope has been asked once and answered or failed: the runs table waits for it. */
const settled = atom<boolean>(false)
/**
 * The person's own flip of the switch, kept for the plugin because Orca unmounts a hidden panel
 * and a flip sticks as the focus moves. It is stored as whatever was written, so it is parsed.
 */
const flipped = atom<unknown>('scope-choice', null, { persist: 'plugin' })
/** Link's chooser is open, and the project chosen in it. */
const choosing = atom<boolean>(false)
const chosen = atom<string | null>(null)
/** Register's confirmation is showing. */
const confirming = atom<boolean>(false)
/** Why the last press changed nothing, or null. */
const refused = atom<string | null>(null)

export type ScopeChoice = 'this' | 'all'

/** What the scope reads from the rest of the panel. */
export type ScopeHooks = {
  connection(): ConnectionView | null
  /** Whether a section that uses the scope is the one showing: only Runs does so far. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** The project the runs are filtered by changed, or the scope was first settled. */
  changed(): void
}

/** What the switch shows: "This project" only when the workspace is matched. */
export function scopeChoice(): ScopeChoice {
  const view = read(scope)
  if (view?.kind !== 'matched') return 'all'
  return read(flipped) === 'all' ? 'all' : 'this'
}

/** The Archon project the runs table is filtered by, or undefined under "All projects". */
export function scopedProjectId(): string | undefined {
  const view = read(scope)
  return view?.kind === 'matched' && scopeChoice() === 'this' ? view.project.id : undefined
}

/** Whether the runs table may read yet: once the scope is known, so it reads the right project. */
export function scopeSettled(): boolean {
  return read(settled)
}

let fetcher: ViewFetch | undefined
let hooks: ScopeHooks | undefined

/** Keeps a scope, and tells the Runs section when the project its table reads has changed. */
function keepScope(next: ScopeView): void {
  const before = scopedProjectId()
  const wasSettled = read(settled)
  set(scope, next)
  set(settled, true)
  if (!wasSettled || scopedProjectId() !== before) hooks?.changed()
}

/** Starts the scope's fetch rules for this panel run. They stop when the panel closes. */
export function startScope(ctx: PanelContext, given: ScopeHooks): void {
  hooks = given
  const view = createViewFetch<ScopeAnswer | null>({
    load(signal) {
      if (given.connection()?.kind !== 'connected' || !given.showing()) return Promise.resolve(null)
      return plugin.request('scope.read', undefined, { signal })
    },
    apply(answer) {
      if (answer === null) return
      given.keep(answer.connection)
      keepScope(answer.scope)
    },
    fail() {
      // Without a scope the runs table shows every project, as in an unmatched workspace.
      if (!read(settled)) {
        set(settled, true)
        given.changed()
      }
    },
    minGapMs: 0,
    safetyMs: SAFETY_REFETCH_MS,
    now,
    timers: frameTimers
  })
  fetcher = view
  // The focused workspace changed: the person moved, so the scope is read again at once.
  ctx.subscriptions.push(plugin.on('scope.changed', () => view.restart()))
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Reads the scope again at once. Nothing happens before the scope starts. */
export function restartScope(): void {
  fetcher?.restart()
}

function flip(value: string): void {
  if (value !== 'this' && value !== 'all') return
  const before = scopedProjectId()
  set(flipped, value)
  if (scopedProjectId() !== before) hooks?.changed()
}

/** A press's answer: what it refused, if anything, then the scope read again as after any write. */
function afterPress(answer: ScopeAnswer): void {
  hooks?.keep(answer.connection)
  set(refused, answer.refused ?? null)
  set(choosing, false)
  set(chosen, null)
  set(confirming, false)
  keepScope(answer.scope)
  restartScope()
}

function pressFailed(): void {
  set(refused, "Orchon's background process is not answering.")
}

function link(projectId: string): void {
  plugin.request('scope.link', { projectId }).then(afterPress, pressFailed)
}

function clearLink(): void {
  plugin.request('scope.unlink').then(afterPress, pressFailed)
}

function register(folder: string): void {
  plugin.request('scope.register', { folder }).then(afterPress, pressFailed)
}

/** The switch: "This project" names the Archon project, and is off when there is none. */
export function scopeSwitch(): OrcaNode {
  const view = read(scope)
  const project = view?.kind === 'matched' ? view.project : null
  const options =
    project === null
      ? [
          { value: 'this', label: 'This project', disabled: true },
          { value: 'all', label: 'All projects' }
        ]
      : [
          { value: 'this', label: 'This project', description: project.name },
          { value: 'all', label: 'All projects' }
        ]
  return <RadioGroup label="Scope" labelHidden orientation="horizontal" value={scopeChoice()} options={options} onChange={flip} />
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${String(count)} ${many}`
}

/** Link's chooser: the Archon projects by name, with a line for any that are not shown. */
function chooser(choices: LinkChoices, current: string | null, writable: boolean): OrcaNode {
  const picked = read(chosen)
  const options = choices.projects.filter((project) => project.id !== current).map((project) => ({ value: project.id, label: project.name }))
  return (
    <Stack gap="xs">
      <Select label="Archon project" placeholder="Choose a project" value={picked ?? undefined} options={options} onChange={(value) => set(chosen, value)} />
      {choices.more > 0 ? (
        <Text muted size="sm">
          {`${plural(choices.more, 'more Archon project is', 'more Archon projects are')} not shown. Open Archon's console to see every project.`}
        </Text>
      ) : null}
      {choices.unreadable > 0 ? (
        <Text muted size="sm">
          {`${plural(choices.unreadable, 'Archon project', 'Archon projects')} could not be read and ${choices.unreadable === 1 ? 'is' : 'are'} not shown.`}
        </Text>
      ) : null}
      <Row gap="sm">
        <Button size="sm" disabled={picked === null || !writable} onPress={() => (picked === null ? undefined : link(picked))}>
          Link
        </Button>
        <Button size="sm" variant="ghost" onPress={() => set(choosing, false)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

/** Register's confirmation: the exact folder that would be sent, and nothing sent until the press. */
function confirmation(folder: string, writable: boolean): OrcaNode {
  return (
    <Stack gap="xs">
      <Text>Register this folder with Archon?</Text>
      <Code>{folder}</Code>
      <Row gap="sm">
        <Button size="sm" disabled={!writable} onPress={() => register(folder)}>
          Register
        </Button>
        <Button size="sm" variant="ghost" onPress={() => set(confirming, false)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

function unmatchedNotice(view: Extract<ScopeView, { kind: 'unmatched' }>, writable: boolean): OrcaNode {
  const folder = view.registerFolder
  let body: OrcaNode
  if (read(choosing)) body = chooser(view.choices, null, writable)
  else if (folder !== undefined && read(confirming)) body = confirmation(folder, writable)
  else {
    body = (
      <Row gap="sm" wrap>
        <Button size="sm" variant="outline" disabled={!writable} onPress={() => set(choosing, true)}>
          Link to an existing Archon project
        </Button>
        {folder === undefined ? null : (
          <Button size="sm" variant="outline" disabled={!writable} onPress={() => set(confirming, true)}>
            Register with Archon
          </Button>
        )}
      </Row>
    )
  }
  return (
    <Callout tone="neutral">
      <Stack gap="sm">
        <Text>This Orca project is not known to Archon.</Text>
        {body}
      </Stack>
    </Callout>
  )
}

/** A link made by hand, with Change and Clear. */
function linkedLine(view: Extract<ScopeView, { kind: 'matched' }>, writable: boolean): OrcaNode {
  if (read(choosing)) return chooser(view.choices, view.project.id, writable)
  return (
    <Row gap="sm" wrap align="center">
      <Text muted size="sm">{`Linked by hand to ${view.project.name}.`}</Text>
      <Button size="sm" variant="ghost" disabled={!writable} onPress={() => set(choosing, true)}>
        Change link
      </Button>
      <Button size="sm" variant="ghost" disabled={!writable} onPress={clearLink}>
        Clear link
      </Button>
    </Row>
  )
}

/**
 * What shows under the switch: the notice, the link line, or why a press changed nothing. Link,
 * Register and the link line's buttons write, so they are off while `writable` is false.
 */
export function scopeNotice(writable: boolean): OrcaNode {
  const view = read(scope)
  const why = read(refused)
  let notice: OrcaNode = null
  if (view?.kind === 'remote') notice = <Callout tone="neutral">{REMOTE_WORKSPACE}</Callout>
  else if (view?.kind === 'unmatched') notice = unmatchedNotice(view, writable)
  else if (view?.kind === 'matched' && view.by === 'link') notice = linkedLine(view, writable)
  else if (view?.kind === 'failed') {
    notice = (
      <Callout tone="warning">
        <Stack gap="xs">
          <Text>{`Orchon could not read Archon's projects. ${view.message}`}</Text>
          <Row>
            <Button size="sm" variant="outline" onPress={restartScope}>
              Try again
            </Button>
          </Row>
        </Stack>
      </Callout>
    )
  }
  return (
    <>
      {why === null ? null : <Callout tone="warning">{why}</Callout>}
      {notice}
    </>
  )
}
