// The editable groups of the Settings section as the worker would answer them, for the panel's
// tests and for the scenarios of `orca plugin check`. These are view models, the worker's output,
// never Archon's JSON. It is development tooling: Orca never loads it.
import type { FormField, FormsView, FormView } from '../src/forms-view.ts'

const PROVIDERS = [
  { value: 'opencode', label: 'OpenCode (community)' },
  { value: 'claude', label: 'Claude (Anthropic)' }
]

const text = (id: string, label: string, value: string, placeholder: string): Extract<FormField, { kind: 'text' }> => ({
  kind: 'text',
  id,
  label,
  value,
  placeholder,
  maxLength: 200,
  error: null
})

const select = (id: string, label: string, value: string, first: string): FormField => ({
  kind: 'select',
  id,
  label,
  value,
  options: [{ value: '', label: first }, ...PROVIDERS],
  error: null
})

export const defaultsRead: FormView = {
  group: 'defaults',
  title: 'Defaults',
  summary: 'Claude (Anthropic), model Inherit',
  loaded: true,
  fields: [
    select('assistant', 'Default assistant', 'claude', 'Inherit'),
    text('model:opencode', 'OpenCode (community) model', '', 'Inherit'),
    text('model:claude', 'Claude (Anthropic) model', '', 'Inherit')
  ],
  notes: [],
  dirty: false,
  saving: false,
  notice: null,
  conflict: null
}

export const tiersRead: FormView = {
  group: 'tiers',
  title: 'Model tiers',
  summary: 'Small claude/haiku, medium claude/sonnet, large claude/opus',
  loaded: true,
  fields: [
    select('small:provider', 'Small provider', 'claude', 'Default'),
    text('small:model', 'Small model', 'haiku-custom', 'claude/haiku'),
    {
      kind: 'select',
      id: 'small:effort',
      label: 'Small effort',
      value: '',
      options: [
        { value: '', label: 'None' },
        { value: 'low', label: 'low' }
      ],
      error: null
    },
    { kind: 'unreadable', id: 'medium:provider', label: 'Medium tier' },
    select('large:provider', 'Large provider', '', 'Default'),
    text('large:model', 'Large model', '', 'No built-in default')
  ],
  notes: [],
  dirty: false,
  saving: false,
  notice: null,
  conflict: null
}

/** Both groups loaded, with nothing unsaved. */
export const formsRead: FormsView = {
  since: 30,
  failure: null,
  providers: [
    { id: 'opencode', displayName: 'OpenCode (community)', effortLevels: null },
    { id: 'claude', displayName: 'Claude (Anthropic)', effortLevels: ['low'] }
  ],
  defaults: defaultsRead,
  tiers: tiersRead
}

const unloaded = (form: FormView): FormView => ({ ...form, summary: '', loaded: false, fields: [] })

/** Before the config has answered. */
export const formsUnread: FormsView = { ...formsRead, since: 5, providers: [], defaults: unloaded(defaultsRead), tiers: unloaded(tiersRead) }

/** Defaults holding an edit that emptied a saved model, and a save stopped by an outside change on tiers. */
export const formsWithEdits: FormsView = {
  ...formsRead,
  since: 40,
  defaults: {
    ...defaultsRead,
    summary: 'Unsaved changes',
    dirty: true,
    fields: [
      select('assistant', 'Default assistant', 'claude', 'Inherit'),
      text('model:opencode', 'OpenCode (community) model', '', 'Inherit'),
      {
        ...text('model:claude', 'Claude (Anthropic) model', '', 'Inherit'),
        error: 'A saved value can be replaced here but not removed. Edit config.yaml to remove it.'
      }
    ],
    notice: { tone: 'danger', text: "tier 'small': Unknown provider: 'nope'. Available: opencode, claude" }
  },
  tiers: { ...tiersRead, summary: 'Unsaved changes', dirty: true, conflict: { keys: ['Small tier'] } }
}
