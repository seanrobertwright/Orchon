// Run control: the worker's side of Cancel, Abandon, Resume and Try now, and of an answer to a
// question, whose checks are in `run-answer.ts`. The worker is the
// boundary, so it checks every request itself before anything reaches Archon, sends each write
// once with the write timeout, and never tries one again. The outcomes follow the table of the
// run control decision (#14, part 8).
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client, ClientResult } from './client'
import type { ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import { isRecord, isText, own, refuseRequest } from './records'
import { answerWrite, parseRunAnswerRequest, STALE_ANSWER_TEXT, type QuestionMemory } from './run-answer'
import { RUN_PATH } from './run-detail'
import { RUN_ACTIONS, SERVER_TEXT_CAP, type RunControlAnswer, type RunControlOutcome, type RunControlRequest } from './run-control-view'

/** A field of an answer body, or undefined when the body is not an object or lacks it. */
function ownOf(value: unknown, key: string): unknown {
  return isRecord(value) ? own(value, key) : undefined
}

/** Archon's text, cut at the cap, or null when the field is not text. */
function serverText(value: unknown, key: string): string | null {
  const text = ownOf(value, key)
  return typeof text === 'string' ? cutAt(text, SERVER_TEXT_CAP) : null
}

/** The statuses that, with an `error`, are a refusal (#14, part 8). Any other is a failure. */
const REFUSAL_STATUSES: readonly number[] = [400, 403, 409]

/** What one write's answer means for the person. */
export function controlOutcome(result: ClientResult): RunControlOutcome {
  if (result.ok) {
    const message = serverText(result.value, 'message')
    return message === null ? { kind: 'failed', message: null } : { kind: 'done', message }
  }
  const { failure } = result
  if (failure.kind === 'timeout') return { kind: 'timeout', timeoutMs: failure.timeoutMs }
  if (failure.kind !== 'status') return { kind: 'failed', message: null }
  if (failure.status === 404) return { kind: 'gone' }
  const error = serverText(failure.body, 'error')
  if (REFUSAL_STATUSES.includes(failure.status) && error !== null && error !== '') {
    const child = ownOf(failure.body, 'childRunId')
    return isText(child)
      ? { kind: 'refused', status: failure.status, message: error, childRunId: child }
      : { kind: 'refused', status: failure.status, message: error }
  }
  return { kind: 'failed', message: error === '' ? null : error }
}

/** A run id the worker writes to: 1 to 64 letters, digits, `-` and `_`. It is still encoded in the path. */
const WRITE_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/

/** A frame's request, or a refusal: a run id as above, an action from the closed list, and nothing else. */
export function parseRunControlRequest(input: unknown): RunControlRequest {
  if (!isRecord(input)) refuseRequest('Run control takes a run id and an action.')
  const runId = own(input, 'runId')
  if (typeof runId !== 'string' || !WRITE_RUN_ID.test(runId)) {
    refuseRequest('The run id must be 1 to 64 letters, digits, - and _.')
  }
  const action = own(input, 'action')
  const known = RUN_ACTIONS.find((name) => name === action)
  if (known === undefined) refuseRequest(`The action must be one of ${RUN_ACTIONS.join(', ')}.`)
  for (const key of Object.keys(input)) {
    if (key !== 'runId' && key !== 'action') refuseRequest(`Run control does not take ${key}.`)
  }
  return { runId, action: known }
}

/** The worker's own refusal of a second write to a run while one is in flight. */
export const WRITE_IN_FLIGHT_TEXT = 'Another change to this run is still waiting for Archon.'

export type RunControlPorts = {
  client: Client
  current(): Promise<ConnectionView>
  /** The question run detail last read for each run, which an answer must be written for. No answer is taken when left out. */
  questions?: QuestionMemory
}

/** What a write sends to a run: the route after the run's path and the body, when it has one. */
type RunWrite = { route: string; body?: Record<string, unknown> }

/** Answers the frames' `run.control` and `run.answer`, one write per run at a time across both. */
export function startRunControl(orca: OrcaWorkerApi, ports: RunControlPorts): Disposable {
  /** The runs with a write in flight. A run is in it from the check to the answer. */
  const writing = new Set<string>()
  /**
   * Sends one write to a run, under the one-write-per-run rule, once connected. `build` gives the
   * write, or the text of the worker's own refusal, which is answered without calling Archon.
   */
  async function guardedWrite(runId: string, build: () => RunWrite | string): Promise<RunControlAnswer> {
    if (writing.has(runId)) {
      return { connection: await ports.current(), outcome: { kind: 'refused', status: null, message: WRITE_IN_FLIGHT_TEXT } }
    }
    writing.add(runId)
    try {
      const connection = await ports.current()
      if (connection.kind !== 'connected') return { connection, outcome: { kind: 'not-connected' } }
      const write = build()
      if (typeof write === 'string') return { connection, outcome: { kind: 'refused', status: null, message: write } }
      const { route, body } = write
      const result = await ports.client.request({
        baseUrl: connection.baseUrl,
        path: `${RUN_PATH}${encodeURIComponent(runId)}/${route}`,
        method: 'POST',
        ...(body === undefined ? {} : { body }),
        timeout: 'write',
        errorBody: true
      })
      return { connection: await ports.current(), outcome: controlOutcome(result) }
    } finally {
      writing.delete(runId)
    }
  }
  const answers = orca.panels.handle('run.answer', async (input): Promise<RunControlAnswer> => {
    const request = parseRunAnswerRequest(input)
    return guardedWrite(
      request.runId,
      () => answerWrite(request, ports.questions?.lastRead(request.runId)) ?? STALE_ANSWER_TEXT
    )
  })
  const controls = orca.panels.handle('run.control', async (input): Promise<RunControlAnswer> => {
    const request = parseRunControlRequest(input)
    // Cancel, abandon and resume take no body at the floor, so none is sent: nothing the frame
    // sent is passed through.
    return guardedWrite(request.runId, () => ({ route: request.action }))
  })
  return {
    dispose() {
      answers.dispose()
      controls.dispose()
    }
  }
}
