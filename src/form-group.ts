// What one editable group of the Settings section is, for the form machinery in
// `settings-forms.ts`. A group reads its fields from Archon's config, says which Archon key each
// field belongs to, checks the keys the person changed and builds the request body from them.
// Defaults and Model tiers are groups; Aliases is meant to be a third.
import type { ConfigFacts, Providers } from './config'
import type { FieldOption, FormField, FormGroupId } from './forms-view'

/** Field values by field id. An empty string is nothing chosen or typed. */
export type Values = Record<string, string>

/** A group's values as last loaded from Archon, and the fields whose saved value is unreadable. */
export type Loaded = { values: Values; unreadable: ReadonlySet<string> }

export type GroupContext = { providers: Providers }

export type GroupSpec = {
  id: FormGroupId
  title: string
  /** The `PATCH` route a save goes to. */
  path: string
  load(config: ConfigFacts): Loaded
  /** The Archon key a field belongs to. The outside-change check and the body work by key. */
  keyOf(fieldId: string): string
  /** A key as the person reads it, in a conflict. */
  keyLabel(key: string): string
  /** The fields as drawn, with the failed checks on them. */
  fields(current: Values, loaded: Loaded, errors: ReadonlyMap<string, string>, context: GroupContext): FormField[]
  /**
   * One field set to a value, with what follows from it on the other fields of the group. The
   * field id is one `fields` draws.
   */
  edit(current: Values, fieldId: string, value: string, context: GroupContext): Values
  /** The failed checks of the changed keys, by field id. A save sends nothing while there is one. */
  check(current: Values, loaded: Loaded, changed: readonly string[], context: GroupContext): Map<string, string>
  /** The request body, from the changed keys only. */
  body(current: Values, changed: readonly string[]): unknown
  /** The one-line summary of the closed group. */
  summary(loaded: Loaded, context: GroupContext): string
}

/** A model is at most this long once trimmed. */
export const MODEL_LENGTH = 200

export const MODEL_TOO_LONG = `A model is at most ${String(MODEL_LENGTH)} characters.`
export const NOT_REGISTERED = 'This provider is not registered with Archon.'

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

/** The registered providers as select options, and a saved or chosen one Archon does not list. */
export const providerOptions = (first: FieldOption, context: GroupContext, ...kept: string[]): FieldOption[] =>
  withKept([first, ...context.providers.shown.map((provider) => ({ value: provider.id, label: provider.displayName }))], '(not registered)', kept)

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
