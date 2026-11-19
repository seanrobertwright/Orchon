// Run detail's request: the validator and view-model builder of `GET /api/workflows/runs/{runId}`.
// It lists only the fields run detail reads, all present at the floor (Archon 0.12.1), and keeps
// the run's facts, its steps and its waiting state. The run's events are read for each step's
// kind, start count and duration, and then dropped with their payloads; `terminal_record`, its
// artifact listing and every step's output are never read. A step that fails is dropped and
// counted; a run that fails as a whole is an error.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import { parseInstant } from './dates'
import { questionOf } from './questions'
import type { Question } from './run-answer-view'
import type { WorkspaceRow } from './project-scope'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, ownRecord, refuseRequest } from './records'
import {
  CHILD_ROWS_CAP,
  LAUNCH_MESSAGE_CAP,
  RUN_ID_CAP,
  STEP_ROWS_CAP,
  STALLED_CALLS_CAP,
  STEP_STATES,
  UNREADABLE_DETAIL_CAP,
  type ChildRow,
  type RunDetail,
  type RunDetailAnswer,
  type RunDetailRequest,
  type StalledCall,
  type Step,
  type StepState,
  type Waiting
} from './run-detail-view'
import { workspaceIdFor } from './runs-table'
import { RUN_STATUSES, type RunStatus } from './runs-view'

export const RUN_PATH = '/api/workflows/runs/'

/** How long a lookup of sub-runs or project names is used before it is made again. */
export const LOOKUP_MS = 30_000

/** How many runs' sub-run lookups the worker keeps. */
const KEPT_LOOKUPS = 20

/** A frame's request, or a refusal: a run id of 1 to the cap, and `open` as true or false. */
export function parseRunDetailRequest(input: unknown): RunDetailRequest {
  if (!isRecord(input)) refuseRequest('The run detail request takes a run id.')
  const runId = own(input, 'runId')
  if (!isCappedText(runId, RUN_ID_CAP)) refuseRequest(cappedTextRefusal('The run id', RUN_ID_CAP))
  const open = own(input, 'open')
  if (open !== undefined && typeof open !== 'boolean') refuseRequest('Open must be true or false.')
  for (const key of Object.keys(input)) {
    if (key !== 'runId' && key !== 'open') refuseRequest(`The run detail request does not take ${key}.`)
  }
  return open === undefined ? { runId } : { runId, open }
}

const isStatus = (value: unknown): value is RunStatus => RUN_STATUSES.some((status) => status === value)
const isStepState = (value: unknown): value is StepState => STEP_STATES.some((state) => state === value)
const isLength = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** A text field that may be missing or null. Any other type fails the run. */
function optionalText(record: Record<string, unknown>, key: string): string | null | false {
  const value = own(record, key)
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : false
}

/** What the run's events say about one step. */
type StepEvents = { first: number; kind: string | null; starts: number; durationMs: number | null }

/** The length of a step's finished start, from its timing, or null when Archon gave none. */
function eventDuration(data: Record<string, unknown>): number | null {
  const timing = own(data, 'timing')
  const fromTiming = isRecord(timing) ? own(timing, 'durationMs') : undefined
  if (isLength(fromTiming)) return fromTiming
  const flat = own(data, 'duration_ms')
  return isLength(flat) ? flat : null
}

/** Folds the events into each step's facts, in one pass. An event that cannot be read is passed over. */
function foldEvents(events: readonly unknown[]): Map<string, StepEvents> {
  const steps = new Map<string, StepEvents>()
  events.forEach((event, index) => {
    if (!isRecord(event)) return
    const id = own(event, 'step_name')
    const type = own(event, 'event_type')
    if (!isText(id) || !isText(type)) return
    const data = ownRecord(event, 'data')
    let step = steps.get(id)
    if (step === undefined) {
      step = { first: index, kind: null, starts: 0, durationMs: null }
      steps.set(id, step)
    }
    const node = own(data, 'node')
    const kind = isRecord(node) ? own(node, 'kind') : undefined
    if (step.kind === null && isText(kind)) step.kind = kind
    if (type === 'node_started') {
      step.starts += 1
      step.durationMs = null
    } else if (type === 'node_completed' || type === 'node_failed') {
      step.durationMs = eventDuration(data)
    }
  })
  return steps
}

/** A node of `run.nodes` that run detail can read: its id and a state it knows. */
type ParsedNode = { id: string; state: StepState }

/** One node of `run.nodes`, or null when it has no id or a state run detail does not know. */
function parseNode(value: unknown): ParsedNode | null {
  if (!isRecord(value)) return null
  const id = own(value, 'node_id')
  const state = own(value, 'state')
  if (!isText(id) || !isStepState(state)) return null
  return { id, state }
}

/** The id of the loop that holds a step: the longest dotted start of its id that is a step too. */
function loopOf(id: string, ids: ReadonlySet<string>): string | null {
  for (let dot = id.lastIndexOf('.'); dot > 0; dot = id.lastIndexOf('.', dot - 1)) {
    const prefix = id.slice(0, dot)
    if (ids.has(prefix)) return prefix
  }
  return null
}

/**
 * The steps in the tree's order: at each level the steps reached by first start, then the rest in
 * Archon's order, and each loop followed by its own inner steps.
 */
function orderSteps(nodes: readonly ParsedNode[], events: Map<string, StepEvents>): Step[] {
  const ids = new Set(nodes.map((node) => node.id))
  const steps: Step[] = nodes.map((node, position) => {
    const loop = loopOf(node.id, ids)
    const facts = events.get(node.id)
    return {
      step: {
        id: node.id,
        name: loop === null ? node.id : node.id.slice(loop.length + 1),
        kind: facts?.kind ?? null,
        state: node.state,
        loop,
        starts: facts?.starts ?? 0,
        durationMs: node.state === 'running' ? null : (facts?.durationMs ?? null),
        reached: facts !== undefined
      },
      key: facts?.first ?? Number.MAX_SAFE_INTEGER,
      position
    }
  })
    .sort((a, b) => a.key - b.key || a.position - b.position)
    .map((entry) => entry.step)
  const children = new Map<string | null, Step[]>()
  for (const step of steps) {
    const level = children.get(step.loop)
    if (level === undefined) children.set(step.loop, [step])
    else level.push(step)
  }
  const ordered: Step[] = []
  const visit = (loop: string | null): void => {
    for (const step of children.get(loop) ?? []) {
      ordered.push(step)
      visit(step.id)
    }
  }
  visit(null)
  return ordered
}

/** The sub-runs a run waits on, from its attention, in Archon's order. */
function childIds(run: Record<string, unknown>): string[] | null {
  const attention = own(run, 'attention')
  if (!isRecord(attention)) return null
  const kind = own(attention, 'kind')
  if (kind === 'blocked_on_child') {
    const child = own(attention, 'childRunId')
    return isText(child) ? [child] : null
  }
  if (kind === 'blocked_on_children') {
    const list = own(attention, 'childRunIds')
    return Array.isArray(list) ? (list as unknown[]).filter(isText) : null
  }
  return null
}


/** The `attention` kinds that are a question or nothing to wait for: the answer block's, or none. */
const NOT_WAITING = ['awaiting_response', 'attention', 'terminal', 'blocked_on_child', 'blocked_on_children']

/** One stalled tool call, or null when it has no name or time. */
function stalledCall(value: unknown): StalledCall | null {
  if (!isRecord(value)) return null
  const name = own(value, 'name')
  const title = own(value, 'title')
  const stalledForMs = own(value, 'stalledForMs')
  if (!isText(name) || !isLength(stalledForMs)) return null
  return { name, title: isText(title) ? title : null, stalledForMs }
}

/**
 * A waiting state with nothing to answer, from the run's `attention`: a usage-limit pause, an
 * unreadable run, stalled tool calls, or a kind this version does not know. Sub-runs are read
 * by `childIds`, and a question is the answer block's.
 */
function attentionWaiting(run: Record<string, unknown>): Waiting | null {
  const attention = own(run, 'attention')
  if (!isRecord(attention)) return null
  const kind = own(attention, 'kind')
  if (typeof kind === 'string' && NOT_WAITING.includes(kind)) return null
  if (kind === 'usage_limit') return { kind: 'usage-limit', resumeAt: parseInstant(own(attention, 'resumeAt')) }
  if (kind === 'unreadable') {
    const detail = own(attention, 'detail')
    return { kind: 'unreadable', detail: typeof detail === 'string' ? cutAt(detail, UNREADABLE_DETAIL_CAP) : '' }
  }
  if (kind === 'stalled_tool_calls') {
    const list = own(attention, 'calls')
    const calls = (Array.isArray(list) ? (list as unknown[]) : []).map(stalledCall).filter((call) => call !== null)
    return { kind: 'stalled', calls: calls.slice(0, STALLED_CALLS_CAP), more: Math.max(0, calls.length - STALLED_CALLS_CAP) }
  }
  return { kind: 'unknown' }
}

/** A time or event wait from the run's metadata. A time that does not parse is dropped. */
function waitOf(metadata: Record<string, unknown>): Waiting | null {
  const wait = own(metadata, 'wait')
  if (!isRecord(wait)) return null
  const kind = own(wait, 'kind')
  const until = parseInstant(own(wait, 'resumeAt'))
  if (kind === 'time') return { kind: 'time', until }
  const event = own(wait, 'event')
  if (kind === 'event' && isText(event)) return { kind: 'event', event, until }
  return null
}

/** A run as run detail reads it, before its lookups. */
export type ParsedRun = Omit<RunDetail, 'project' | 'waiting'> & {
  codebaseId: string | null
  waiting: Waiting | null
  /** The sub-runs it waits on, or null when it waits on none. */
  children: string[] | null
}

const LIVE: readonly RunStatus[] = ['running', 'paused', 'pending']
/** One read of `GET runs/{id}`: the parsed run with the answer it came from, gone on a 404, or why it failed. */
export type RunRead = { kind: 'run'; run: ParsedRun; value: unknown } | { kind: 'gone' } | { kind: 'failed'; message: string }

/** Reads and parses one run. A 404 means the run is gone; any other failure, or an answer it cannot parse, is failed with the reason. */
export async function readRun(
  client: Client,
  server: Pick<Connected, 'baseUrl' | 'version'>,
  runId: string,
  signal: AbortSignal
): Promise<RunRead> {
  const answer = await client.request({ baseUrl: server.baseUrl, path: `${RUN_PATH}${encodeURIComponent(runId)}`, timeout: 'read', signal })
  if (!answer.ok) {
    if (answer.failure.kind === 'status' && answer.failure.status === 404) return { kind: 'gone' }
    return { kind: 'failed', message: readFailureText(answer.failure) }
  }
  const run = parseRunDetail(answer.value)
  return run === null ? { kind: 'failed', message: unreadableAnswerText(server.version) } : { kind: 'run', run, value: answer.value }
}

/** Archon's answer, or null when the run as a whole cannot be read. */
function parseRunDetail(value: unknown): ParsedRun | null {
  if (!isRecord(value)) return null
  const run = own(value, 'run')
  if (!isRecord(run)) return null
  const id = own(run, 'id')
  const workflow = own(run, 'workflow_name')
  const status = own(run, 'status')
  const nodes = own(run, 'nodes')
  if (!isText(id) || !isText(workflow) || !isStatus(status) || !Array.isArray(nodes)) return null
  const started = optionalText(run, 'started_at')
  const completed = optionalText(run, 'completed_at')
  const message = optionalText(run, 'user_message')
  const codebaseId = optionalText(run, 'codebase_id')
  const workingPath = optionalText(run, 'working_path')
  if (started === false || completed === false || message === false || codebaseId === false || workingPath === false) {
    return null
  }
  const metadata = ownRecord(run, 'metadata')
  const cost = own(metadata, 'total_cost_usd')
  const rawEvents = own(value, 'events')
  const events = foldEvents(Array.isArray(rawEvents) ? (rawEvents as unknown[]) : [])
  const parsedNodes: ParsedNode[] = []
  for (const node of nodes as unknown[]) {
    const parsed = parseNode(node)
    if (parsed !== null) parsedNodes.push(parsed)
  }
  const steps = orderSteps(parsedNodes, events)
  const live = LIVE.includes(status)
  const text = message ?? ''
  const question = questionOf(run, metadata)
  return {
    id,
    workflow,
    status,
    startedAt: parseInstant(started),
    endedAt: parseInstant(completed),
    costUsd: isLength(cost) ? cost : null,
    codebaseId: codebaseId === '' ? null : codebaseId,
    workingPath: workingPath === '' ? null : workingPath,
    message: cutAt(text, LAUNCH_MESSAGE_CAP),
    messageCut: text.length > LAUNCH_MESSAGE_CAP,
    steps: steps.slice(0, STEP_ROWS_CAP),
    stepCount: steps.length,
    unreadableSteps: nodes.length - parsedNodes.length,
    waiting: live ? (attentionWaiting(run) ?? waitOf(metadata)) : null,
    children: live ? childIds(run) : null,
    ...(question === null ? {} : { question }),
    ...(own(run, 'owner_observation') === 'unreachable' ? { ownerUnreachable: true as const } : {})
  }
}

/** A sub-run's workflow and status, or nulls when it cannot be read. */
function parseChild(id: string, value: unknown): ChildRow {
  const run = isRecord(value) ? own(value, 'run') : undefined
  const workflow = isRecord(run) ? own(run, 'workflow_name') : undefined
  const status = isRecord(run) ? own(run, 'status') : undefined
  return { id, workflow: isText(workflow) ? workflow : null, status: isStatus(status) ? status : null }
}

export type RunDetailPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
  /** Orca's workspaces, so a run whose folder Orca lists can be opened there. None when left out. */
  workspaces?(): Promise<readonly Pick<WorkspaceRow, 'id' | 'path'>[]>
  /** Why Open graph is off for a run with or without a project, or null when it is on. Never off when left out. */
  graphOff?(hasProject: boolean): Promise<string | null>
  /** Told the question of each run read, or null when it waits on none or is gone, so an answer can be checked against it. */
  questionRead?(runId: string, question: Question | null): void
  now(): number
}

/** Answers the frames' `run.read`. */
export function startRunDetail(orca: OrcaWorkerApi, ports: RunDetailPorts): Disposable {
  /** Each run's sub-runs, as last looked up, newest last. */
  const childLookups = new Map<string, { at: number; rows: Map<string, ChildRow> }>()
  let projects: { at: number; names: Map<string, string> } | undefined

  /** Whether a lookup is missing or was made at least `LOOKUP_MS` ago. */
  const isOld = (lookup: { at: number } | undefined): boolean => lookup === undefined || ports.now() - lookup.at >= LOOKUP_MS

  const get = (server: Connected, path: string, signal: AbortSignal) =>
    ports.client.request({ baseUrl: server.baseUrl, path, timeout: 'read', signal })

  /** The project's name, from Archon's list, read again on open and once the last read is old. */
  async function projectName(server: Connected, codebaseId: string, open: boolean, signal: AbortSignal): Promise<string | null> {
    if (open || isOld(projects)) {
      const answer = await get(server, CODEBASES_PATH, signal)
      const list = answer.ok ? parseCodebases(answer.value) : null
      if (list !== null) projects = { at: ports.now(), names: new Map(list.projects.map((project) => [project.id, project.name])) }
    }
    return projects?.names.get(codebaseId) ?? null
  }

  /** The sub-run rows, looked up on open and once the last lookup is old, else from that lookup. */
  async function childRows(server: Connected, runId: string, ids: string[], open: boolean, signal: AbortSignal): Promise<ChildRow[]> {
    const shown = ids.slice(0, CHILD_ROWS_CAP)
    const held = childLookups.get(runId)
    if (open || isOld(held)) {
      const rows = await Promise.all(
        shown.map(async (id) => {
          const answer = await get(server, `${RUN_PATH}${encodeURIComponent(id)}`, signal)
          return parseChild(id, answer.ok ? answer.value : null)
        })
      )
      childLookups.delete(runId)
      childLookups.set(runId, { at: ports.now(), rows: new Map(rows.map((row) => [row.id, row])) })
      while (childLookups.size > KEPT_LOOKUPS) childLookups.delete(childLookups.keys().next().value as string)
    }
    const looked = childLookups.get(runId)?.rows
    return shown.map((id) => looked?.get(id) ?? { id, workflow: null, status: null })
  }

  /** The run's view, and for a ready run why Open graph is off, when it is. */
  async function read(server: Connected, request: RunDetailRequest, signal: AbortSignal): Promise<Omit<RunDetailAnswer, 'connection'>> {
    const fetched = await readRun(ports.client, server, request.runId, signal)
    if (fetched.kind === 'gone') ports.questionRead?.(request.runId, null)
    if (fetched.kind !== 'run') return { run: fetched }
    const parsed = fetched.run
    ports.questionRead?.(request.runId, parsed.question ?? null)
    const open = request.open === true
    const { codebaseId, children, waiting, ...facts } = parsed
    const project = codebaseId === null ? null : await projectName(server, codebaseId, open, signal)
    const detail: RunDetail = {
      ...facts,
      project,
      waiting:
        children === null || children.length === 0
          ? waiting
          : {
              kind: 'children',
              children: await childRows(server, parsed.id, children, open, signal),
              more: Math.max(0, children.length - CHILD_ROWS_CAP)
            }
    }
    if (detail.workingPath !== null && ports.workspaces !== undefined) {
      const workspaceId = workspaceIdFor(detail.workingPath, await ports.workspaces())
      if (workspaceId !== undefined) detail.workspaceId = workspaceId
    }
    const graphOff = ports.graphOff === undefined ? null : await ports.graphOff(codebaseId !== null)
    return { run: { kind: 'ready', detail }, ...(graphOff === null ? {} : { graphOff }) }
  }

  return orca.panels.handle('run.read', async (input, context): Promise<RunDetailAnswer> => {
    const request = parseRunDetailRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection, run: { kind: 'not-connected' } }
    const parts = await read(connection, request, context.signal)
    return { connection: await ports.current(), ...parts }
  })
}
