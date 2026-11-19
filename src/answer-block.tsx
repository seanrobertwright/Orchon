// The answer block at the top of run detail: a gate's decisions and an attention wait's form
// (#14, parts 4 to 6 and 8). It draws the question the worker read and sends an answer only on a
// button press, guarded by the identity of the question the block was drawn for. What the person
// typed or chose is a draft held in memory per question while the panel is open: a read of the
// same question leaves it alone, and a read of a new one discards it and says so. The write
// itself goes through the action row's rule of one write per run, and its outcome shows there.
import { atom, Button, Checkbox, Markdown, RadioGroup, read, Row, set, Stack, Text, Textarea, update, type OrcaNode, type RadioOption } from 'orca'
import { sendAnswer, writeInFlight, type RunActionHooks, type Shown } from './run-actions'
import { ANSWER_TEXT_CAP, type GateDecision, type Question, type WaitOption } from './run-answer-view'
import type { RunDetail } from './run-detail-view'

/** What a person typed or chose for one question, before it was sent. */
type Draft = {
  /** The identity of the question the draft was written for. */
  key: string
  text: string
  /** The options chosen. An answer sends them in the wait's order. */
  chosen: readonly string[]
  /** The gate decision that needs text, once pressed, or null while the decisions show. */
  decision: string | null
}

/** How many runs' drafts are kept. The one written to longest ago goes first. */
const DRAFTS_KEPT = 50

/** The drafts by run. A run's draft belongs to one question: its `key`. */
const drafts = atom<ReadonlyMap<string, Draft>>(new Map())
/** The runs whose draft was discarded because the run moved on to a new question. */
const movedOn = atom<readonly string[]>([])
/** The question answered last on each run, and whether it was a gate with no pause id. */
const answered = atom<ReadonlyMap<string, { key: string; pauseless: boolean }>>(new Map())

export const MOVED_ON_TEXT = 'The run moved on to a new question. Your unsent answer was discarded.'
export const STALE_TEXT = 'This question was already answered, or the run moved on.'
export const ANSWERED_TEXT = 'Answered. Waiting for Archon to continue this run.'

/** The identity of a question: what tells it from the next one. */
export function questionKey(question: Question): string {
  return question.kind === 'gate' ? `gate\n${question.nodeId}\n${question.pauseId ?? ''}` : `wait\n${question.occurrence}`
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined, cap: number): ReadonlyMap<string, V> {
  const next = new Map(map)
  next.delete(key)
  if (value !== undefined) next.set(key, value)
  while (next.size > cap) next.delete(next.keys().next().value as string)
  return next
}

const emptyDraft = (key: string): Draft => ({ key, text: '', chosen: [], decision: null })

/** The draft for the question shown, or an empty one. */
function draftOf(runId: string, key: string): Draft {
  const held = read(drafts).get(runId)
  return held !== undefined && held.key === key ? held : emptyDraft(key)
}

function editDraft(runId: string, key: string, change: Partial<Omit<Draft, 'key'>>): void {
  const next = { ...draftOf(runId, key), ...change }
  update(drafts, (held) => withEntry(held, runId, next, DRAFTS_KEPT))
  if (read(movedOn).includes(runId)) update(movedOn, (held) => held.filter((id) => id !== runId))
}

function dropDraft(runId: string): void {
  if (read(drafts).has(runId)) update(drafts, (held) => withEntry(held, runId, undefined, DRAFTS_KEPT))
}

/**
 * The run was read again. A draft written for another question is discarded, with a line saying
 * so when the run now waits on a new one; a run no longer paused drops its draft quietly. The
 * answered line holds while the run is paused at the question answered, or at none.
 */
export function answerBlockRead(detail: RunDetail): void {
  const key = detail.question === undefined ? null : questionKey(detail.question)
  const draft = read(drafts).get(detail.id)
  if (draft !== undefined && draft.key !== key) {
    if (key !== null) {
      dropDraft(detail.id)
      update(movedOn, (held) => [...held.filter((id) => id !== detail.id), detail.id].slice(-DRAFTS_KEPT))
    } else if (detail.status !== 'paused') dropDraft(detail.id)
  }
  const done = read(answered).get(detail.id)
  if (done !== undefined && (detail.status !== 'paused' || (key !== null && key !== done.key))) {
    update(answered, (held) => withEntry(held, detail.id, undefined, DRAFTS_KEPT))
  }
}

/** The person left the run: the moved-on line goes. Drafts stay for when they come back. */
export function resetAnswerBlock(): void {
  set(movedOn, [])
}

/** A different Archon store: nothing typed for the old one is kept. */
export function clearAnswerBlock(): void {
  set(drafts, new Map())
  set(movedOn, [])
  set(answered, new Map())
}

/** Whether the run shows the answered line: paused at the question answered, or at none. */
function showsAnswered(detail: RunDetail): { pauseless: boolean } | null {
  const done = read(answered).get(detail.id)
  if (done === undefined || detail.status !== 'paused') return null
  if (detail.question !== undefined && questionKey(detail.question) !== done.key) return null
  return done
}

/** Whether the action row offers Resume: the answered gate had no pause id and the run is still paused. */
export function resumeAfterAnswer(detail: RunDetail): boolean {
  return showsAnswered(detail)?.pauseless === true
}

/** Sends an answer for the question the block was drawn for, and settles the draft by its outcome. */
function answer(question: Question, input: Parameters<typeof sendAnswer>[0], hooks: RunActionHooks): void {
  const { runId } = input
  const key = questionKey(question)
  sendAnswer(input, hooks, (outcome: Shown): Shown => {
    if (outcome.kind === 'done') {
      dropDraft(runId)
      update(answered, (held) => withEntry(held, runId, { key, pauseless: question.kind === 'gate' && question.pauseId === null }, DRAFTS_KEPT))
    }
    if (outcome.kind === 'refused' && outcome.status === 409) {
      dropDraft(runId)
      return { kind: 'refused', status: 409, message: STALE_TEXT }
    }
    return outcome
  })
}

const hasText = (text: string): boolean => text.trim() !== ''

/** The text a press sends: what was typed, or nothing when only spaces were. The worker trims it. */
const textPart = (text: string): { text?: string } => (hasText(text) ? { text } : {})

/** A decision's name on its button (#14, part 4). Approve's depends on whether the step signalled it has finished. */
function decisionLabel(question: Extract<Question, { kind: 'gate' }>, decision: GateDecision, text: string): string {
  if (question.authored) return decision.label ?? decision.id
  if (decision.id === 'approve') return question.completionSignaled && !hasText(text) ? 'Accept & complete' : 'Continue'
  if (decision.id === 'reject') return 'Reject'
  return decision.label ?? decision.id
}

/** The block's title, the step and the message, with a line when the message was cut. */
function heading(title: string, question: Question): OrcaNode {
  return (
    <>
      <Text weight="semibold">{title}</Text>
      <Text muted size="sm">{`Step: ${question.nodeId}`}</Text>
      {question.message === '' ? null : <Markdown content={question.message} />}
      {question.messageCut ? (
        <Text muted size="sm">
          The message is cut at 16 KiB. Open Archon&apos;s console to read all of it.
        </Text>
      ) : null}
    </>
  )
}

function gateBlock(detail: RunDetail, question: Extract<Question, { kind: 'gate' }>, off: boolean, hooks: RunActionHooks): OrcaNode {
  const key = questionKey(question)
  const draft = draftOf(detail.id, key)
  const send = (decision: string): void =>
    answer(
      question,
      {
        runId: detail.id,
        kind: 'gate',
        nodeId: question.nodeId,
        ...(question.pauseId === null ? {} : { pauseId: question.pauseId }),
        decision,
        ...textPart(draft.text)
      },
      hooks
    )
  const pressed = draft.decision === null ? undefined : question.decisions.find((decision) => decision.id === draft.decision)
  if (pressed !== undefined) {
    const label = decisionLabel(question, pressed, draft.text)
    return (
      <>
        <Textarea
          label={`Your reason to ${label}`}
          rows={4}
          maxLength={ANSWER_TEXT_CAP}
          value={draft.text}
          disabled={off}
          onChange={(text) => editDraft(detail.id, key, { text })}
        />
        <Row gap="sm" wrap>
          <Button size="sm" variant="outline" disabled={writeInFlight(detail.id)} onPress={() => editDraft(detail.id, key, { decision: null })}>
            Back
          </Button>
          <Button size="sm" disabled={off || !hasText(draft.text)} onPress={() => send(pressed.id)}>
            {writeInFlight(detail.id) ? 'Answering…' : label}
          </Button>
        </Row>
      </>
    )
  }
  const approve = question.decisions.find((decision) => decision.id === 'approve')
  return (
    <>
      {approve === undefined ? null : (
        <Textarea
          label="Comment (optional)"
          rows={3}
          maxLength={ANSWER_TEXT_CAP}
          value={draft.text}
          disabled={off}
          onChange={(text) => editDraft(detail.id, key, { text })}
        />
      )}
      <Row gap="sm" wrap>
        {question.decisions.map((decision) => (
          <Button
            key={decision.id}
            size="sm"
            variant={decision.id === 'approve' ? 'solid' : 'outline'}
            disabled={off}
            onPress={() => (decision.id === 'approve' ? send(decision.id) : editDraft(detail.id, key, { decision: decision.id }))}
          >
            {decision.id === 'approve' && writeInFlight(detail.id) ? 'Answering…' : decisionLabel(question, decision, draft.text)}
          </Button>
        ))}
      </Row>
    </>
  )
}

type Wait = Extract<Question, { kind: 'wait' }>

/** An option's name: its label, or its id when it has none. */
const optionName = (option: WaitOption): string => option.label ?? option.id

/** Whether Answer can send: the box has text for a message, one option for a radio group, one or more for checkboxes. */
function canAnswer(question: Wait, draft: Draft): boolean {
  if (question.form === 'message') return hasText(draft.text)
  if (question.form === 'multi_select') return draft.chosen.length > 0
  return draft.chosen.length === 1
}

function waitBlock(detail: RunDetail, question: Wait, off: boolean, hooks: RunActionHooks): OrcaNode {
  if (question.form === 'legacy') return <Text>This wait was paused before Archon took answers, so it has no form. Resume continues the run.</Text>
  if (question.form === 'unknown') {
    return <Text>This wait asks in a way this version of Orchon does not know. Open Archon&apos;s console to answer it.</Text>
  }
  const key = questionKey(question)
  const draft = draftOf(detail.id, key)
  const message = question.form === 'message'
  const recommended = question.recommendation === null ? undefined : question.options.find((option) => option.id === question.recommendation?.option)
  let choices: OrcaNode = null
  if (question.form === 'multi_select') {
    choices = question.options.map((option) => (
      <Checkbox
        key={option.id}
        label={optionName(option)}
        {...(option.does === null ? {} : { description: option.does })}
        checked={draft.chosen.includes(option.id)}
        disabled={off}
        onChange={(checked) =>
          editDraft(detail.id, key, { chosen: checked ? [...draft.chosen.filter((id) => id !== option.id), option.id] : draft.chosen.filter((id) => id !== option.id) })
        }
      />
    ))
  } else if (!message) {
    const options: RadioOption[] = question.options.map((option) => ({
      value: option.id,
      label: optionName(option),
      ...(option.does === null ? {} : { description: option.does })
    }))
    const chosen = draft.chosen[0]
    choices = (
      <RadioGroup
        label="Options"
        options={options}
        {...(chosen === undefined ? {} : { value: chosen })}
        disabled={off}
        onChange={(value) => {
          if (question.options.some((option) => option.id === value)) editDraft(detail.id, key, { chosen: [value] })
        }}
      />
    )
  }
  return (
    <>
      {choices}
      {recommended === undefined || question.recommendation === null ? null : (
        <Text muted size="sm">
          {`Recommended: ${optionName(recommended)}.${question.recommendation.why === '' ? '' : ` ${question.recommendation.why}`}`}
        </Text>
      )}
      {question.moreOptions > 0 ? (
        <Text muted size="sm">
          {`${String(question.moreOptions)} more ${question.moreOptions === 1 ? 'option is' : 'options are'} not shown. Open Archon's console to choose one of them.`}
        </Text>
      ) : null}
      <Textarea
        label={message ? 'Your answer' : 'Comment (optional)'}
        rows={message ? 4 : 3}
        maxLength={ANSWER_TEXT_CAP}
        value={draft.text}
        disabled={off}
        onChange={(text) => editDraft(detail.id, key, { text })}
      />
      <Row gap="sm" wrap>
        <Button
          size="sm"
          disabled={off || !canAnswer(question, draft)}
          onPress={() =>
            answer(question, { runId: detail.id, kind: 'wait', occurrence: question.occurrence, choose: question.options.filter((option) => draft.chosen.includes(option.id)).map((option) => option.id), ...textPart(draft.text) }, hooks)
          }
        >
          {writeInFlight(detail.id) ? 'Answering…' : 'Answer'}
        </Button>
      </Row>
    </>
  )
}

/**
 * The answer block, or null when the run waits on no question. `writable` is false while
 * Searching. The moved-on line shows above a new question whose run discarded a draft.
 */
export function answerBlock(detail: RunDetail, writable: boolean, hooks: RunActionHooks): OrcaNode {
  if (showsAnswered(detail) !== null) return <Text>{ANSWERED_TEXT}</Text>
  const question = detail.question
  if (question === undefined || detail.status !== 'paused') return null
  const off = !writable || writeInFlight(detail.id)
  const notice = read(movedOn).includes(detail.id) ? <Text>{MOVED_ON_TEXT}</Text> : null
  if (question.kind === 'gate') {
    return (
      <Stack gap="sm">
        {notice}
        {heading('Waiting for your decision', question)}
        {gateBlock(detail, question, off, hooks)}
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      {notice}
      {heading('Waiting for your answer', question)}
      {waitBlock(detail, question, off, hooks)}
    </Stack>
  )
}
