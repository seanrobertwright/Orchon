// The editable groups of the Settings section, in the panel: Defaults and Model tiers, each a
// closed group with its fields one per line, Save and Discard. It draws the worker's view model
// only; the worker holds the unsaved form, so a typed value is sent to it, after a short pause
// that keeps the panel inside Orca's request budget, and before any Save or Discard.
import {
  atom,
  Button,
  Callout,
  Collapsible,
  Field,
  Input,
  plugin,
  read,
  Row,
  Select,
  Skeleton,
  Stack,
  Text,
  update,
  type OrcaNode,
  type PanelContext
} from 'orca'
import type { ConnectionView } from './connection-view'
import type { ConflictChoice, FormField, FormGroupId, FormsAnswer, FormsView, FormView } from './forms-view'
import { frameTimers } from './frame-timers'

/** Typed text is sent to the worker this long after the last key press. */
export const TYPING_PAUSE_MS = 300

/** The editable groups, which the worker reads while the Settings section shows. Null until it answers. */
const forms = atom<FormsView | null>(null)

/** Keeps the newest view: an answer and a post can arrive in either order. */
function keepForms(next: FormsView): void {
  update(forms, (held) => (held === null || next.since > held.since ? next : held))
}

export type FormGroupsHooks = {
  /** Keeps the connection state a data answer carries. */
  keep(view: ConnectionView): void
}

let hooks: FormGroupsHooks = { keep: () => {} }

/** Typed values not yet sent, by group and field id. */
const pending = new Map<FormGroupId, Map<string, string>>()
let pause: unknown

function kept(answer: FormsAnswer): void {
  hooks.keep(answer.connection)
  keepForms(answer.forms)
}

/** Sends a request and keeps what its answer carries. A refused request changes nothing. */
function send(request: Promise<FormsAnswer>): Promise<void> {
  return request.then(kept, () => {})
}

/** Sends every typed value not yet sent, one request per group. */
function flush(): Promise<void> {
  if (pause !== undefined) frameTimers.clear(pause)
  pause = undefined
  const sends = [...pending].map(([group, edits]) => send(plugin.request('forms.edit', { group, edits: Object.fromEntries(edits) })))
  pending.clear()
  return Promise.all(sends).then(() => {})
}

function typed(group: FormGroupId, id: string, value: string): void {
  const edits = pending.get(group) ?? new Map<string, string>()
  edits.set(id, value)
  pending.set(group, edits)
  if (pause !== undefined) frameTimers.clear(pause)
  pause = frameTimers.set(() => {
    pause = undefined
    void flush()
  }, TYPING_PAUSE_MS)
}

/** A choice is sent at once, after any typing before it. */
function chose(group: FormGroupId, id: string, value: string): void {
  void flush().then(() => send(plugin.request('forms.edit', { group, edits: { [id]: value } })))
}

const save = (group: FormGroupId): void => void flush().then(() => send(plugin.request('forms.save', { group })))
const discard = (group: FormGroupId): void => {
  pending.delete(group)
  void flush().then(() => send(plugin.request('forms.discard', { group })))
}
const resolve = (group: FormGroupId, choice: ConflictChoice): void =>
  void flush().then(() => send(plugin.request('forms.resolve', { group, choice })))

/** Asks the worker to read the config and the providers. Groups with unsaved edits keep them. */
export function readForms(): void {
  void send(plugin.request('forms.read'))
}

/** Starts the groups for this panel run. Typing not yet sent is sent when the panel closes. */
export function startFormGroups(ctx: PanelContext, given: FormGroupsHooks): void {
  hooks = given
  ctx.subscriptions.push(plugin.on('forms.changed', keepForms))
  ctx.subscriptions.push({ dispose: () => void flush() })
}

/**
 * Orca's Select takes no empty option value, so the empty choice ("Inherit", "Default", "None")
 * is drawn under this one and sent to the worker as the empty string it stands for.
 */
export const EMPTY_CHOICE = 'orchon-empty-choice'

const toOption = (value: string): string => (value === '' ? EMPTY_CHOICE : value)
const fromOption = (value: string): string => (value === EMPTY_CHOICE ? '' : value)

function fieldNode(group: FormGroupId, field: FormField, disabled: boolean): OrcaNode {
  if (field.kind === 'unreadable') return <Text key={field.id}>{`${field.label}: Unreadable`}</Text>
  const control =
    field.kind === 'select' ? (
      <Select
        label={field.label}
        labelHidden
        value={toOption(field.value)}
        options={field.options.map((option) => ({ value: toOption(option.value), label: option.label }))}
        disabled={disabled}
        onChange={(value) => chose(group, field.id, fromOption(value))}
      />
    ) : (
      <Input
        label={field.label}
        labelHidden
        value={field.value}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        invalid={field.error !== null}
        disabled={disabled}
        onChange={(value) => typed(group, field.id, value)}
      />
    )
  return (
    <Field key={field.id} label={field.label} {...(field.error === null ? {} : { error: field.error })}>
      {control}
    </Field>
  )
}

/** A save stopped by an outside change, and the three ways on. */
function conflictNode(form: FormView, disabled: boolean): OrcaNode {
  if (form.conflict === null) return null
  const { group } = form
  return (
    <Callout tone="warning" title="Changed outside Orchon">
      <Stack gap="sm">
        <Text>{`Archon's config changed elsewhere since this group loaded: ${form.conflict.keys.join(', ')}. Nothing was saved.`}</Text>
        <Row gap="sm">
          <Button disabled={disabled} onPress={() => resolve(group, 'load')}>
            Load saved values
          </Button>
          <Button disabled={disabled} onPress={() => resolve(group, 'overwrite')}>
            Overwrite
          </Button>
          <Button variant="outline" disabled={disabled} onPress={() => resolve(group, 'keep')}>
            Keep editing
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

const NOTICE_TITLE = { success: 'Saved', warning: 'Not saved', danger: 'Not saved' } as const

function content(form: FormView, failure: string | null, writable: boolean): OrcaNode {
  if (!form.loaded) {
    if (failure === null) return <Skeleton lines={3} label={`Reading ${form.title}`} />
    return (
      <Callout tone="warning">
        <Stack gap="sm">
          <Text>{failure}</Text>
          <Button onPress={readForms}>Try again</Button>
        </Stack>
      </Callout>
    )
  }
  const disabled = !writable || form.saving
  const { notice } = form
  return (
    <>
      {form.fields.map((field) => fieldNode(form.group, field, disabled))}
      {form.notes.map((note) => (
        <Text key={note} muted>
          {note}
        </Text>
      ))}
      <Row gap="sm">
        <Button disabled={disabled || !form.dirty} onPress={() => save(form.group)}>
          {form.saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="outline" disabled={disabled || !form.dirty} onPress={() => discard(form.group)}>
          Discard
        </Button>
      </Row>
      {conflictNode(form, disabled)}
      {notice === null ? null : (
        <Callout tone={notice.tone} title={NOTICE_TITLE[notice.tone]}>
          <Text>{notice.text}</Text>
        </Callout>
      )}
    </>
  )
}

/** One editable group, closed, with its one-line summary. */
function groupNode(form: FormView, failure: string | null, writable: boolean): OrcaNode {
  return (
    <Collapsible key={form.title} title={form.title} {...(form.summary === '' ? {} : { description: form.summary })}>
      <Stack gap="sm">{content(form, failure, writable)}</Stack>
    </Collapsible>
  )
}

/** A group before the worker has answered at all. */
const waiting = (title: string): OrcaNode => (
  <Collapsible key={title} title={title}>
    <Skeleton lines={3} label={`Reading ${title}`} />
  </Collapsible>
)

/**
 * Defaults and Model tiers. `writable` is false in Searching: every field, Save and Discard are
 * then disabled, and what the worker holds is kept.
 */
export function formGroups(writable: boolean): OrcaNode {
  const view = read(forms)
  if (view === null) return [waiting('Defaults'), waiting('Model tiers')]
  return [groupNode(view.defaults, view.failure, writable), groupNode(view.tiers, view.failure, writable)]
}
