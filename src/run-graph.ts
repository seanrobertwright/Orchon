// The run graph tab's request in the worker (#17, part 8; #11): the run read from
// `GET /api/workflows/runs/{runId}`, its workflow as it is now from `GET /api/workflows/{name}`
// with the project's folder as `cwd`, and the run's states attached by step id. On a mismatch,
// the run's own steps in run order with no edges. Only ids, kinds, nesting, `depends_on` and
// whether a step has a `when` are read from the workflow; prompts and scripts are dropped. From
// the run's events, each step's latest start gives its summary card's facts: duration, cost,
// model, skip reason and its output cut at 4 KiB, within a budget for the whole answer. The
// worker serves the request from the moment it starts, so a tab Orca restores after a restart
// is answered before any panel opens.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import { formatDateTime, formatDuration } from './dates'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, ownRecord, refuseOtherKeys, refuseRequest } from './records'
import { readRun } from './run-detail'
import { RUN_ID_CAP, type Step } from './run-detail-view'
import { statusText } from './run-status-words'
import type { RunStatus } from './runs-view'
import { stepWords } from './step-tree'
import { tabConnection } from './tab-screen'
import { NO_PROJECT_GRAPH } from './wide-tabs'
import type {
  GraphAnswer,
  GraphEdge,
  GraphHeader,
  GraphRequest,
  GraphStep,
  GraphStepState,
  GraphStepSummary,
  GraphView
} from '../editors/run-graph/graph-view'

/** The most steps one graph lays out (#17). The builder uses the same number. */
export const GRAPH_STEPS_CAP = 300

const WORKFLOW_PATH = '/api/workflows/'
const PROJECT_GONE = "Archon no longer lists this run's project, so its workflow cannot be read."
export const ANSWERED_IN_PANEL = 'Answered in the Orchon panel.'

/** A BCP-47 tag as Orca gives one: letters, digits and dashes. */
const LOCALE = /^[A-Za-z0-9-]{1,35}$/

/** The tab's request, or a refusal: a run id of 1 to the cap and a language tag, and nothing else. */
export function parseGraphRequest(input: unknown): GraphRequest {
  if (!isRecord(input)) refuseRequest('The run graph request takes a run id and a language.')
  const runId = own(input, 'runId')
  if (!isCappedText(runId, RUN_ID_CAP)) refuseRequest(cappedTextRefusal('The run id', RUN_ID_CAP))
  const locale = own(input, 'locale')
  if (typeof locale !== 'string' || !LOCALE.test(locale)) refuseRequest('The language must be a language tag such as en-US.')
  refuseOtherKeys(input, ['runId', 'locale'], 'The run graph request')
  return { runId, locale }
}

/** One node of the workflow file, as the graph reads it. */
type FileNode = { id: string; kind: string | null; dependsOn: string[]; conditional: boolean; children: FileNode[] | null }

/** The nodes of one level of the file, or null when the level is not a list. A node with no id is passed over. */
function parseNodes(value: unknown): FileNode[] | null {
  if (!Array.isArray(value)) return null
  const nodes: FileNode[] = []
  for (const item of value as unknown[]) {
    if (!isRecord(item)) continue
    const id = own(item, 'id')
    if (!isText(id)) continue
    const kind = own(item, 'kind')
    const depends = own(item, 'depends_on')
    const group = own(item, 'loop_group')
    nodes.push({
      id,
      kind: isText(kind) ? kind : null,
      dependsOn: Array.isArray(depends) ? (depends as unknown[]).filter(isText) : [],
      conditional: isText(own(item, 'when')),
      children: isRecord(group) ? (parseNodes(own(group, 'nodes')) ?? []) : null
    })
  }
  return nodes
}

/** The workflow's top-level nodes from `GET /api/workflows/{name}`, or null when the answer has none. */
function parseWorkflow(value: unknown): FileNode[] | null {
  if (!isRecord(value)) return null
  const workflow = own(value, 'workflow')
  return isRecord(workflow) ? parseNodes(own(workflow, 'nodes')) : null
}

const LIVE: readonly RunStatus[] = ['running', 'paused', 'pending']

/** The most characters of one step's output the graph answer carries: 4 KiB (#17). */
export const GRAPH_OUTPUT_CAP = 4 * 1024
/**
 * The most bytes of output, as JSON text, one graph answer carries over all its steps, so the
 * answer stays well inside a request answer's 1 MiB with 300 steps. Steps past it, in the
 * graph's order, carry none and say so.
 */
export const GRAPH_OUTPUT_BUDGET_BYTES = 384 * 1024

/** Archon's skip reasons as a sentence. A reason it adds later is shown as Archon names it. */
const SKIP_REASONS: Record<string, string> = {
  prior_success: 'It had completed before the run resumed.',
  when_condition: 'Its when condition was false.',
  when_condition_parse_error: 'Its when condition could not be read.',
  trigger_rule: 'Its trigger rule was not met.',
  timeout: 'It timed out.'
}
const NO_SKIP_REASON = 'Archon gave no reason.'

/** What the run's events say about one step's latest start, before its output is cut. */
type StepFacts = { durationMs: number | null; costUsd: number | null; model: string | null; skipReason: string | null; output: string }

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** A measurement Archon reported, `{ source: "provider", value }`, or undefined. */
function reported(record: Record<string, unknown>, key: string): unknown {
  const measured = ownRecord(record, key)
  return own(measured, 'source') === 'provider' ? own(measured, 'value') : undefined
}

/** The model a start used: the one the provider reported, else the one asked for. */
function modelOf(data: Record<string, unknown>): string | null {
  const model = ownRecord(ownRecord(data, 'binding'), 'model')
  const resolved = reported(model, 'resolved')
  if (isText(resolved)) return resolved
  const usage = own(ownRecord(data, 'model_usage'), 'resolved')
  if (isText(usage)) return usage
  const requested = own(model, 'requested')
  return isText(requested) ? requested : null
}

function costOf(data: Record<string, unknown>): number | null {
  const fromSpend = reported(ownRecord(data, 'spend'), 'costUsd')
  if (isAmount(fromSpend)) return fromSpend
  const flat = own(data, 'cost_usd')
  return isAmount(flat) ? flat : null
}

function durationOf(data: Record<string, unknown>): number | null {
  const fromTiming = own(ownRecord(data, 'timing'), 'durationMs')
  if (isAmount(fromTiming)) return fromTiming
  const flat = own(data, 'duration_ms')
  return isAmount(flat) ? flat : null
}

const blank = (): StepFacts => ({ durationMs: null, costUsd: null, model: null, skipReason: null, output: '' })

/** Folds the run's events into each step's latest start, in one pass. An event that cannot be read is passed over. */
function foldFacts(value: unknown): Map<string, StepFacts> {
  const facts = new Map<string, StepFacts>()
  const events = isRecord(value) ? own(value, 'events') : undefined
  if (!Array.isArray(events)) return facts
  for (const event of events as unknown[]) {
    if (!isRecord(event)) continue
    const id = own(event, 'step_name')
    const type = own(event, 'event_type')
    if (!isText(id) || !isText(type)) continue
    const data = ownRecord(event, 'data')
    if (type === 'node_started') {
      facts.set(id, { ...blank(), model: modelOf(data) })
    } else if (type === 'node_completed' || type === 'node_failed') {
      const output = own(data, 'node_output')
      facts.set(id, {
        durationMs: durationOf(data),
        costUsd: costOf(data),
        model: modelOf(data) ?? facts.get(id)?.model ?? null,
        skipReason: null,
        output: typeof output === 'string' ? output : ''
      })
    } else if (type === 'node_skipped' || type.startsWith('node_skipped_')) {
      const reason = own(data, 'reason')
      const said = isText(reason) ? (Object.hasOwn(SKIP_REASONS, reason) ? SKIP_REASONS[reason] : reason) : undefined
      facts.set(id, { ...blank(), skipReason: said ?? NO_SKIP_REASON })
    }
  }
  return facts
}

/** What a cost reads as on the card, as the panel's run facts write it. */
function costText(cost: number | null): string | null {
  if (cost === null) return null
  if (cost > 0 && cost < 0.005) return 'Under $0.01'
  return `$${cost.toFixed(2)}`
}

const encoder = new TextEncoder()

/**
 * Each step with its summary, in the graph's order. Output is cut at `GRAPH_OUTPUT_CAP`, and once
 * the answer's output would pass `GRAPH_OUTPUT_BUDGET_BYTES` a step carries none.
 */
function withSummaries(steps: readonly GraphStep[], facts: ReadonlyMap<string, StepFacts>): GraphStep[] {
  let spent = 0
  return steps.map((step) => {
    const known = facts.get(step.id) ?? blank()
    const cut = cutAt(known.output, GRAPH_OUTPUT_CAP)
    const size = cut === '' ? 0 : encoder.encode(JSON.stringify(cut)).length
    const fits = spent + size <= GRAPH_OUTPUT_BUDGET_BYTES
    if (fits) spent += size
    const summary: GraphStepSummary = {
      duration: known.durationMs === null || step.state === 'running' ? null : formatDuration(known.durationMs),
      cost: costText(known.costUsd),
      model: known.model,
      skipReason: known.skipReason,
      output: fits ? cut : '',
      outputShown: !fits ? 'withheld' : cut.length < known.output.length ? 'cut' : 'whole'
    }
    return { ...step, summary }
  })
}

/** A step's state as the tab shows it, from the run's step and the run's status. */
function stateOf(step: Pick<Step, 'state' | 'reached'>, run: RunStatus): GraphStepState {
  switch (step.state) {
    case 'running':
      return run === 'paused' ? 'waiting' : 'running'
    case 'pending':
      return step.reached ? 'queued' : 'not-reached'
    default:
      return step.state
  }
}

function graphStep(
  facts: { id: string; name: string; kind: string | null; group: string | null; isGroup: boolean; conditional: boolean },
  ran: Step | undefined,
  run: RunStatus
): GraphStep {
  const step = ran ?? { state: 'pending' as const, reached: false }
  const { glyph, word } = stepWords({ ...(ran ?? stubStep(facts.id)), state: step.state, reached: step.reached }, run)
  const state = stateOf(step, run)
  return { ...facts, state, glyph, word, note: state === 'waiting' ? ANSWERED_IN_PANEL : null }
}

/** A step the run does not list, as the words take it: not reached. */
const stubStep = (id: string): Step => ({ id, name: id, kind: null, state: 'pending', loop: null, starts: 0, durationMs: null, reached: false })

/** The file's steps, groups before their own, with each one's state, and the edges at each level. */
function fromFile(nodes: readonly FileNode[], ran: ReadonlyMap<string, Step>, run: RunStatus): { steps: GraphStep[]; edges: GraphEdge[] } {
  const steps: GraphStep[] = []
  const edges: GraphEdge[] = []
  const visit = (level: readonly FileNode[], group: string | null): void => {
    const prefix = group === null ? '' : `${group}.`
    const ids = new Set(level.map((node) => node.id))
    for (const node of level) {
      const id = `${prefix}${node.id}`
      const kind = node.kind ?? ran.get(id)?.kind ?? null
      steps.push(graphStep({ id, name: node.id, kind, group, isGroup: node.children !== null, conditional: node.conditional }, ran.get(id), run))
      for (const dependency of node.dependsOn) if (ids.has(dependency)) edges.push({ from: `${prefix}${dependency}`, to: id })
      if (node.children !== null) visit(node.children, id)
    }
  }
  visit(nodes, null)
  return { steps, edges }
}

/** The run's own steps in run order, with no groups, for a mismatch. */
function fromRun(steps: readonly Step[], run: RunStatus): GraphStep[] {
  return steps.map((step) =>
    graphStep({ id: step.id, name: step.loop === null ? step.name : step.id, kind: step.kind, group: null, isGroup: false, conditional: false }, step, run)
  )
}

/** The run's top-level step ids: `metadata.terminal_graph.node_ids` when it lists them, else its steps with no dot. */
function runTopIds(value: unknown, steps: readonly Step[]): Set<string> {
  const run = isRecord(value) ? own(value, 'run') : undefined
  const graph = isRecord(run) ? ownRecord(ownRecord(run, 'metadata'), 'terminal_graph') : {}
  const listed = own(graph, 'node_ids')
  if (Array.isArray(listed)) return new Set((listed as unknown[]).filter(isText))
  return new Set(steps.filter((step) => !step.id.includes('.')).map((step) => step.id))
}

/** Whether the file no longer fits the run (#17): either direction for a finished run, a step the file lacks for a live one. */
function mismatched(runIds: ReadonlySet<string>, fileIds: ReadonlySet<string>, live: boolean): boolean {
  for (const id of runIds) if (!fileIds.has(id)) return true
  if (live) return false
  for (const id of fileIds) if (!runIds.has(id)) return true
  return false
}

export type RunGraphPorts = {
  client: Client
  current(): Promise<ConnectionView>
}

/** Answers the graph tabs' `graph.read`. */
export function startRunGraph(orca: OrcaWorkerApi, ports: RunGraphPorts): Disposable {
  const get = (server: Connected, path: string, signal: AbortSignal) =>
    ports.client.request({ baseUrl: server.baseUrl, path, timeout: 'read', signal })

  async function read(server: Connected, request: GraphRequest, signal: AbortSignal): Promise<GraphView> {
    const fetched = await readRun(ports.client, server, request.runId, signal)
    if (fetched.kind !== 'run') return fetched
    const { run } = fetched
    const live = LIVE.includes(run.status)
    const started = run.startedAt === null ? '' : formatDateTime(run.startedAt, request.locale)
    const header: GraphHeader = { workflow: run.workflow, shortId: run.id.slice(0, 8), state: statusText(run.status), started, finished: !live }
    if (run.codebaseId === null) return { kind: 'no-graph', header, message: NO_PROJECT_GRAPH }

    const listed = await get(server, CODEBASES_PATH, signal)
    if (!listed.ok) return { kind: 'failed', message: readFailureText(listed.failure) }
    const projects = parseCodebases(listed.value)
    if (projects === null) return { kind: 'failed', message: unreadableAnswerText(server.version) }
    const project = projects.projects.find((entry) => entry.id === run.codebaseId)
    if (project === undefined) return { kind: 'no-graph', header, message: PROJECT_GONE }

    const path = `${WORKFLOW_PATH}${encodeURIComponent(run.workflow)}?cwd=${encodeURIComponent(project.defaultCwd)}`
    const file = await get(server, path, signal)
    let nodes: FileNode[] | null = null
    if (!file.ok) {
      if (!(file.failure.kind === 'status' && file.failure.status === 404)) return { kind: 'failed', message: readFailureText(file.failure) }
    } else {
      nodes = parseWorkflow(file.value)
      if (nodes === null) return { kind: 'failed', message: unreadableAnswerText(server.version) }
    }

    const ran = new Map(run.steps.map((step) => [step.id, step]))
    const fileIds = new Set((nodes ?? []).map((node) => node.id))
    const mismatch = nodes === null ? 'deleted' : mismatched(runTopIds(fetched.value, run.steps), fileIds, live) ? 'changed' : null
    if (mismatch !== null || nodes === null) {
      if (run.stepCount > GRAPH_STEPS_CAP) return { kind: 'too-many', header, count: run.stepCount, cap: GRAPH_STEPS_CAP }
      const steps = withSummaries(fromRun(run.steps, run.status), foldFacts(fetched.value))
      return { kind: 'ready', header, mismatch: mismatch ?? 'deleted', steps, edges: [] }
    }
    const drawn = fromFile(nodes, ran, run.status)
    if (drawn.steps.length > GRAPH_STEPS_CAP) return { kind: 'too-many', header, count: drawn.steps.length, cap: GRAPH_STEPS_CAP }
    return { kind: 'ready', header, mismatch: null, steps: withSummaries(drawn.steps, foldFacts(fetched.value)), edges: drawn.edges }
  }

  return orca.panels.handle('graph.read', async (input, context): Promise<GraphAnswer> => {
    const request = parseGraphRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection: tabConnection(connection, request.locale), graph: { kind: 'not-connected' } }
    const graph = await read(connection, request, context.signal)
    return { connection: tabConnection(await ports.current(), request.locale), graph }
  })
}
