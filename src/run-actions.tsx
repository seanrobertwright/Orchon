// Run detail's action row: Cancel, Abandon, Resume and Try now, as the run control decision sets
// them for each state (#14, parts 1, 3 and 8). Cancel and Abandon confirm inline, with the safe
// button first; Resume and Try now send at once. One write per run is in flight at a time, and
// while it is every write control on that run is off. The worker checks each request again and
// sends it once; the panel shows Archon's answer as plain text and reads the run again at once.
import { atom, Button, Callout, plugin, read, Row, set, Stack, Text, update, type OrcaNode } from 'orca'
import type { ConnectionView } from './connection-view'
import type { RunAction, RunControlOutcome } from './run-control-view'
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

type Confirming = { runId: string; control: keyof typeof CONFIRM; status: RunDetail['status'] }

/** What the panel shows once a write returned: Archon's outcome, or the worker's own trouble. */
type Shown = RunControlOutcome | { kind: 'worker'; message: string }

/** The confirmation that replaces the action row, if one is open. */
const confirming = atom<Confirming | null>(null)
/** The writes in flight, one per run at most, with the control that was pressed. */
const writing = atom<readonly { runId: string; control: Control }[]>([])
/** The outcome of the open run's last write, until the person leaves the run or writes again. */
const shown = atom<{ runId: string; outcome: Shown } | null>(null)
/** The runs whose Cancel Archon refused with a 409, which then offer Abandon. */
const cancelRefused = atom<readonly string[]>([])

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
}

/** The controls a run offers, in the order drawn (#14, part 1). */
function offered(detail: RunDetail): Control[] {
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
}

function rejectionText(error: unknown): string {
  const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code') ? (error as { code: unknown }).code : undefined
  if (code === 'invalid_params' && error instanceof Error && error.message !== '') return error.message
  return UNREACHABLE_TEXT
}

function send(runId: string, control: Control, hooks: RunActionHooks): void {
  if (read(writing).some((held) => held.runId === runId)) return
  update(writing, (held) => [...held, { runId, control }])
  if (read(shown)?.runId === runId) set(shown, null)
  const done = (outcome: Shown): void => {
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
  plugin.request('run.control', { runId, action: ACTION_OF[control] }).then(
    (answer) => {
      hooks.keep(answer.connection)
      done(answer.outcome)
    },
    (error: unknown) => done({ kind: 'worker', message: rejectionText(error) })
  )
}

/** The action row, or the confirmation in its place. `writable` is false while Searching. */
export function actionRow(detail: RunDetail, writable: boolean, hooks: RunActionHooks): OrcaNode {
  const controls = offered(detail)
  if (controls.length === 0) return null
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
            if (control === 'cancel' || control === 'abandon') set(confirming, { runId: detail.id, control, status: detail.status })
            else send(detail.id, control, hooks)
          }}
        >
          {pressed === control ? PRESSED[control] : LABEL[control]}
        </Button>
      ))}
    </Row>
  )
}

/** Archon's answer to the open run's last write, beside the action row (#14, part 8). */
export function outcomeCallout(detail: RunDetail, hooks: RunActionHooks): OrcaNode {
  const held = read(shown)
  if (held === null || held.runId !== detail.id) return null
  const { outcome } = held
  switch (outcome.kind) {
    case 'done':
      return (
        <Callout tone="success">
          <Text>{outcome.message === '' ? 'Archon accepted the change.' : outcome.message}</Text>
        </Callout>
      )
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
          <Text>Archon did not answer in 30 seconds. The action may still have happened.</Text>
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
