// The Model tiers group: `small`, `medium` and `large`, each a provider, a model and an effort.
// The provider select starts with "Default", which empties the row and removes the tier on Save.
// A tier is one Archon key: a change to any of its three fields sends the whole preset (#20, part 6).
import { TIER_NAMES, type ConfigFacts, type Preset, type TierName } from './config'
import {
  CHOOSE_A_PROVIDER,
  checkPreset,
  clean,
  effortLevelsOf,
  effortOptions,
  MODEL_LENGTH,
  presetBody,
  providerOptions,
  withProvider,
  type GroupSpec,
  type Loaded,
  type PresetFields,
  type Values
} from './form-group'
import type { FormField } from './forms-view'

export const TIERS_PATH = '/api/config/tiers'

const TITLES: Record<TierName, string> = { small: 'Small', medium: 'Medium', large: 'Large' }

const provider = (tier: TierName): string => `${tier}:provider`
const model = (tier: TierName): string => `${tier}:model`
const effort = (tier: TierName): string => `${tier}:effort`
const presetOf = (tier: TierName): PresetFields => ({ provider: provider(tier), model: model(tier), effort: effort(tier) })

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
  return {
    id: 'tiers',
    title: 'Model tiers',
    path: TIERS_PATH,

    load(config: ConfigFacts): Loaded {
      const values: Values = {}
      const unreadable = new Set<string>()
      // What each unset tier resolves to, for its model placeholder and the summary.
      const shown: Values = {}
      for (const tier of TIER_NAMES) {
        const saved = config.tiers[tier]
        const set = saved.kind === 'set' ? saved.value : null
        values[provider(tier)] = set?.provider ?? ''
        values[model(tier)] = set?.model ?? ''
        values[effort(tier)] = set?.effort ?? ''
        shown[tier] = resolved(config.tierDefaults[tier])
        if (saved.kind === 'unreadable') for (const fieldId of [provider(tier), model(tier), effort(tier)]) unreadable.add(fieldId)
      }
      return { values, unreadable, shown }
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
          placeholder: loaded.shown[tier] ?? resolved(null),
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
      return withProvider(current, presetOf(tier), value, context)
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
        checkPreset(errors, presetOf(key), current, context)
      }
      return errors
    },

    body(current, changed) {
      const tiers: Partial<Record<TierName, ReturnType<typeof presetBody>>> = {}
      for (const key of changed) {
        if (isTier(key)) tiers[key] = presetBody(presetOf(key), current)
      }
      return { tiers }
    },

    summary(loaded) {
      const parts = TIER_NAMES.map((tier) => {
        if (loaded.unreadable.has(provider(tier))) return `${tier} Unreadable`
        const chosen = loaded.values[provider(tier)] ?? ''
        return `${tier} ${chosen === '' ? (loaded.shown[tier] ?? resolved(null)) : `${chosen}/${loaded.values[model(tier)] ?? ''}`}`
      })
      const text = parts.join(', ')
      return text.charAt(0).toUpperCase() + text.slice(1)
    }
  }
}
