// The Model tiers group: `small`, `medium` and `large`, each a provider, a model and an effort.
// The provider select starts with "Default", which empties the row and removes the tier on Save.
// A tier is one Archon key: a change to any of its three fields sends the whole preset (#20, part 6).
import { TIER_NAMES, type ConfigFacts, type Preset, type TierName } from './config'
import {
  clean,
  effortLevelsOf,
  effortOptions,
  MODEL_LENGTH,
  MODEL_TOO_LONG,
  NOT_REGISTERED,
  providerName,
  providerOptions,
  registered,
  type GroupSpec,
  type Loaded,
  type Values
} from './form-group'
import type { FormField } from './forms-view'

export const TIERS_PATH = '/api/config/tiers'

export const ENTER_A_MODEL = 'Enter a model'
export const CHOOSE_A_PROVIDER = 'Choose a provider'

const TITLES: Record<TierName, string> = { small: 'Small', medium: 'Medium', large: 'Large' }

const provider = (tier: TierName): string => `${tier}:provider`
const model = (tier: TierName): string => `${tier}:model`
const effort = (tier: TierName): string => `${tier}:effort`

const isTier = (value: string): value is TierName => TIER_NAMES.some((tier) => tier === value)

/** The tier a field belongs to. Field ids are the ones this group draws. */
function tierOf(fieldId: string): TierName {
  const name = fieldId.slice(0, fieldId.indexOf(':'))
  if (!isTier(name)) throw new Error(`${fieldId} is not a tier field.`)
  return name
}

/** What an unset tier resolves to, as the model placeholder and the summary say it. */
const resolved = (preset: Preset | null): string => (preset === null ? 'No built-in default' : `${preset.provider}/${preset.model}`)

export function tiersForm(): GroupSpec {
  /** Kept from the newest config read, for the placeholders and the summary. */
  let defaults: Record<TierName, Preset | null> = { small: null, medium: null, large: null }

  return {
    id: 'tiers',
    title: 'Model tiers',
    path: TIERS_PATH,

    load(config: ConfigFacts): Loaded {
      defaults = config.tierDefaults
      const values: Values = {}
      const unreadable = new Set<string>()
      for (const tier of TIER_NAMES) {
        const saved = config.tiers[tier]
        const set = saved.kind === 'set' ? saved.value : null
        values[provider(tier)] = set?.provider ?? ''
        values[model(tier)] = set?.model ?? ''
        values[effort(tier)] = set?.effort ?? ''
        if (saved.kind === 'unreadable') for (const fieldId of [provider(tier), model(tier), effort(tier)]) unreadable.add(fieldId)
      }
      return { values, unreadable }
    },

    keyOf: tierOf,

    keyLabel: (key) => `${isTier(key) ? TITLES[key] : key} tier`,

    fields(current, loaded, errors, context) {
      const fields: FormField[] = []
      const error = (fieldId: string): string | null => errors.get(fieldId) ?? null
      for (const tier of TIER_NAMES) {
        if (loaded.unreadable.has(provider(tier))) {
          fields.push({ kind: 'unreadable', id: provider(tier), label: `${TITLES[tier]} tier` })
          continue
        }
        const chosen = current[provider(tier)] ?? ''
        fields.push({
          kind: 'select',
          id: provider(tier),
          label: `${TITLES[tier]} provider`,
          value: chosen,
          options: providerOptions({ value: '', label: 'Default' }, context, loaded.values[provider(tier)] ?? '', chosen),
          error: error(provider(tier))
        })
        fields.push({
          kind: 'text',
          id: model(tier),
          label: `${TITLES[tier]} model`,
          value: current[model(tier)] ?? '',
          placeholder: resolved(defaults[tier]),
          maxLength: MODEL_LENGTH,
          error: error(model(tier))
        })
        const levels = effortLevelsOf(context, chosen)
        if (levels.length > 0) {
          const value = current[effort(tier)] ?? ''
          fields.push({
            kind: 'select',
            id: effort(tier),
            label: `${TITLES[tier]} effort`,
            value,
            options: effortOptions({ value: '', label: 'None' }, levels, value),
            error: error(effort(tier))
          })
        }
      }
      return fields
    },

    edit(current, fieldId, value, context) {
      const tier = tierOf(fieldId)
      if (fieldId !== provider(tier)) return { ...current, [fieldId]: value }
      if (value === '') return { ...current, [provider(tier)]: '', [model(tier)]: '', [effort(tier)]: '' }
      // The effort is kept when the new provider accepts it, and cleared otherwise.
      const kept = effortLevelsOf(context, value).includes(current[effort(tier)] ?? '') ? (current[effort(tier)] ?? '') : ''
      return { ...current, [provider(tier)]: value, [effort(tier)]: kept }
    },

    check(current, _loaded, changed, context) {
      const errors = new Map<string, string>()
      for (const key of changed) {
        if (!isTier(key)) continue
        const chosen = clean(current[provider(key)])
        const typed = clean(current[model(key)])
        const level = clean(current[effort(key)])
        if (chosen === '') {
          if (typed !== '' || level !== '') errors.set(provider(key), CHOOSE_A_PROVIDER)
          continue
        }
        if (!registered(context, chosen)) errors.set(provider(key), NOT_REGISTERED)
        if (typed === '') errors.set(model(key), ENTER_A_MODEL)
        else if (typed.length > MODEL_LENGTH) errors.set(model(key), MODEL_TOO_LONG)
        if (level !== '' && registered(context, chosen) && !effortLevelsOf(context, chosen).includes(level)) {
          const where = effortLevelsOf(context, chosen).length > 0 ? effort(key) : provider(key)
          errors.set(where, `${providerName(context, chosen)} does not accept this effort.`)
        }
      }
      return errors
    },

    body(current, changed) {
      const tiers: Partial<Record<TierName, Preset | { provider: string; model: string } | null>> = {}
      for (const key of changed) {
        if (!isTier(key)) continue
        const chosen = clean(current[provider(key)])
        const level = clean(current[effort(key)])
        const typed = clean(current[model(key)])
        tiers[key] = chosen === '' ? null : level === '' ? { provider: chosen, model: typed } : { provider: chosen, model: typed, effort: level }
      }
      return { tiers }
    },

    summary(loaded) {
      const parts = TIER_NAMES.map((tier) => {
        if (loaded.unreadable.has(provider(tier))) return `${tier} Unreadable`
        const chosen = loaded.values[provider(tier)] ?? ''
        return `${tier} ${chosen === '' ? resolved(defaults[tier]) : `${chosen}/${loaded.values[model(tier)] ?? ''}`}`
      })
      const text = parts.join(', ')
      return text.charAt(0).toUpperCase() + text.slice(1)
    }
  }
}
