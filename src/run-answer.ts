// Answering a question: the worker's side of a gate's `respond` and an attention wait's `answer`.
// The worker is the boundary (#14, part 9). It remembers the question it last read for each run,
// refuses as stale, without asking Archon, an answer for any other question or with a decision or
// option id it did not read for that one, and builds the body from a fixed list of keys, with the
// guard taken from the question the answer was written for. Gates go through `respond` only.
import { isRecord, isText, own, refuseRequest } from './records'
import { ANSWER_TEXT_CAP, type Question, type RunAnswerRequest } from './run-answer-view'

/** How many runs' last-read questions the worker keeps. The oldest read goes first. */
const KEPT_QUESTIONS = 200

/** What the worker last read for each run: the question, or nothing when it waits on none. */
export type QuestionMemory = {
  /** Run detail read the run: remember its question, or forget the one before when it has none. */
  read(runId: string, question: Question | null): void
  lastRead(runId: string): Question | undefined
}

export function createQuestionMemory(): QuestionMemory {
  const held = new Map<string, Question>()
  return {
    read(runId, question) {
      held.delete(runId)
      if (question === null) return
      held.set(runId, question)
      while (held.size > KEPT_QUESTIONS) held.delete(held.keys().next().value as string)
    },
    lastRead: (runId) => held.get(runId)
  }
}

/** The worker's own refusal of an answer for a question it did not last read. */
export const STALE_ANSWER_TEXT = 'Orchon has not read this question as it stands now, so nothing was sent. The run was read again: check the question and answer again.'

/** A run id the worker writes to: 1 to 64 letters, digits, `-` and `_`. It is still encoded in the path. */
const WRITE_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/

/** How many ids `choose` may hold: more than any wait the worker shows. */
const CHOOSE_CAP = 50

const GATE_KEYS = ['runId', 'kind', 'nodeId', 'pauseId', 'decision', 'text']
const WAIT_KEYS = ['runId', 'kind', 'occurrence', 'choose', 'text']

/** An id the request names: 1 to 200 characters. */
function idOf(input: Record<string, unknown>, key: string, name: string): string {
  const value = own(input, key)
  if (!isText(value) || value.length > 200) refuseRequest(`${name} must be text of 1 to 200 characters.`)
  return value
}

/** A frame's answer, or a refusal: a known kind, the identity, the answer, and nothing else. */
export function parseRunAnswerRequest(input: unknown): RunAnswerRequest {
  if (!isRecord(input)) refuseRequest('An answer takes a run id, the question and the answer.')
  const runId = own(input, 'runId')
  if (typeof runId !== 'string' || !WRITE_RUN_ID.test(runId)) refuseRequest('The run id must be 1 to 64 letters, digits, - and _.')
  const kind = own(input, 'kind')
  if (kind !== 'gate' && kind !== 'wait') refuseRequest('An answer is for a gate or a wait.')
  for (const key of Object.keys(input)) {
    if (!(kind === 'gate' ? GATE_KEYS : WAIT_KEYS).includes(key)) refuseRequest(`An answer to a ${kind} does not take ${key}.`)
  }
  const text = own(input, 'text')
  if (text !== undefined && (typeof text !== 'string' || text.length > ANSWER_TEXT_CAP)) {
    refuseRequest(`The text must be at most ${ANSWER_TEXT_CAP.toLocaleString('en-US')} characters.`)
  }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const withText = trimmed === '' ? {} : { text: trimmed }
  if (kind === 'gate') {
    const nodeId = idOf(input, 'nodeId', 'The node id')
    const pauseId = own(input, 'pauseId') === undefined ? undefined : idOf(input, 'pauseId', 'The pause id')
    const decision = idOf(input, 'decision', 'The decision')
    return { runId, kind, nodeId, ...(pauseId === undefined ? {} : { pauseId }), decision, ...withText }
  }
  const occurrence = idOf(input, 'occurrence', 'The occurrence')
  const choose = own(input, 'choose')
  if (!Array.isArray(choose) || choose.length > CHOOSE_CAP || !(choose as unknown[]).every((id) => isText(id) && id.length <= 200)) {
    refuseRequest(`Choose must be a list of at most ${String(CHOOSE_CAP)} option ids.`)
  }
  return { runId, kind, occurrence, choose: [...(choose as string[])], ...withText }
}

/** What to send for an answer: the route and the body, or null when the answer is stale. */
export type AnswerWrite = { route: 'respond' | 'answer'; body: Record<string, unknown> }

/**
 * The write for an answer to the question the worker last read, or null when the answer names
 * another question, or a decision or option that question does not have, or does not fit its form.
 */
export function answerWrite(request: RunAnswerRequest, question: Question | undefined): AnswerWrite | null {
  if (question === undefined) return null
  const text = request.text === undefined ? {} : { text: request.text }
  if (request.kind === 'gate') {
    if (question.kind !== 'gate' || question.nodeId !== request.nodeId || question.pauseId !== (request.pauseId ?? null)) return null
    if (!question.decisions.some((decision) => decision.id === request.decision)) return null
    const expectedGate = question.pauseId === null ? question.nodeId : { nodeId: question.nodeId, pauseId: question.pauseId }
    return { route: 'respond', body: { decision: request.decision, ...text, expectedGate } }
  }
  if (question.kind !== 'wait' || question.occurrence !== request.occurrence) return null
  const { choose } = request
  if (new Set(choose).size !== choose.length || !choose.every((id) => question.options.some((option) => option.id === id))) return null
  switch (question.form) {
    case 'message':
      if (choose.length > 0 || request.text === undefined) return null
      return { route: 'answer', body: { occurrence: question.occurrence, ...text } }
    case 'approval':
    case 'select':
      if (choose.length !== 1) return null
      break
    case 'multi_select':
      if (choose.length === 0) return null
      break
    case 'legacy':
    case 'unknown':
      return null
  }
  return { route: 'answer', body: { occurrence: question.occurrence, choose, ...text } }
}
