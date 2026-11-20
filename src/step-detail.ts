// The step view's requests: one step's facts and output, read from `GET /api/workflows/runs/{runId}`,
// and its activity, read from `GET /api/workflows/runs/{runId}/provider-events?step=` and folded
// here (`activity.ts`). The worker keeps the folded lists of the steps most recently viewed and
// answers pages and items from them; raw events never reach a frame. While a step runs and its
// view is open, it asks Archon every 3 seconds for the events after the last one it holds, with
// the route's cursor (`step`, `attemptId`, `afterSeq`), and tells the frames when new ones came.
// It stops when the step ends, when the view closes or goes quiet, and when Orchon is not
// Connected. Past 32 MiB of one step's events it keeps nothing and answers a notice. Nothing here
// writes.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { createFold, parseProviderEvents, type Fold } from './activity'
import type { Client, ClientFailure, Timers } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { cutAt, cutText } from './cutter'
import { parseInstant } from './dates'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, ownRecord, refuseOtherKeys, refuseRequest } from './records'
import { readRun, RUN_PATH } from './run-detail'
import { RUN_ID_CAP, type Step } from './run-detail-view'
import {
  ACTIVITY_PAGES_CAP,
  ERROR_CAP,
  STEP_EVENTS_CAP_BYTES,
  STEP_ID_CAP,
  STEP_OUTPUT_CAP,
  STEP_POLL_MS,
  type ActivityView,
  type ItemAnswer,
  type ItemRequest,
  type ItemView,
  type SkipFacts,
  type StepAnswer,
  type StepCloseRequest,
  type StepFacts,
  type StepHint,
  type StepOutput,
  type StepRequest,
  type StepView
} from './step-view'

/** How many steps' folded lists the worker keeps, newest last. */
export const KEPT_STEPS = 5

/**
 * How long a step's view counts as open after its last read. A view that shows reads at least on
 * its 30 second safety refetch, so a frame that closed without saying so stops being polled.
 */
export const STEP_LEASE_MS = 65_000

function parseIds(input: unknown, name: string): Record<string, unknown> & { runId: string; stepId: string } {
  if (!isRecord(input)) refuseRequest(`${name} takes a run id and a step id.`)
  const runId = own(input, 'runId')
  if (!isCappedText(runId, RUN_ID_CAP)) refuseRequest(cappedTextRefusal('The run id', RUN_ID_CAP))
  const stepId = own(input, 'stepId')
  if (!isCappedText(stepId, STEP_ID_CAP)) refuseRequest(cappedTextRefusal('The step id', STEP_ID_CAP))
  return Object.assign(input, { runId, stepId })
}

/** A frame's `step.read`, or a refusal. */
export function parseStepRequest(input: unknown): StepRequest {
  const ids = parseIds(input, 'The step request')
  refuseOtherKeys(ids, ['runId', 'stepId', 'pages'], 'The step request')
  const pages = own(ids, 'pages')
  if (pages === undefined) return { runId: ids.runId, stepId: ids.stepId }
  if (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 1 || pages > ACTIVITY_PAGES_CAP) {
    refuseRequest(`Pages must be a whole number from 1 to ${String(ACTIVITY_PAGES_CAP)}.`)
  }
  return { runId: ids.runId, stepId: ids.stepId, pages }
}

/** A frame's `step.close`, or a refusal. */
export function parseStepClose(input: unknown): StepCloseRequest {
  const ids = parseIds(input, 'The step close request')
  refuseOtherKeys(ids, ['runId', 'stepId'], 'The step close request')
  return { runId: ids.runId, stepId: ids.stepId }
}

/** The most characters of an item key a frame sends. */
const ITEM_KEY_CAP = 1_000

/** A frame's `step.item`, or a refusal. */
export function parseItemRequest(input: unknown): ItemRequest {
  const ids = parseIds(input, 'The item request')
  refuseOtherKeys(ids, ['runId', 'stepId', 'key'], 'The item request')
  const key = own(ids, 'key')
  if (!isCappedText(key, ITEM_KEY_CAP)) refuseRequest(cappedTextRefusal('The item key', ITEM_KEY_CAP))
  return { runId: ids.runId, stepId: ids.stepId, key }
}

const isLength = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const textOrNull = (value: unknown): string | null => (isText(value) ? value : null)

/** A value Archon wraps as `{ source, value }` in 0.14.0's `spend` and `binding`, or itself when it is not wrapped. */
function unwrapped(value: unknown): unknown {
  return isRecord(value) && Object.hasOwn(value, 'source') ? own(value, 'value') : value
}

/** What the run's events say about one step beyond run detail's row. */
type StepEvents = Omit<StepFacts, 'id' | 'name' | 'kind' | 'state' | 'runStatus' | 'loop' | 'starts' | 'reached' | 'position' | 'count' | 'previous' | 'next'> & {
  output: string | null
}

function emptyEvents(): StepEvents {
  return {
    startedAt: null,
    endedAt: null,
    durationMs: null,
    costUsd: null,
    tokens: null,
    model: null,
    provider: null,
    turns: null,
    stopReason: null,
    error: null,
    skip: null,
    output: null
  }
}

/** The tokens of an end event: `tokens` with `input` and `output`, or null. */
function tokensOf(data: Record<string, unknown>): StepEvents['tokens'] {
  const tokens = unwrapped(own(data, 'tokens'))
  if (!isRecord(tokens)) return null
  const input = own(tokens, 'input')
  const output = own(tokens, 'output')
  return isCount(input) && isCount(output) ? { input, output } : null
}

/** The model an end event names: the one the provider resolved when it says, else the one asked for. */
function modelOf(data: Record<string, unknown>): string | null {
  const usage = own(data, 'model_usage')
  const resolved = isRecord(usage) ? own(usage, 'resolved') : undefined
  if (isText(resolved)) return resolved
  return textOrNull(own(data, 'model'))
}

/** The skip a skip event records: its reason, and the condition when a condition skipped it. */
function skipOf(type: string, data: Record<string, unknown>): SkipFacts {
  if (type === 'node_skipped_prior_success') return { reason: 'prior_success', condition: null }
  const cause = own(data, 'cause')
  const kind = isRecord(cause) ? own(cause, 'kind') : undefined
  const expr = isRecord(cause) ? own(cause, 'expr') : undefined
  return {
    reason: textOrNull(own(data, 'reason')) ?? 'skipped',
    condition: (kind === 'condition' || kind === 'condition_parse_error') && isText(expr) ? expr : null
  }
}

/** Folds the run's events for one step into its latest start's facts. An event that cannot be read is passed over. */
function stepEvents(value: Record<string, unknown>, stepId: string): StepEvents {
  let facts = emptyEvents()
  const events = own(value, 'events')
  for (const event of Array.isArray(events) ? (events as unknown[]) : []) {
    if (!isRecord(event) || own(event, 'step_name') !== stepId) continue
    const type = own(event, 'event_type')
    if (!isText(type)) continue
    const data = ownRecord(event, 'data')
    if (type === 'node_started') {
      facts = emptyEvents()
      const timing = ownRecord(data, 'timing')
      facts.startedAt = parseInstant(own(timing, 'startedAt')) ?? parseInstant(own(ownRecord(data, 'attempt'), 'startedAt'))
    } else if (type === 'node_completed' || type === 'node_failed') {
      const timing = ownRecord(data, 'timing')
      const duration = own(timing, 'durationMs') ?? own(data, 'duration_ms')
      facts.durationMs = isLength(duration) ? duration : null
      facts.startedAt ??= parseInstant(own(timing, 'startedAt'))
      facts.endedAt = facts.startedAt !== null && facts.durationMs !== null ? facts.startedAt + facts.durationMs : null
      const cost = own(data, 'cost_usd')
      facts.costUsd = isLength(cost) ? cost : null
      facts.tokens = tokensOf(data)
      facts.model = modelOf(data)
      facts.provider = textOrNull(own(data, 'provider'))
      const turns = own(data, 'num_turns')
      facts.turns = isCount(turns) ? turns : null
      facts.stopReason = textOrNull(own(data, 'stop_reason'))
      const output = own(data, 'node_output')
      facts.output = isText(output) ? output : null
      const error = own(data, 'error')
      if (type === 'node_failed' && isText(error)) facts.error = cutAt(error, ERROR_CAP)
    } else if (type === 'node_skipped' || type === 'node_skipped_prior_success') {
      facts.skip = skipOf(type, data)
    }
  }
  return facts
}

/** The error `run.nodes` holds for the step, which a failed step has even when no event carries it. */
function nodeError(value: Record<string, unknown>, stepId: string): string | null {
  const run = ownRecord(value, 'run')
  const nodes = own(run, 'nodes')
  for (const node of Array.isArray(nodes) ? (nodes as unknown[]) : []) {
    if (isRecord(node) && own(node, 'node_id') === stepId && isText(own(node, 'error'))) return cutAt(own(node, 'error') as string, ERROR_CAP)
  }
  return null
}

/** The step's output as blocks, or null when it gave none. */
function outputOf(text: string | null): StepOutput | null {
  if (text === null) return null
  const cut = cutText(text, STEP_OUTPUT_CAP)
  return { blocks: cut.blocks.map((block) => block.text), notShown: cut.notShown }
}

/** One step's held activity. */
type Held = {
  fold: Fold | null
  /** The bytes of its events read so far, against `STEP_EVENTS_CAP_BYTES`. */
  bytes: number
  tooLarge: boolean
  /** Whether the step ran when it was last read. */
  running: boolean
  /** Until when its view counts as open. */
  openUntil: number
  timer: unknown
  /** Reads of one step run one after another, so the cursor is never read twice at once. */
  queue: Promise<unknown>
}

export type StepDetailPorts = {
  client: Client
  current(): Promise<ConnectionView>
  now(): number
  timers: Timers
}

export const providerEventsPath = (runId: string, stepId: string, cursor: { attemptId: string; seq: number } | null): string =>
  `${RUN_PATH}${encodeURIComponent(runId)}/provider-events?step=${encodeURIComponent(stepId)}${
    cursor === null ? '' : `&attemptId=${encodeURIComponent(cursor.attemptId)}&afterSeq=${String(cursor.seq)}`
  }`

/** What a read of events gives: how many events it added, or why it failed. */
type EventsRead = { ok: true; added: number } | { ok: false; message: string }

/** Answers the frames' `step.read`, `step.item` and `step.close`. */
export function startStepDetail(orca: OrcaWorkerApi, ports: StepDetailPorts): Disposable {
  const held = new Map<string, Held>()
  const stopping = new AbortController()
  const keyOf = (runId: string, stepId: string): string => JSON.stringify([runId, stepId])

  function stopPolling(entry: Held): void {
    if (entry.timer !== undefined) ports.timers.clear(entry.timer)
    entry.timer = undefined
  }

  /** The step's held entry, newest last; the oldest past `KEPT_STEPS` is let go. */
  function entryOf(key: string): Held {
    let entry = held.get(key)
    if (entry !== undefined) held.delete(key)
    entry ??= { fold: null, bytes: 0, tooLarge: false, running: false, openUntil: 0, timer: undefined, queue: Promise.resolve() }
    held.set(key, entry)
    while (held.size > KEPT_STEPS) {
      const oldest = held.keys().next().value as string
      const dropped = held.get(oldest)
      if (dropped !== undefined) stopPolling(dropped)
      held.delete(oldest)
    }
    return entry
  }

  /** Reads the step's events: all of them the first time, then those after the cursor. */
  async function readEvents(server: Pick<Connected, 'baseUrl' | 'version'>, runId: string, stepId: string, entry: Held, signal: AbortSignal): Promise<EventsRead> {
    if (entry.tooLarge) return { ok: true, added: 0 }
    const cursor = entry.fold?.cursor() ?? null
    const answer = await ports.client.bytes({
      baseUrl: server.baseUrl,
      path: providerEventsPath(runId, stepId, entry.fold === null ? null : cursor),
      timeout: 'read',
      maxBytes: STEP_EVENTS_CAP_BYTES - entry.bytes,
      signal
    })
    if (!answer.ok) {
      if (answer.failure.kind === 'too-large') {
        entry.tooLarge = true
        entry.fold = null
        stopPolling(entry)
        return { ok: true, added: 0 }
      }
      return { ok: false, message: failureText(answer.failure) }
    }
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(answer.bytes))
    } catch {
      return { ok: false, message: unreadableAnswerText(server.version) }
    }
    const parsed = parseProviderEvents(value)
    if (parsed === null) return { ok: false, message: unreadableAnswerText(server.version) }
    entry.bytes += answer.bytes.byteLength
    const fold = entry.fold ?? createFold()
    entry.fold = fold
    return { ok: true, added: fold.add(parsed.events, parsed.unreadable) }
  }

  /** Reads on one step's queue. */
  function queued<T>(entry: Held, read: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(read, read)
    entry.queue = next.catch(() => {})
    return next
  }

  function schedule(server: Connected, runId: string, stepId: string, entry: Held): void {
    if (entry.timer !== undefined || !entry.running || entry.tooLarge || ports.now() > entry.openUntil) return
    entry.timer = ports.timers.set(() => {
      entry.timer = undefined
      void poll(server, runId, stepId, entry)
    }, STEP_POLL_MS)
  }

  async function poll(server: Connected, runId: string, stepId: string, entry: Held): Promise<void> {
    if (!entry.running || entry.tooLarge || ports.now() > entry.openUntil) return
    if (held.get(keyOf(runId, stepId)) !== entry) return
    const connection = await ports.current()
    if (connection.kind !== 'connected') return
    const read = await queued(entry, () => readEvents(connection, runId, stepId, entry, stopping.signal))
    if (stopping.signal.aborted) return
    if (!read.ok || read.added > 0 || entry.tooLarge) orca.panels.post('step.changed', { runId, stepId } satisfies StepHint)
    schedule(server, runId, stepId, entry)
  }

  async function readStep(server: Connected, request: StepRequest, signal: AbortSignal): Promise<StepView> {
    const fetched = await readRun(ports.client, server, request.runId, signal)
    if (fetched.kind !== 'run') return fetched
    const { run } = fetched
    const index = run.steps.findIndex((step) => step.id === request.stepId)
    const step: Step | undefined = run.steps[index]
    if (step === undefined) return { kind: 'no-step' }
    const value = fetched.value as Record<string, unknown>
    const { output, ...events } = stepEvents(value, step.id)
    const facts: StepFacts = {
      id: step.id,
      name: step.name,
      kind: step.kind,
      state: step.state,
      runStatus: run.status,
      loop: step.loop,
      starts: step.starts,
      reached: step.reached,
      position: index + 1,
      count: run.stepCount,
      previous: run.steps[index - 1]?.id ?? null,
      next: run.steps[index + 1]?.id ?? null,
      ...events,
      error: step.state === 'failed' ? (events.error ?? nodeError(value, step.id)) : null,
      skip: step.state === 'skipped' ? (events.skip ?? { reason: 'skipped', condition: null }) : events.skip
    }
    const key = keyOf(request.runId, step.id)
    const entry = entryOf(key)
    const running = step.state === 'running'
    let activity: ActivityView
    const read = entry.fold === null || entry.running || running ? await queued(entry, () => readEvents(server, request.runId, step.id, entry, signal)) : { ok: true as const, added: 0 }
    entry.running = running
    entry.openUntil = ports.now() + STEP_LEASE_MS
    if (entry.tooLarge) activity = { kind: 'too-large' }
    else if (!read.ok || entry.fold === null) activity = { kind: 'failed', message: read.ok ? unreadableAnswerText(server.version) : read.message }
    else activity = entry.fold.page(request.pages ?? 1, running)
    if (running) schedule(server, request.runId, step.id, entry)
    else stopPolling(entry)
    return { kind: 'ready', facts, output: outputOf(output), activity }
  }

  async function readItem(server: Connected, request: ItemRequest, signal: AbortSignal): Promise<ItemView> {
    const entry = entryOf(keyOf(request.runId, request.stepId))
    if (entry.fold === null && !entry.tooLarge) {
      const read = await queued(entry, () => readEvents(server, request.runId, request.stepId, entry, signal))
      if (!read.ok) return { kind: 'failed', message: read.message }
    }
    return entry.fold?.item(request.key) ?? { kind: 'not-found' }
  }

  const stepHandler = orca.panels.handle('step.read', async (input, context): Promise<StepAnswer> => {
    const request = parseStepRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, step: { kind: 'not-connected' } }
    const step = await readStep(connection, request, context.signal)
    return { connection: await ports.current(), step }
  })

  const itemHandler = orca.panels.handle('step.item', async (input, context): Promise<ItemAnswer> => {
    const request = parseItemRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, item: { kind: 'not-connected' } }
    const item = await readItem(connection, request, context.signal)
    return { connection: await ports.current(), item }
  })

  const closeHandler = orca.panels.handle('step.close', (input): null => {
    const request = parseStepClose(input)
    const entry = held.get(keyOf(request.runId, request.stepId))
    if (entry !== undefined) {
      entry.openUntil = 0
      stopPolling(entry)
    }
    return null
  })

  return {
    dispose() {
      stopping.abort()
      for (const entry of held.values()) stopPolling(entry)
      held.clear()
      stepHandler.dispose()
      itemHandler.dispose()
      closeHandler.dispose()
    }
  }
}

function failureText(failure: ClientFailure): string {
  if (failure.kind === 'status' && failure.status === 404) return 'Archon no longer has this run.'
  return readFailureText(failure)
}
