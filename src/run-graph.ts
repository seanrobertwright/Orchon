// The run graph tab's request in the worker (#17, part 8; #11): the run read from
// `GET /api/workflows/runs/{runId}`, its workflow as it is now from `GET /api/workflows/{name}`
// with the project's folder as `cwd`, and the run's states attached by step id. On a mismatch,
// the run's own steps in run order with no edges. Only ids, kinds, nesting, `depends_on` and
// whether a step has a `when` are read from the workflow; prompts and scripts are dropped. The
// worker serves the request from the moment it starts, so a tab Orca restores after a restart
// is answered before any panel opens.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { formatDateTime } from './dates'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, ownRecord, refuseOtherKeys, refuseRequest } from './records'
import { readRun } from './run-detail'
import { RUN_ID_CAP, type Step } from './run-detail-view'
import { statusText } from './run-status-words'
import type { RunStatus } from './runs-view'
import { stepWords } from './step-tree'
import { tabConnection } from './tab-screen'
import { NO_PROJECT_GRAPH } from './wide-tabs'
import type { GraphAnswer, GraphEdge, GraphHeader, GraphRequest, GraphStep, GraphStepState, GraphView } from '../editors/run-graph/graph-view'

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
      return { kind: 'ready', header, mismatch: mismatch ?? 'deleted', steps: fromRun(run.steps, run.status), edges: [] }
    }
    const drawn = fromFile(nodes, ran, run.status)
    if (drawn.steps.length > GRAPH_STEPS_CAP) return { kind: 'too-many', header, count: drawn.steps.length, cap: GRAPH_STEPS_CAP }
    return { kind: 'ready', header, mismatch: null, ...drawn }
  }

  return orca.panels.handle('graph.read', async (input, context): Promise<GraphAnswer> => {
    const request = parseGraphRequest(input)
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { connection: tabConnection(connection, request.locale), graph: { kind: 'not-connected' } }
    const graph = await read(connection, request, context.signal)
    return { connection: tabConnection(await ports.current(), request.locale), graph }
  })
}
