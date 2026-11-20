// The Workflows section of the panel (#16): its own project select, the workflows Archon lists with
// where each comes from, Open in builder, and Delete of a project or global workflow behind an
// inline confirmation, New workflow, and the builder drafts: a mark on each workflow that has one
// and the new workflows never saved, each with Open and Discard.
// It draws only the worker's view model and reads it under the shared per-view fetch rules.
import { atom, Button, Callout, IconButton, Input, Link, plugin, RadioGroup, read, Row, Select, set, shell, Spinner, Stack, Text, type OrcaNode, type PanelContext } from 'orca'
import { identityOf, sameIdentity, WORKFLOW_NAME_CAP, type NewWorkflowPlace } from '../editors/builder/builder-view'
import type { Connected, ConnectionView } from './connection-view'
import { now } from './dates'
import { frameTimers } from './frame-timers'
import { plural } from './plural'
import { createViewFetch, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'
import { problemLine, type ReadProblem } from './view-notices'
import { NOT_CONNECTED_TEXT, offersTryAgain, troubleText } from './worker-words'
import {
  SECTION_SEARCH_CAP,
  SECTION_WORKFLOWS_CAP,
  type DeleteAnswer,
  type DeleteOutcome,
  type NewDraftRow,
  type SectionDrafts,
  type SectionList,
  type SectionWorkflow,
  type WorkflowsAnswer,
  type WorkflowsRequest,
  type WorkflowsSectionView
} from './workflows-section-view'

type Ready = Extract<WorkflowsSectionView, { kind: 'ready' }>

/** The project select's value for no project. Archon's project ids are hexadecimal, so none is this. */
export const NO_PROJECT = 'no-project'

/** The worker's last answer for the section, or null before its first. */
const loaded = atom<WorkflowsSectionView | null>(null)
const problem = atom<ReadProblem | null>(null)
const lastGood = atom<number | null>(null)
/** The project chosen here: undefined follows the panel's project, null is no project. */
const chosen = atom<string | null | undefined>(undefined)
const projectSearch = atom<string>('')
const filter = atom<string>('')
/** The workflow whose Delete asks for confirmation, by source and name, or null. */
const confirming = atom<{ name: string; source: string } | null>(null)
/** A Delete sent and not answered: another press is ignored. */
const deleting = atom<boolean>(false)
/** What the last Delete did, until the next one or another project. */
const outcome = atom<DeleteOutcome | null>(null)
/** Why the last press of Open in builder opened nothing, or null. */
const openRefused = atom<string | null>(null)
/** The New workflow form while it is open: the name typed and the place chosen; null while closed. */
const newForm = atom<{ name: string; place: NewWorkflowPlace | null } | null>(null)
/** Why the worker did not start the new workflow, said in the form, or null. */
const newRefused = atom<string | null>(null)
/** New workflow sent and not answered: another press is ignored. */
const creating = atom<boolean>(false)
/** The new workflow whose Discard asks for confirmation, or null. */
const discarding = atom<NewDraftRow | null>(null)

/** The words of a draft mark on a workflow's row: a mark in text, not colour alone. */
export const DRAFT_MARK = 'Draft with unsaved changes'

/** What a press of Open in builder says when the worker itself does not answer. */
export const BUILDER_UNANSWERED = "The builder tab did not open: Orchon's worker did not answer."

/** How long the panel waits after the last keystroke of a search before it reads again. */
export const SEARCH_PAUSE_MS = 500
/** The least time between two reads of the section that no person asked for. */
const WORKFLOWS_GAP_MS = 1_000

/** What the section reads from the rest of the panel. */
export type WorkflowsSectionHooks = {
  connection(): ConnectionView | null
  /** Whether the Workflows section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** The panel's project: the Archon project of "This project", or undefined. */
  project(): string | undefined
  /** Whether the project scope is known, so the default project is the right one. */
  settled(): boolean
}

let fetcher: ViewFetch | undefined
let hooks: WorkflowsSectionHooks | undefined
/** The next read asks the worker to read Archon again: the section opened, or Refresh. */
let reload = true
let searchTimer: unknown

/** The project the section reads: the one chosen here, or the panel's. */
function projectOf(given: WorkflowsSectionHooks): string | undefined {
  const held = read(chosen)
  if (held === undefined) return given.project()
  return held ?? undefined
}

function apply(answer: WorkflowsAnswer | null): void {
  if (answer === null) return
  hooks?.keep(answer.connection)
  set(loaded, answer.workflows)
  set(problem, null)
  set(lastGood, now())
}

/** A search typed: the section is read again after a pause, so a keystroke is not a request. */
function searchAfterPause(): void {
  if (searchTimer !== undefined) frameTimers.clear(searchTimer)
  searchTimer = frameTimers.set(() => {
    searchTimer = undefined
    fetcher?.restart()
  }, SEARCH_PAUSE_MS)
}

/** Starts the section's fetch rules for this panel run. They stop when the panel closes. */
export function startWorkflowsSection(ctx: PanelContext, given: WorkflowsSectionHooks): void {
  hooks = given
  reload = true
  const view = createViewFetch<WorkflowsAnswer | null>({
    load(signal) {
      if (given.connection()?.kind !== 'connected' || !given.showing() || !given.settled()) return Promise.resolve(null)
      const request: WorkflowsRequest = {}
      const project = projectOf(given)
      if (project !== undefined) request.project = project
      if (read(projectSearch) !== '') request.search = read(projectSearch)
      if (read(filter) !== '') request.filter = read(filter)
      if (reload) request.reload = true
      reload = false
      return plugin.request('workflows.read', request, { signal })
    },
    apply,
    fail(_error, trouble) {
      if (trouble !== null) set(problem, { message: troubleText(trouble), lastGood: read(lastGood), tryAgain: offersTryAgain(trouble) })
    },
    minGapMs: WORKFLOWS_GAP_MS,
    safetyMs: () => SAFETY_REFETCH_MS,
    now,
    timers: frameTimers
  })
  fetcher = view
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (searchTimer !== undefined) frameTimers.clear(searchTimer)
      searchTimer = undefined
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** The section began to show, or Refresh: the lists are read from Archon again. */
export function openWorkflows(): void {
  reload = true
  fetcher?.restart()
}

/** Reads the section again at once, as when the project scope changed. */
export function restartWorkflows(): void {
  fetcher?.restart()
}

/** Whether the section holds an answer to show, as Searching keeps it under its banner. */
export function workflowsHaveData(): boolean {
  return read(loaded) !== null
}

/** A different Archon store: what the section held belongs to the old one. */
export function clearWorkflows(): void {
  set(loaded, null)
  set(problem, null)
  set(chosen, undefined)
  set(confirming, null)
  set(outcome, null)
  set(openRefused, null)
  set(newForm, null)
  set(newRefused, null)
  set(discarding, null)
}

/** Open in builder: the worker writes the tab's file and opens it. A refusal is said under the project select. */
function openInBuilder(view: Ready, row: SectionWorkflow): void {
  set(openRefused, null)
  plugin.request('builder.open', { name: row.name, codebaseId: view.codebaseId, source: row.source }).then(
    (answer) => set(openRefused, answer.opened ? null : answer.reason),
    () => set(openRefused, BUILDER_UNANSWERED)
  )
}

function choose(value: string): void {
  set(chosen, value === NO_PROJECT ? null : value)
  set(confirming, null)
  set(outcome, null)
  fetcher?.restart()
}

/** Delete, sent once. A press while one is sent is ignored, and nothing is sent again. */
function remove(view: Ready, row: SectionWorkflow): void {
  if (read(deleting)) return
  set(deleting, true)
  plugin
    .request('workflows.delete', { name: row.name, codebaseId: view.codebaseId })
    .then(
      (answer: DeleteAnswer) => {
        apply(answer)
        set(outcome, answer.outcome)
        set(confirming, null)
      },
      () => {
        set(outcome, {
          kind: 'failed',
          name: row.name,
          message: "Orchon's background process did not answer, so it is not known whether the workflow was deleted. Refresh to check."
        })
        set(confirming, null)
      }
    )
    .finally(() => set(deleting, false))
}

/** The folder separator a path already uses, so a joined path reads as one. */
const separatorOf = (folder: string): string => (folder.includes('\\') && !folder.includes('/') ? '\\' : '/')

/**
 * What a Delete removes, in words. Archon deletes the workflow's package folder when there is
 * one, and otherwise both `<name>.yaml` and `<name>.yml` (0.12.1, DELETE `/api/workflows/:name`).
 */
function removedOf(view: Ready, row: SectionWorkflow): string {
  const what = `the folder ${row.name} and everything in it, or, when there is no such folder, the files ${row.name}.yaml and ${row.name}.yml`
  if (row.source === 'global') return `In the workflows folder of Archon's home folder this deletes ${what}`
  const folder = view.folder ?? ''
  const separator = separatorOf(folder)
  return `In ${folder.replace(/[\\/]+$/, '')}${separator}.archon${separator}workflows this deletes ${what}`
}

function confirmation(view: Ready, row: SectionWorkflow, writable: boolean): OrcaNode {
  return (
    <Callout tone="danger" title={`Delete ${row.name}?`}>
      <Stack gap="xs">
        <Text>{`${removedOf(view, row)}. There is no undo.`}</Text>
        <Row gap="sm" wrap>
          <Button size="sm" tone="danger" disabled={!writable || read(deleting)} onPress={() => remove(view, row)}>
            {`Delete ${row.name}`}
          </Button>
          <Button size="sm" variant="outline" onPress={() => set(confirming, null)}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function workflowRow(view: Ready, row: SectionWorkflow, writable: boolean): OrcaNode {
  const held = read(confirming)
  const asking = held !== null && held.name === row.name && held.source === row.source
  // While Archon is away a workflow with a draft still opens, from its draft.
  const openOff = view.builderOff ?? (writable || row.draft === true ? undefined : NOT_CONNECTED_TEXT)
  return (
    <Stack key={`${row.source}:${row.name}`} gap="xs">
      <Row gap="sm" align="center" wrap>
        <Text weight="semibold">{row.name}</Text>
        <Text muted size="sm">{`Source: ${row.source}`}</Text>
        {row.draft === true ? <Text size="sm">{DRAFT_MARK}</Text> : null}
        <Button size="sm" variant="outline" disabled={openOff !== undefined} tooltip={openOff} onPress={() => openInBuilder(view, row)}>
          {`Open ${row.name} in builder`}
        </Button>
        {row.deletable && !asking ? (
          <Button size="sm" variant="outline" disabled={!writable} tooltip={writable ? undefined : NOT_CONNECTED_TEXT} onPress={() => set(confirming, { name: row.name, source: row.source })}>
            {`Delete ${row.name}`}
          </Button>
        ) : null}
      </Row>
      {row.description === '' ? null : (
        <Text muted size="sm">
          {row.description}
        </Text>
      )}
      {asking ? confirmation(view, row, writable) : null}
    </Stack>
  )
}

function listPart(view: Ready, list: SectionList, writable: boolean): OrcaNode {
  if (list.kind === 'too-large') return <Text>Archon's workflow list is too large to show.</Text>
  if (list.kind === 'failed') return <Text>{`Orchon could not read the workflows. ${list.message}`}</Text>
  const searching = read(filter) !== ''
  return (
    <Stack gap="sm">
      {list.total > SECTION_WORKFLOWS_CAP || searching ? (
        <Input
          label="Search workflows"
          type="search"
          value={read(filter)}
          maxLength={SECTION_SEARCH_CAP}
          onChange={(value) => {
            set(filter, value)
            searchAfterPause()
          }}
        />
      ) : null}
      {list.rows.length === 0 ? <Text muted>{searching ? 'No workflow matches the search.' : 'Archon lists no workflows here.'}</Text> : null}
      {list.rows.map((row) => workflowRow(view, row, writable))}
      {list.matching > list.rows.length ? (
        <Text muted size="sm">
          {`Showing ${String(list.rows.length)} of ${String(list.matching)} workflows. Search to narrow the list.`}
        </Text>
      ) : null}
      {list.unreadable > 0 ? (
        <Text muted size="sm">
          {`${plural(list.unreadable, 'workflow could not be read and is', 'workflows could not be read and are')} not shown.`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** New workflow: the worker checks the name, keeps the draft and opens the tab. A refusal stays in the form. */
function createWorkflow(view: Ready, name: string, place: NewWorkflowPlace): void {
  if (read(creating)) return
  set(creating, true)
  set(newRefused, null)
  plugin
    .request('workflows.new', { name, codebaseId: view.codebaseId, place })
    .then(
      (answer) => {
        if (answer.opened) {
          set(newForm, null)
          fetcher?.restart()
        } else set(newRefused, answer.reason)
      },
      () => set(newRefused, BUILDER_UNANSWERED)
    )
    .finally(() => set(creating, false))
}

/** The place a new workflow is saved to as the form stands: with no project, only global. */
const placeOf = (view: Ready, chosenPlace: NewWorkflowPlace | null): NewWorkflowPlace => (view.codebaseId === null ? 'global' : (chosenPlace ?? 'project'))

/** New workflow and its form, which asks for a name and a place before any tab opens. */
function newWorkflowPart(view: Ready, writable: boolean): OrcaNode {
  const form = read(newForm)
  const off = view.builderOff ?? (writable ? undefined : NOT_CONNECTED_TEXT)
  if (form === null) {
    return (
      <Row gap="sm" align="center">
        <Button size="sm" variant="outline" disabled={off !== undefined} tooltip={off} onPress={() => set(newForm, { name: '', place: null })}>
          New workflow
        </Button>
      </Row>
    )
  }
  const place = placeOf(view, form.place)
  const refused = read(newRefused)
  return (
    <Stack gap="xs">
      <Input label="Workflow name" value={form.name} maxLength={WORKFLOW_NAME_CAP} onChange={(name) => set(newForm, { ...form, name })} />
      <RadioGroup
        label="Save the new workflow"
        value={place}
        options={[
          { value: 'project', label: 'In this project', disabled: view.codebaseId === null, ...(view.codebaseId === null ? { description: 'Choose a project to save a workflow into it.' } : {}) },
          { value: 'global', label: 'Global, for every project' }
        ]}
        onChange={(value) => set(newForm, { ...form, place: value === 'global' ? 'global' : 'project' })}
      />
      <Text muted size="sm">
        Nothing is written to Archon until the first Save in the builder.
      </Text>
      {refused === null ? null : <Text>{refused}</Text>}
      <Row gap="sm" wrap>
        <Button size="sm" disabled={off !== undefined || read(creating)} tooltip={off} onPress={() => createWorkflow(view, form.name, place)}>
          Create and open
        </Button>
        <Button
          size="sm"
          variant="outline"
          onPress={() => {
            set(newForm, null)
            set(newRefused, null)
          }}
        >
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

/** Discard of a new workflow never saved: its draft is deleted, and Archon holds nothing of it. */
function discardNew(row: NewDraftRow): void {
  set(discarding, null)
  plugin.request('builder.draft.discard', { ...identityOf(row), storeId: row.storeId }).then(
    () => fetcher?.restart(),
    () => set(openRefused, "Orchon's worker did not answer, so it is not known whether the draft was discarded. Refresh to check.")
  )
}

/** The new workflows never saved, each with Open and Discard, and what is not shown. */
function draftsPart(view: Ready, drafts: SectionDrafts | undefined): OrcaNode {
  if (drafts === undefined) return null
  const asking = read(discarding)
  return (
    <Stack gap="xs">
      {drafts.fresh.length === 0 ? null : <Text weight="semibold">New workflows not saved yet</Text>}
      {drafts.fresh.map((row) => {
        const open = (): void => {
          set(openRefused, null)
          plugin.request('builder.open', { name: row.name, codebaseId: row.codebaseId, source: row.scope }).then(
            (answer) => set(openRefused, answer.opened ? null : answer.reason),
            () => set(openRefused, BUILDER_UNANSWERED)
          )
        }
        const confirming = asking !== null && sameIdentity(asking, row) && asking.storeId === row.storeId
        return (
          <Stack key={`${row.scope}:${row.codebaseId ?? ''}:${row.storeId ?? ''}:${row.name}`} gap="xs">
            <Row gap="sm" align="center" wrap>
              <Text weight="semibold">{row.name}</Text>
              <Text muted size="sm">
                {row.scope === 'global' ? 'Global' : 'This project'}
              </Text>
              <Button size="sm" variant="outline" disabled={view.builderOff !== undefined} tooltip={view.builderOff} onPress={open}>
                {`Open ${row.name} in builder`}
              </Button>
              {confirming ? null : (
                <Button size="sm" variant="outline" onPress={() => set(discarding, row)}>
                  {`Discard ${row.name}`}
                </Button>
              )}
            </Row>
            {confirming ? (
              <Callout tone="danger" title={`Discard ${row.name}?`}>
                <Stack gap="xs">
                  <Text>Its draft is deleted, and Archon holds nothing of it, so nothing of it is left. There is no undo.</Text>
                  <Row gap="sm" wrap>
                    <Button size="sm" tone="danger" onPress={() => discardNew(row)}>
                      {`Discard ${row.name} for good`}
                    </Button>
                    <Button size="sm" variant="outline" onPress={() => set(discarding, null)}>
                      Cancel
                    </Button>
                  </Row>
                </Stack>
              </Callout>
            ) : null}
          </Stack>
        )
      })}
      {drafts.elsewhere > 0 ? (
        <Text muted size="sm">
          {`${plural(drafts.elsewhere, 'new workflow of another project is', 'new workflows of other projects are')} not shown.`}
        </Text>
      ) : null}
      {drafts.dropped > 0 ? (
        <Text muted size="sm">
          {`${plural(drafts.dropped, 'builder draft could not be read, so Orchon deleted it.', 'builder drafts could not be read, so Orchon deleted them.')}`}
        </Text>
      ) : null}
    </Stack>
  )
}

function outcomeLine(held: DeleteOutcome | null): OrcaNode {
  if (held === null) return null
  if (held.kind === 'deleted') {
    return (
      <Callout tone="neutral">
        <Text>{`Deleted ${held.name}.`}</Text>
      </Callout>
    )
  }
  return (
    <Callout tone="danger" title={`${held.name} was not deleted`}>
      <Text>{held.message}</Text>
    </Callout>
  )
}

function ready(view: Ready, writable: boolean): OrcaNode {
  const { projects } = view
  return (
    <Stack gap="sm">
      <Input
        label="Search projects"
        type="search"
        value={read(projectSearch)}
        maxLength={SECTION_SEARCH_CAP}
        onChange={(value) => {
          set(projectSearch, value)
          searchAfterPause()
        }}
      />
      <Select
        label="Project"
        value={view.codebaseId ?? NO_PROJECT}
        options={[{ value: NO_PROJECT, label: 'No project' }, ...projects.rows.map((project) => ({ value: project.id, label: project.name }))]}
        onChange={choose}
      />
      {projects.more > 0 ? (
        <Text muted size="sm">
          {`${plural(projects.more, 'more Archon project is', 'more Archon projects are')} not shown. Search to find one.`}
        </Text>
      ) : null}
      {projects.unreadable > 0 ? (
        <Text muted size="sm">
          {`${plural(projects.unreadable, 'Archon project could not be read and is', 'Archon projects could not be read and are')} not shown.`}
        </Text>
      ) : null}
      {view.codebaseId === null ? (
        <Text muted size="sm">
          With no project, only global, bundled and installed workflows are listed.
        </Text>
      ) : null}
      {view.readFrom === null ? null : <Text muted size="sm">{`Workflows are read from ${view.readFrom}`}</Text>}
      {view.builderOff === undefined ? null : <Text muted size="sm">{view.builderOff}</Text>}
      {read(openRefused) === null ? null : <Text>{read(openRefused)}</Text>}
      {newWorkflowPart(view, writable)}
      {outcomeLine(read(outcome))}
      {draftsPart(view, view.drafts)}
      {listPart(view, view.list, writable)}
    </Stack>
  )
}

/** The section while connected or under the Searching banner. `writable` is false when Delete is off. */
export function workflowsSection(state: Connected, writable: boolean): OrcaNode {
  const view = read(loaded)
  const held = read(problem)
  let body: OrcaNode
  if (view === null) body = held === null ? <Spinner label="Loading workflows…" /> : null
  else if (view.kind === 'not-connected') body = null
  else if (view.kind === 'failed') body = <Text>{`Orchon could not read Archon's projects. ${view.message}`}</Text>
  else body = ready(view, writable)
  // Archon's console has no workflows page at the releases tested; its workflow builder is the
  // nearest page.
  const openConsole = (): void => {
    shell.openExternal(`${state.baseUrl}/console/builder`).catch(() => {})
  }
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center">
        <IconButton icon="refresh" label="Refresh workflows" onPress={openWorkflows} />
      </Row>
      {held === null ? null : problemLine(held, view !== null, openWorkflows)}
      {body}
      <Link onPress={openConsole}>Open in Archon console</Link>
    </Stack>
  )
}
