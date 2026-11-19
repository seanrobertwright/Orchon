// What one editable group of the Settings section is, for the form machinery in
// `settings-forms.ts`. A group reads its fields from Archon's config, says which Archon key each
// field belongs to, checks the keys the person changed and builds the request body from them.
// Defaults, Model tiers and Aliases are groups.
import type { ConfigFacts, Providers } from './config'
import type { FieldOption, FormField, FormGroupId } from './forms-view'

/** Field values by field id. An empty string is nothing chosen or typed. */
export type Values = Record<string, string>

/**
 * A group's values as last loaded from Archon, the fields whose saved value is unreadable, and
 * text the group draws from the same read but never compares or sends, such as a placeholder.
 */
export type Loaded = { values: Values; unreadable: ReadonlySet<string>; shown: Values }

export type GroupContext = { providers: Providers }

export type GroupSpec = {
  id: FormGroupId
  title: string
  /** The `PATCH` route a save goes to. */
  path: string
  load(config: ConfigFacts): Loaded
  /**
   * The Archon key a field belongs to, in the values the field is one of. The outside-change
   * check and the body work by key. A group whose rows are named by a typed value, such as a new
   * alias, reads the key from `values`; the others read it from the field id alone.
   */
  keyOf(fieldId: string, values: Values): string
  /**
   * A canonical text of one key's value in `values`, compared to tell whether the key changed,
   * changed elsewhere or landed. Without it, the text is the key's fields' trimmed values by
   * field id, which suits a group whose field ids never change.
   */
  canonical?(values: Values, loaded: Loaded, key: string): string
  /** A key as the person reads it, in a conflict. */
  keyLabel(key: string): string
  /** The fields as drawn, with the failed checks on them. */
  fields(current: Values, loaded: Loaded, errors: ReadonlyMap<string, string>, context: GroupContext): FormField[]
  /**
   * One field set to a value, with what follows from it on the other fields of the group. The
   * field id is one `fields` draws.
   */
  edit(current: Values, fieldId: string, value: string, context: GroupContext, loaded: Loaded): Values
  /** The failed checks of the changed keys, by field id. A save sends nothing while there is one. */
  check(current: Values, loaded: Loaded, changed: readonly string[], context: GroupContext): Map<string, string>
  /** The request body, from the changed keys only. */
  body(current: Values, changed: readonly string[]): unknown
  /** The one-line summary of the closed group. */
  summary(loaded: Loaded, context: GroupContext): string
  /** The group's own lines saying what is not shown, after the providers' ones. */
  notes?(loaded: Loaded): string[]
}

/** A model is at most this long once trimmed. */
export const MODEL_LENGTH = 200

export const MODEL_TOO_LONG = `A model is at most ${String(MODEL_LENGTH)} characters.`
export const NOT_REGISTERED = 'This provider is not registered with Archon.'
export const ENTER_A_MODEL = 'Enter a model'
export const CHOOSE_A_PROVIDER = 'Choose a provider'

/** A value as it is compared and sent: trimmed. */
export const clean = (value: string | undefined): string => (value ?? '').trim()

/** The listed options, then each kept value they lack, labelled with `suffix`. Empty values are left out. */
function withKept(listed: FieldOption[], suffix: string, kept: readonly string[]): FieldOption[] {
  const options = [...listed]
  for (const value of kept) {
    if (value !== '' && !options.some((option) => option.value === value)) options.push({ value, label: `${value} ${suffix}` })
  }
  return options
}

/**
 * The registered providers as select options, after `first` when there is one, and a saved or
 * chosen one Archon does not list.
 */
export const providerOptions = (first: FieldOption | null, context: GroupContext, ...kept: string[]): FieldOption[] =>
  withKept(
    [...(first === null ? [] : [first]), ...context.providers.shown.map((provider) => ({ value: provider.id, label: provider.displayName }))],
    '(not registered)',
    kept
  )

/** Effort levels as select options, and a saved or chosen one the provider does not accept. */
export const effortOptions = (first: FieldOption, levels: readonly string[], ...kept: string[]): FieldOption[] =>
  withKept([first, ...levels.map((level) => ({ value: level, label: level }))], '(not accepted)', kept)

/** Whether a provider is registered with Archon. */
export const registered = (context: GroupContext, id: string): boolean => context.providers.all.has(id)

/** The effort levels a provider accepts: none for one that is not registered or takes no effort. */
export const effortLevelsOf = (context: GroupContext, id: string): readonly string[] =>
  context.providers.all.get(id)?.effortLevels ?? []

/** A provider by its display name, or its id when Archon does not list it. */
export function providerName(context: GroupContext, id: string): string {
  const provider = context.providers.all.get(id)
  return provider === undefined ? `${id} (not registered)` : provider.displayName
}

/** The field ids of one preset: a provider, a model and an effort. */
export type PresetFields = { provider: string; model: string; effort: string }

/**
 * The failed checks of a preset whose provider is chosen, by field id: a registered provider, a
 * model of at most the limit, and an effort the provider accepts. An effort the provider does not
 * accept is shown on the effort select when there is one, and on the provider otherwise.
 */
export function checkPreset(errors: Map<string, string>, ids: PresetFields, values: Values, context: GroupContext): void {
  const chosen = clean(values[ids.provider])
  const typed = clean(values[ids.model])
  const level = clean(values[ids.effort])
  if (!registered(context, chosen)) errors.set(ids.provider, NOT_REGISTERED)
  if (typed === '') errors.set(ids.model, ENTER_A_MODEL)
  else if (typed.length > MODEL_LENGTH) errors.set(ids.model, MODEL_TOO_LONG)
  if (level !== '' && registered(context, chosen) && !effortLevelsOf(context, chosen).includes(level)) {
    const where = effortLevelsOf(context, chosen).length > 0 ? ids.effort : ids.provider
    errors.set(where, `${providerName(context, chosen)} does not accept this effort.`)
  }
}

/** How a preset's fields are drawn: the provider select's empty choice, if it has one, and the model's placeholder. */
export type PresetLook = { none: FieldOption | null; placeholder: string }

/**
 * The fields of one preset as drawn: a provider select, a model text and, when the chosen provider
 * accepts effort levels, an effort select. Each is labelled `<label> provider`, `<label> model`
 * and `<label> effort`. `saved` is the provider as loaded, kept as a choice when Archon does not list it.
 */
export function presetFields(
  ids: PresetFields,
  label: string,
  look: PresetLook,
  current: Values,
  saved: string,
  errors: ReadonlyMap<string, string>,
  context: GroupContext
): FormField[] {
  const error = (fieldId: string): string | null => errors.get(fieldId) ?? null
  const chosen = current[ids.provider] ?? ''
  const fields: FormField[] = [
    { kind: 'select', id: ids.provider, label: `${label} provider`, value: chosen, options: providerOptions(look.none, context, saved, chosen), error: error(ids.provider) },
    { kind: 'text', id: ids.model, label: `${label} model`, value: current[ids.model] ?? '', placeholder: look.placeholder, maxLength: MODEL_LENGTH, error: error(ids.model) }
  ]
  const levels = effortLevelsOf(context, chosen)
  if (levels.length > 0) {
    const value = current[ids.effort] ?? ''
    fields.push({
      kind: 'select',
      id: ids.effort,
      label: `${label} effort`,
      value,
      options: effortOptions({ value: '', label: 'None' }, levels, value),
      error: error(ids.effort)
    })
  }
  return fields
}

/** A preset as one text, from its provider, model and effort, for comparing two presets. */
export const presetText = (provider: string, model: string, effort: string): string => [provider, model, effort].join('\u0000')

/** A preset as Archon takes it, from its fields' trimmed values, or null when no provider is chosen. An empty effort is left out. */
export function presetBody(ids: PresetFields, values: Values): { provider: string; model: string; effort?: string } | null {
  const chosen = clean(values[ids.provider])
  if (chosen === '') return null
  const typed = clean(values[ids.model])
  const level = clean(values[ids.effort])
  return level === '' ? { provider: chosen, model: typed } : { provider: chosen, model: typed, effort: level }
}

/** A preset's fields after a change of provider: the effort is kept when the new provider accepts it, and cleared otherwise. */
export function withProvider(current: Values, ids: PresetFields, value: string, context: GroupContext): Values {
  const kept = effortLevelsOf(context, value).includes(current[ids.effort] ?? '') ? (current[ids.effort] ?? '') : ''
  return { ...current, [ids.provider]: value, [ids.effort]: kept }
}
