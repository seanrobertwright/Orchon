// The editable groups of the Settings section as a frame gets them: the view model the worker
// answers and posts. The worker holds each group's unsaved form and decides every field, option
// and placeholder; a frame draws the fields in order and sends back only field values.
// It is types only, so the panel and the worker read one contract and no code crosses between them.
import type { ConnectionView } from './connection-view'

/** The editable groups. */
export type FormGroupId = 'defaults' | 'tiers' | 'aliases'

export type FieldOption = { value: string; label: string }

/** One field, drawn on its own line with its label. `error` is the failed check shown on it. */
export type FormField =
  | { kind: 'select'; id: string; label: string; value: string; options: FieldOption[]; error: string | null }
  | { kind: 'text'; id: string; label: string; value: string; placeholder: string; maxLength: number; error: string | null }
  /** A saved value that failed validation: shown by its key and never sent. */
  | { kind: 'unreadable'; id: string; label: string }
  /** A saved value shown read-only, such as a saved alias's name. */
  | { kind: 'fixed'; id: string; label: string; value: string }
  /** A saved value that Save removes, drawn struck through and in words. */
  | { kind: 'struck'; id: string; label: string; value: string }
  /**
   * A button that sets the field `id` to `value` through `forms.edit`, such as Remove, Undo and
   * "Add alias". `text` is its visible text and its name.
   */
  | { kind: 'button'; id: string; text: string; value: string; disabled: boolean }

/** A line under the group: Archon's refusal, the outcome of a save, or a failed read. */
export type FormNotice = { tone: 'success' | 'warning' | 'danger'; text: string }

/** A save stopped because Archon's config changed elsewhere since the group loaded. */
export type FormConflict = {
  /** The changed keys, as the person reads them. */
  keys: string[]
}

export type FormView = {
  group: FormGroupId
  title: string
  /** The one-line summary of the closed group, or "Unsaved changes" while it holds edits. */
  summary: string
  /** Whether the group has loaded from Archon at least once. */
  loaded: boolean
  fields: FormField[]
  /** Lines saying what is not shown, such as providers past the cap. */
  notes: string[]
  /** Whether the form differs from its loaded values: Save and Discard are enabled only then. */
  dirty: boolean
  /** Whether a save is out. The group's fields, Save and Discard are disabled meanwhile. */
  saving: boolean
  notice: FormNotice | null
  conflict: FormConflict | null
}

/** A registered provider as the worker keeps it. Archon's `capabilities` never reaches a frame. */
export type ProviderView = { id: string; displayName: string; effortLevels: string[] | null }

export type FormsView = {
  /** When this view was made, in milliseconds since the epoch. It rises with every change. */
  since: number
  /** Why the newest read of the config or the providers failed, or null when it did not. */
  failure: string | null
  /** The registered providers, at most the cap, in Archon's order. */
  providers: ProviderView[]
  defaults: FormView
  tiers: FormView
  aliases: FormView
}

/** What every forms request answers. */
export type FormsAnswer = { connection: ConnectionView; forms: FormsView }

/** `forms.edit`: new values for some fields of one group, by field id. */
export type FormsEdit = { group: FormGroupId; edits: Record<string, string> }

/** How the person settles a save stopped by an outside change. */
export type ConflictChoice = 'load' | 'overwrite' | 'keep'
