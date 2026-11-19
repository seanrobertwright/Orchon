// Run detail's action row: Cancel, Abandon, Resume and Try now, as the run control decision sets
// them for each state (#14, parts 1, 3 and 8). Cancel and Abandon confirm inline, with the safe
// button first; Resume and Try now send at once. One write per run is in flight at a time, and
// while it is every write control on that run is off, an answer from the answer block included,
// which shares this rule and the outcome shown under the row. The worker checks each request again and
// sends it once; the panel shows Archon's answer as plain text and reads the run again at once.
// Re-run sits in the same row on the runs the worker offers it for; it writes nothing to Archon,
// it only fills the launcher (#15, #27).
import { atom, Button, Callout, plugin, read, Row, set, Stack, Text, update, type OrcaNode } from 'orca'
import type { ConnectionView } from './connection-view'
import type { RunAnswerRequest } from './run-answer-view'
import type { RunAction, RunControlAnswer, RunControlOutcome } from './run-control-view'
import type { RunDetail } from './run-detail-view'
import { UNREACHABLE_TEXT } from './worker-words'

/** A control of the action row. Try now is the resume route under its own name. */
type Control = 'cancel' | 'abandon' | 'resume' | 'try-now'

const ACTION_OF: Record<Control, RunAction> = { cancel: 'cancel', abandon: 'abandon', resume: 'resume', 'try-now': 'resume' }
const LABEL: Record<Control, string> = { cancel: 'Cancel', abandon: 'Abandon', resume: 'Resume', 'try-now': 'Try now' }
/** What the pressed button reads while its write is in flight. */
const PRESSED: Record<Control, string> = { cancel: 'Cancelling…', abandon: 'Abandoning…', resume: 'Resuming…', 'try-now': 'Trying now…' }

/** The two controls that confirm, with their sentence and buttons, safe button first (#14, part 3). */
const CONFIRM = {
  cancel: { sentence: 'Stop this run? It cannot be resumed afterwards.', keep: 'Keep running', go: 'Stop run' },
  abandon: { sentence: 'Abandon this run? Its sub-runs are cancelled and its worktrees are released.', keep: 'Keep run', go: 'Abandon run' }
} as const

type Confirmed = keyof typeof CONFIRM

/** Whether a control asks before it sends. */
function confirms(control: Control): control is Confirmed {
  return Object.hasOwn(CONFIRM, control)
}

type Confirming = { runId: string; control: Confirmed; status: RunDetail['status'] }

/** What the panel shows once a write returned: Archon's outcome, or the worker's own trouble. */
export type Shown = RunControlOutcome | { kind: 'worker'; message: string }

/** What is in flight on a run: a control of the row, or an answer from the answer block. */
type Held = Control | 'answer'

/** The confirmation that replaces the action row, if one is open. */
const confirming = atom<Confirming | null>(null)
/** The writes in flight, one per run at most, with the control that was pressed. */
const writing = atom<readonly { runId: string; control: Held }[]>([])
/** The outcome of the open run's last write, until the person leaves the run or writes again. */
const shown = atom<{ runId: string; outcome: Shown } | null>(null)
/** The runs whose Cancel Archon refused with a 409, which then offer Abandon. */
const cancelRefused = atom<readonly string[]>([])

/** The run whose Re-run is being filled, while the worker answers. */
const rerunning = atom<string | null>(null)
/** Why the open run's last Re-run did not open the launcher, until the person leaves the run. */
const rerunRefused = atom<{ runId: string; message: string } | null>(null)

/** How many runs the panel remembers a refused Cancel for. */
const CANCEL_REFUSED_KEPT = 50

/** What the action row needs from run detail. */
export type RunActionHooks = {
  /** The open run's id, or null. */
  openRunId(): string | null
  /** Reads the open run again at once, under a new request number. */
  restart(): void
  /** Opens another run, such as the sub-run a refusal names. */
  openRun(runId: string): void
  /** Archon answered that the run does not exist. */
  gone(): void
  keep(view: ConnectionView): void
  /** Re-run: fills the launcher from the run and shows it. Rejects with the worker's refusal. Re-run is not drawn when left out. */
  rerun?(runId: string): Promise<void>
}

/**
 * The controls a run offers, in the order drawn (#14, parts 1, 5 and 8). An attention wait
 * offers Abandon beside its form, and Resume too when it is a legacy wait; a gate offers only its
 * decisions. `resumeAfterAnswer` is set once a gate with no pause id was answered and the run is
 * still paused, the one case Archon does not continue by itself.
 */
function offered(detail: RunDetail, resumeAfterAnswer: boolean): Control[] {
  const question = detail.question
  if (detail.status === 'paused' && question?.kind === 'wait') return question.form === 'legacy' ? ['resume', 'abandon'] : ['abandon']
  if (detail.status === 'paused' && resumeAfterAnswer) return ['resume']
  if (detail.status === 'running') {
    return detail.ownerUnreachable === true || read(cancelRefused).includes(detail.id) ? ['cancel', 'abandon'] : ['cancel']
  }
  if (detail.status === 'paused' && detail.waiting?.kind === 'usage-limit') return ['try-now', 'abandon']
  if (detail.status === 'failed') return ['resume', 'abandon']
  return []
}

/** The run was read again: a confirmation drawn for another status closes by itself. */
export function runActionsRead(detail: RunDetail): void {
  const open = read(confirming)
  if (open !== null && open.runId === detail.id && open.status !== detail.status) set(confirming, null)
}

/** The person left the run: its confirmation and the outcome shown go. A write in flight goes on. */
export function resetRunActions(): void {
  set(confirming, null)
  set(shown, null)
  set(rerunRefused, null)
}

function rejectionText(error: unknown): string {
  const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code') ? (error as { code: unknown }).code : undefined
  if (code === 'invalid_params' && error instanceof Error && error.message !== '') return error.message
  return UNREACHABLE_TEXT
}

/** Whether a write to the run is in flight, from the action row or the answer block. */
export function writeInFlight(runId: string): boolean {
  return read(writing).some((held) => held.runId === runId)
}

/**
 * Sends an answer from the answer block under the same rule as the row: one write per run, the
 * outcome shown under the row, and the run read again at once. `settle` sees the outcome first
 * and may change what is shown.
 */
export function sendAnswer(input: RunAnswerRequest, hooks: RunActionHooks, settle: (outcome: Shown) => Shown): void {
  write(input.runId, 'answer', () => plugin.request('run.answer', input), hooks, settle)
}

function send(runId: string, control: Control, hooks: RunActionHooks): void {
  write(runId, control, () => plugin.request('run.control', { runId, action: ACTION_OF[control] }), hooks)
}

function write(
  runId: string,
  control: Held,
  request: () => Promise<RunControlAnswer>,
  hooks: RunActionHooks,
  settle: (outcome: Shown) => Shown = (outcome) => outcome
): void {
  if (writeInFlight(runId)) return
  update(writing, (held) => [...held, { runId, control }])
  if (read(shown)?.runId === runId) set(shown, null)
  const done = (given: Shown): void => {
    const outcome = settle(given)
    update(writing, (held) => held.filter((entry) => entry.runId !== runId))
    if (read(confirming)?.runId === runId) set(confirming, null)
    if (control === 'cancel' && outcome.kind === 'refused' && outcome.status === 409) {
      update(cancelRefused, (held) => [...held.filter((id) => id !== runId), runId].slice(-CANCEL_REFUSED_KEPT))
    }
    if (hooks.openRunId() !== runId) return
    if (outcome.kind === 'gone') hooks.gone()
    else set(shown, { runId, outcome })
    hooks.restart()
  }
  request().then(
    (answer) => {
      hooks.keep(answer.connection)
      done(answer.outcome)
    },
    (error: unknown) => done({ kind: 'worker', message: rejectionText(error) })
  )
}

/** Re-run pressed: one at a time, and the worker's refusal shown under the row. */
function pressRerun(runId: string, hooks: RunActionHooks): void {
  const rerun = hooks.rerun
  if (rerun === undefined || read(rerunning) !== null) return
  set(rerunning, runId)
  set(rerunRefused, null)
  rerun(runId).then(
    () => set(rerunning, null),
    (error: unknown) => {
      set(rerunning, null)
      if (hooks.openRunId() === runId) set(rerunRefused, { runId, message: rejectionText(error) })
    }
  )
}

/**
 * The action row, or the confirmation in its place. `writable` is false while Searching.
 * `rerun` is set when the worker offers Re-run for the run.
 */
export function actionRow(detail: RunDetail, writable: boolean, hooks: RunActionHooks, resumeAfterAnswer = false, rerun = false): OrcaNode {
  const controls = offered(detail, resumeAfterAnswer)
  const rerunShown = rerun && hooks.rerun !== undefined
  if (controls.length === 0 && !rerunShown) return null
  const pressed = read(writing).find((held) => held.runId === detail.id)?.control
  const off = !writable || pressed !== undefined
  const open = read(confirming)
  if (open !== null && open.runId === detail.id && open.status === detail.status && controls.includes(open.control)) {
    const words = CONFIRM[open.control]
    return (
      <Stack gap="xs">
        <Text>{words.sentence}</Text>
        <Row gap="sm" wrap>
          <Button size="sm" variant="outline" disabled={pressed !== undefined} onPress={() => set(confirming, null)}>
            {words.keep}
          </Button>
          <Button size="sm" tone="danger" disabled={off} onPress={() => send(detail.id, open.control, hooks)}>
            {pressed === open.control ? PRESSED[open.control] : words.go}
          </Button>
        </Row>
      </Stack>
    )
  }
  return (
    <Row gap="sm" wrap>
      {controls.map((control) => (
        <Button
          key={control}
          size="sm"
          variant="outline"
          disabled={off}
          onPress={() => {
            if (confirms(control)) set(confirming, { runId: detail.id, control, status: detail.status })
            else send(detail.id, control, hooks)
          }}
        >
          {pressed === control ? PRESSED[control] : LABEL[control]}
        </Button>
      ))}
      {rerunShown ? (
        <Button size="sm" variant="outline" disabled={!writable || read(rerunning) !== null} onPress={() => pressRerun(detail.id, hooks)}>
          {read(rerunning) === detail.id ? 'Opening the launcher…' : 'Re-run'}
        </Button>
      ) : null}
    </Row>
  )
}

/** Why the open run's last Re-run did not open the launcher, under the action row. */
export function rerunLine(detail: RunDetail): OrcaNode {
  const refused = read(rerunRefused)
  if (refused === null || refused.runId !== detail.id) return null
  return <Text size="sm">{refused.message}</Text>
}

/** Archon's answer to the open run's last write, beside the action row (#14, part 8). */
export function outcomeCallout(detail: RunDetail, hooks: RunActionHooks): OrcaNode {
  const held = read(shown)
  if (held === null || held.runId !== detail.id) return null
  const { outcome } = held
  switch (outcome.kind) {
    case 'done':
      // An info line, not a callout (#14, part 8).
      return <Text>{outcome.message === '' ? 'Archon accepted the change.' : outcome.message}</Text>
    case 'refused': {
      const child = outcome.childRunId
      return (
        <Callout tone="danger">
          <Stack gap="xs">
            <Text>{outcome.message}</Text>
            {child === undefined ? null : (
              <Row>
                <Button size="sm" variant="outline" onPress={() => hooks.openRun(child)}>
                  Open sub-run
                </Button>
              </Row>
            )}
          </Stack>
        </Callout>
      )
    }
    case 'failed':
      return (
        <Callout tone="danger">
          <Stack gap="xs">
            <Text>Archon could not do that.</Text>
            {outcome.message === null ? null : <Text>{outcome.message}</Text>}
          </Stack>
        </Callout>
      )
    case 'timeout':
      return (
        <Callout tone="warning">
          <Text>{`Archon did not answer in ${Math.round(outcome.timeoutMs / 1_000)} seconds. The action may still have happened.`}</Text>
        </Callout>
      )
    case 'not-connected':
      return (
        <Callout tone="warning">
          <Text>Orchon is not connected to Archon, so nothing was sent.</Text>
        </Callout>
      )
    case 'worker':
      return (
        <Callout tone="danger">
          <Text>{outcome.message}</Text>
        </Callout>
      )
    case 'gone':
      return null
  }
}
