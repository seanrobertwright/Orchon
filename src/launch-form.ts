// The rules of a launch's declared inputs and model bindings (#15, parts 4 and 5), shared by the
// panel, which disables Start with the reason, and the worker, which checks them again before it
// sends anything. It is pure logic: no host, no network.
import type { LaunchInput } from './launch-view'

/** The most rows of model bindings a launch takes. */
export const BINDINGS_CAP = 10

/** The most characters of a binding's name or model. */
export const BINDING_TEXT_CAP = 200

/** The tier names Archon takes (`TIER_NAMES` at 0.12.1). Any other name is an alias, which starts with `@`. */
export const TIER_NAMES = ['small', 'medium', 'large'] as const

/** One row of the "Model bindings" group: a tier or alias name and the model it is bound to. */
export type Binding = { name: string; model: string }

/** What a launch's form holds besides its project and workflow: the message, the input values and the model bindings. */
export type LaunchForm = { message: string; values: Record<string, string>; bindings: Binding[] }

/** Bindings copied row by row, so no copy shares a row with its source. */
export const copyBindings = (bindings: readonly Binding[]): Binding[] => bindings.map((binding) => ({ ...binding }))

/** A form copied deep enough that no copy shares its values or a binding row with its source. */
export const copyForm = (form: Readonly<LaunchForm>): LaunchForm => ({ message: form.message, values: { ...form.values }, bindings: copyBindings(form.bindings) })

/** An input's typed value, or empty when none is typed. */
export const valueOf = (values: Readonly<Record<string, string>>, name: string): string => (Object.hasOwn(values, name) ? (values[name] ?? '') : '')

/** Whether a value counts as filled. A value of only spaces is not, so the declared default applies. */
export const isFilled = (value: string): boolean => value.trim() !== ''

/** The values to send: the filled ones, as typed. */
export function filledInputs(values: Readonly<Record<string, string>>): Record<string, string> {
  const filled: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) if (isFilled(value)) filled[name] = value
  return filled
}

/** The required inputs that are not filled, in declared order. */
export function missingRequired(inputs: readonly Pick<LaunchInput, 'name' | 'required'>[], values: Readonly<Record<string, string>>): string[] {
  return inputs.filter((input) => input.required && !isFilled(valueOf(values, input.name))).map((input) => input.name)
}

/** Why Start is off while required inputs are empty, naming them. */
export function missingRequiredText(names: readonly string[]): string {
  return names.length === 1 ? `Fill in the required input: ${names[0] ?? ''}.` : `Fill in the required inputs: ${names.join(', ')}.`
}

/** Why the worker refuses a value for an input the workflow does not declare. */
export const undeclaredInputText = (workflow: string, name: string): string =>
  `${workflow} does not declare the input ${name}. Refresh the launcher and try again.`

const isTier = (name: string): boolean => TIER_NAMES.some((tier) => tier === name)

/**
 * Why the bindings would be refused, or null. Archon's rules: a tier is `small`, `medium` or
 * `large`, an alias starts with `@`, the model is not empty. The plugin adds one: no name twice.
 * Names and models are read with their ends trimmed.
 */
export function bindingsProblem(bindings: readonly Binding[]): string | null {
  const seen = new Set<string>()
  for (const binding of bindings) {
    const name = binding.name.trim()
    if (name === '') return 'Give every binding a name: a tier (small, medium or large) or an alias starting with @.'
    if (!isTier(name) && !name.startsWith('@')) return `A binding names a tier (small, medium or large) or an alias starting with @: ${name} is neither.`
    if (binding.model.trim() === '') return `Give the binding ${name} a model.`
    if (seen.has(name)) return `Each binding names a different tier or alias: ${name} is named twice.`
    seen.add(name)
  }
  return null
}

/** The bindings as the launch body takes them: `tiers` and `aliases`, each left out when empty. */
export function bindingsBody(bindings: readonly Binding[]): { tiers?: Record<string, string>; aliases?: Record<string, string> } {
  const tiers: Record<string, string> = {}
  const aliases: Record<string, string> = {}
  for (const binding of bindings) {
    const name = binding.name.trim()
    if (isTier(name)) tiers[name] = binding.model.trim()
    else aliases[name] = binding.model.trim()
  }
  const body: { tiers?: Record<string, string>; aliases?: Record<string, string> } = {}
  if (Object.keys(tiers).length > 0) body.tiers = tiers
  if (Object.keys(aliases).length > 0) body.aliases = aliases
  return body
}
