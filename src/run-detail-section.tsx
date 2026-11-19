// Run detail, the second level of the Runs section: what one run is and how far it got. It draws
// only the worker's view model and fetches it under the shared per-view fetch rules, refetching
// on a hint that names the run, at most once a second, and on the safety refetch. The answer
// block, the action row and the row of small buttons come with their own tickets.
import { atom, Badge, Button, plugin, read, Row, set, Spinner, Stack, Text, type OrcaNode, type PanelContext } from 'orca'
import type { Connected, ConnectionView } from './connection-view'
import { now } from './dates'
import { frameTimers } from './frame-timers'
import type { RunsHint } from './hint-view'
import { RUN_ID_CAP, type RunDetail, type RunDetailAnswer, type RunDetailRequest } from './run-detail-view'
import { STATUS_TONE, STATUS_WORD } from './run-status-words'
import { createViewFetch, LIVE_OFF_REFETCH_MS, SAFETY_REFETCH_MS, type ViewFetch } from './view-fetch'

/** The least time between two reads of run detail that no person asked for. */
export const RUN_DETAIL_GAP_MS = 1_000

/**
 * The run that is open, kept per workspace because Orca unmounts a hidden panel. It is stored as
 * whatever was written, so it is parsed on every read.
 */
const openRun = atom<unknown>('openRun', null, { persist: 'workspace' })
const loaded = atom<RunDetail | null>(null)

/** The open run's id, or null when the runs table shows. */
export function openRunId(): string | null {
  const value = read(openRun)
  return typeof value === 'string' && value !== '' && value.length <= RUN_ID_CAP ? value : null
}

/** What the view reads from the rest of the panel. */
export type RunDetailHooks = {
  connection(): ConnectionView | null
  /** Whether the Runs section is the one showing. */
  showing(): boolean
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
  /** The way back: the runs table shows again and is read again. */
  back(): void
}

let fetcher: ViewFetch | undefined
let hooks: RunDetailHooks | undefined
/** The run the next read asks for as just opened, so the worker looks its sub-runs up at once. */
let opening: string | null = null

function apply(answer: RunDetailAnswer | null): void {
  if (answer === null) return
  hooks?.keep(answer.connection)
  const { run } = answer
  if (run.kind === 'ready' && run.detail.id === openRunId()) set(loaded, run.detail)
}

/** Starts the view's fetch rules for this panel run. They stop when the panel closes. */
export function startRunDetail(ctx: PanelContext, given: RunDetailHooks): void {
  hooks = given
  const view = createViewFetch<RunDetailAnswer | null>({
    load(signal) {
      const runId = openRunId()
      if (runId === null || given.connection()?.kind !== 'connected' || !given.showing()) return Promise.resolve(null)
      const request: RunDetailRequest = opening === runId ? { runId, open: true } : { runId }
      opening = null
      return plugin.request('run.read', request, { signal })
    },
    apply,
    fail() {},
    minGapMs: RUN_DETAIL_GAP_MS,
    safetyMs: () => {
      const state = given.connection()
      return state?.kind === 'connected' && !state.live ? LIVE_OFF_REFETCH_MS : SAFETY_REFETCH_MS
    },
    now,
    timers: frameTimers
  })
  fetcher = view
  ctx.subscriptions.push({
    dispose() {
      view.stop()
      if (fetcher === view) fetcher = undefined
    }
  })
}

/** Whether run detail holds an answer to show, as Searching keeps it under its banner. */
export function runDetailHasData(): boolean {
  return read(loaded) !== null
}

/** A different Archon store: the open run belongs to the old one. */
export function clearRunDetail(): void {
  set(openRun, null)
  set(loaded, null)
}

/** Opens a run in place of the runs table. */
export function openRunDetail(runId: string): void {
  set(openRun, runId)
  set(loaded, null)
  opening = runId
  fetcher?.restart()
}

/** Reads the open run again at once, as a person's action does. */
export function restartRunDetail(): void {
  const runId = openRunId()
  if (runId === null) return
  if (read(loaded) === null) opening = runId
  fetcher?.restart()
}

/** A hint that runs changed: read again, once the gap allows, when it names the open run. */
export function hintRunDetail(hint: RunsHint): void {
  const runId = openRunId()
  if (runId !== null && (hint.runs === 'many' || hint.runs.includes(runId))) fetcher?.refresh()
}

function back(): void {
  set(openRun, null)
  set(loaded, null)
  hooks?.back()
}

function header(detail: RunDetail | null): OrcaNode {
  return (
    <Row gap="sm" align="center">
      <Button size="sm" variant="ghost" tooltip="Back to the runs table" onPress={back}>
        Runs
      </Button>
      {detail === null ? null : (
        <>
          <Text weight="semibold" truncate>
            {detail.workflow}
          </Text>
          <Badge tone={STATUS_TONE[detail.status]}>{STATUS_WORD[detail.status]}</Badge>
        </>
      )}
    </Row>
  )
}

/** Run detail while connected or under the Searching banner. */
export function runDetailSection(_state: Connected, _writable: boolean): OrcaNode {
  const detail = read(loaded)
  return (
    <Stack gap="sm">
      {header(detail)}
      {detail === null ? <Spinner label="Loading the run…" /> : null}
    </Stack>
  )
}
