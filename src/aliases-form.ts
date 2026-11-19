// The Aliases group: Archon's named model presets, each a name and a provider, a model and an
// effort. It shows the first 100 aliases in name order; the rest are counted, never shown and
// never sent. A saved alias's name is read-only. Remove keeps the row, struck through with Undo,
// until Save sends `null` for it or Discard brings it back. An alias is one Archon key, its name:
// a change to any of its fields sends the whole preset.
import { TIER_NAMES, type ConfigFacts } from './config'
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
  type GroupContext,
  type GroupSpec,
  type Loaded,
  type PresetFields,
  type Values
} from './form-group'
import type { FormField } from './forms-view'

export const ALIASES_PATH = '/api/config/aliases'

/** The form shows at most this many aliases, and holds at most this many, saved and new together. */
export const ALIASES_SHOWN = 100
/** A name is at most this long once trimmed. */
export const NAME_LENGTH = 64

export const ENTER_A_NAME = 'Enter a name'
export const NAME_NEEDS_AT = 'A name starts with @.'
export const NAME_RESERVED = 'small, medium and large are tier names. Choose another name.'
export const NAME_TOO_LONG = `A name is at most ${String(NAME_LENGTH)} characters.`
export const NAME_TAKEN = 'Another alias has this name.'

const ADD = 'add'
const REMOVE = 'remove'
const UNDO = 'undo'
const SAVED = 'saved:'
const NEW = 'new:'
/** `Loaded.shown` keys: the number of saved aliases, and each alias past the cap with its value. */
const TOTAL = 'total'
const HIDDEN = 'hidden:'
const UNREADABLE = '\u0000unreadable'
/** A new row that names an alias and holds no preset yet: never equal to a saved value. */
const INCOMPLETE = '\u0000incomplete'

/**
 * Field ids are `saved:<name>:<slot>` for a saved alias, by its name, and `new:<n>:<slot>` for a
 * row the person added, by the order it was added in. A name may hold a colon; the slot never does.
 */
type Slot = 'name' | 'provider' | 'model' | 'effort' | 'remove'

const fieldOf = (row: string, slot: Slot): string => `${row}:${slot}`
const rowOf = (fieldId: string): string => fieldId.slice(0, fieldId.lastIndexOf(':'))
const savedRow = (name: string): string => `${SAVED}${name}`
const presetOf = (row: string): PresetFields => ({ provider: fieldOf(row, 'provider'), model: fieldOf(row, 'model'), effort: fieldOf(row, 'effort') })

/** The saved alias's name a row stands for, or null for a new row. */
const savedName = (row: string): string | null => (row.startsWith(SAVED) ? row.slice(SAVED.length) : null)

/** The saved rows the form shows, in name order. */
const savedRows = (loaded: Loaded): string[] =>
  Object.keys(loaded.values)
    .filter((fieldId) => fieldId.startsWith(SAVED) && fieldId.endsWith(':provider'))
    .map(rowOf)

/** The rows the person added, in the order they were added. */
const newRows = (values: Values): string[] =>
  Object.keys(values)
    .filter((fieldId) => fieldId.startsWith(NEW) && fieldId.endsWith(':name'))
    .map(rowOf)

/** A row's preset as one text, or empty when it holds none. */
function presetText(values: Values, row: string): string {
  const ids = presetOf(row)
  const parts = [clean(values[ids.provider]), clean(values[ids.model]), clean(values[ids.effort])]
  return parts.every((part) => part === '') ? '' : parts.join('\u0000')
}

const shownRow = (loaded: Loaded, values: Values, row: string): boolean =>
  Object.hasOwn(loaded.values, fieldOf(row, 'provider')) && Object.hasOwn(values, fieldOf(row, 'provider'))

/** A saved row the person removed: its provider emptied, which only Remove does. */
const isRemoved = (values: Values, row: string): boolean => clean(values[fieldOf(row, 'provider')]) === ''

const hiddenKey = (name: string): string => `${HIDDEN}${name}`
const isTierName = (name: string): boolean => TIER_NAMES.some((tier) => tier === name)
const savedTotal = (loaded: Loaded): number => Number.parseInt(loaded.shown[TOTAL] ?? '0', 10)

/** The checks of a new row's name, before the duplicate check. */
function nameError(name: string): string | null {
  if (name === '') return ENTER_A_NAME
  if (isTierName(name)) return NAME_RESERVED
  if (!name.startsWith('@')) return NAME_NEEDS_AT
  if (name.length > NAME_LENGTH) return NAME_TOO_LONG
  return null
}

/** The fields of one preset, as drawn on a row. `none` is the provider select's empty choice, if it has one. */
function presetFields(
  row: string,
  label: string,
  current: Values,
  loaded: Loaded,
  errors: ReadonlyMap<string, string>,
  context: GroupContext,
  none: string | null
): FormField[] {
  const ids = presetOf(row)
  const error = (fieldId: string): string | null => errors.get(fieldId) ?? null
  const chosen = current[ids.provider] ?? ''
  const first = none === null ? [] : [{ value: '', label: none }]
  const options = providerOptions({ value: '', label: '' }, context, loaded.values[ids.provider] ?? '', chosen).slice(1)
  const fields: FormField[] = [
    { kind: 'select', id: ids.provider, label: `${label} provider`, value: chosen, options: [...first, ...options], error: error(ids.provider) },
    { kind: 'text', id: ids.model, label: `${label} model`, value: current[ids.model] ?? '', placeholder: '', maxLength: MODEL_LENGTH, error: error(ids.model) }
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

export function aliasesForm(): GroupSpec {
  /** The rows of `values` that stand for the alias `key`: the shown saved one, and the new ones named so. */
  const rowsNamed = (values: Values, loaded: Loaded, key: string): { saved: string | null; added: string[] } => {
    const row = savedRow(key)
    return {
      saved: shownRow(loaded, values, row) ? row : null,
      added: newRows(values).filter((added) => clean(values[fieldOf(added, 'name')]) === key)
    }
  }

  return {
    id: 'aliases',
    title: 'Aliases',
    path: ALIASES_PATH,

    load(config: ConfigFacts): Loaded {
      const values: Values = {}
      const unreadable = new Set<string>()
      const shown: Values = { [TOTAL]: String(config.aliases.size) }
      const names = [...config.aliases.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      names.forEach((name, index) => {
        const saved = config.aliases.get(name)
        const set = saved?.kind === 'set' ? saved.value : null
        if (index >= ALIASES_SHOWN) {
          // Never shown or sent: kept to tell whether it changed elsewhere, and to refuse its name.
          Object.defineProperty(shown, hiddenKey(name), {
            value: set === null ? UNREADABLE : [set.provider, set.model, set.effort ?? ''].join('\u0000'),
            enumerable: true,
            writable: true,
            configurable: true
          })
          return
        }
        const ids = presetOf(savedRow(name))
        values[ids.provider] = set?.provider ?? ''
        values[ids.model] = set?.model ?? ''
        values[ids.effort] = set?.effort ?? ''
        if (set === null) for (const fieldId of [ids.provider, ids.model, ids.effort]) unreadable.add(fieldId)
      })
      return { values, unreadable, shown }
    },

    keyOf(fieldId, values) {
      const row = rowOf(fieldId)
      return savedName(row) ?? clean(values[fieldOf(row, 'name')])
    },

    canonical(values, loaded, key) {
      const parts: string[] = []
      const { saved, added } = rowsNamed(values, loaded, key)
      if (Object.hasOwn(loaded.shown, hiddenKey(key))) parts.push(loaded.shown[hiddenKey(key)] ?? '')
      if (saved !== null) {
        if (loaded.unreadable.has(fieldOf(saved, 'provider'))) parts.push(UNREADABLE)
        else if (presetText(values, saved) !== '') parts.push(presetText(values, saved))
      }
      for (const row of added) {
        const text = presetText(values, row)
        if (text !== '' || key !== '') parts.push(text === '' ? INCOMPLETE : text)
      }
      return parts.join('\u0001')
    },

    keyLabel: (key) => `alias ${key}`,

    fields(current, loaded, errors, context) {
      const fields: FormField[] = []
      for (const row of savedRows(loaded)) {
        const name = savedName(row) ?? ''
        const ids = presetOf(row)
        if (loaded.unreadable.has(ids.provider)) {
          fields.push({ kind: 'unreadable', id: ids.provider, label: `Alias ${name}` })
          continue
        }
        if (isRemoved(current, row)) {
          fields.push({ kind: 'struck', id: fieldOf(row, 'name'), label: 'Alias', value: name })
          fields.push({ kind: 'button', id: fieldOf(row, 'remove'), text: `Undo removing ${name}`, value: UNDO, disabled: false })
          continue
        }
        fields.push({ kind: 'fixed', id: fieldOf(row, 'name'), label: 'Alias', value: name })
        fields.push(...presetFields(row, name, current, loaded, errors, context, null))
        fields.push({ kind: 'button', id: fieldOf(row, 'remove'), text: `Remove ${name}`, value: REMOVE, disabled: false })
      }
      const added = newRows(current)
      added.forEach((row, index) => {
        const label = `New alias ${String(index + 1)}`
        const id = fieldOf(row, 'name')
        const typed = clean(current[id])
        fields.push({ kind: 'text', id, label: `${label} name`, value: current[id] ?? '', placeholder: '@name', maxLength: NAME_LENGTH, error: errors.get(id) ?? null })
        fields.push(...presetFields(row, label, current, loaded, errors, context, CHOOSE_A_PROVIDER))
        fields.push({ kind: 'button', id: fieldOf(row, 'remove'), text: `Remove ${typed === '' ? label.toLowerCase() : typed}`, value: REMOVE, disabled: false })
      })
      const full = savedTotal(loaded) + added.length >= ALIASES_SHOWN
      fields.push({ kind: 'button', id: ADD, text: 'Add alias', value: ADD, disabled: full })
      return fields
    },

    edit(current, fieldId, value, context, loaded) {
      if (fieldId === ADD) {
        const next = newRows(current).reduce((most, row) => Math.max(most, Number.parseInt(row.slice(NEW.length), 10) + 1), 0)
        const row = `${NEW}${String(next)}`
        return { ...current, [fieldOf(row, 'name')]: '', [fieldOf(row, 'provider')]: '', [fieldOf(row, 'model')]: '', [fieldOf(row, 'effort')]: '' }
      }
      const row = rowOf(fieldId)
      const ids = presetOf(row)
      if (fieldId === fieldOf(row, 'remove')) {
        if (savedName(row) === null) {
          return Object.fromEntries(Object.entries(current).filter(([id]) => rowOf(id) !== row))
        }
        const restored = (id: string): string => (value === UNDO ? (loaded.values[id] ?? '') : '')
        return { ...current, [ids.provider]: restored(ids.provider), [ids.model]: restored(ids.model), [ids.effort]: restored(ids.effort) }
      }
      if (fieldId === ids.provider) return withProvider(current, ids, value, context)
      return { ...current, [fieldId]: value }
    },

    check(current, loaded, changed, context) {
      const errors = new Map<string, string>()
      for (const key of changed) {
        const { saved, added } = rowsNamed(current, loaded, key)
        const taken = added.length > 1 || saved !== null || Object.hasOwn(loaded.shown, hiddenKey(key))
        for (const row of added) {
          const error = nameError(key) ?? (taken ? NAME_TAKEN : null)
          if (error !== null) errors.set(fieldOf(row, 'name'), error)
        }
        const rows = [...added, ...(saved !== null && !isRemoved(current, saved) ? [saved] : [])]
        for (const row of rows) {
          if (clean(current[presetOf(row).provider]) === '') errors.set(presetOf(row).provider, CHOOSE_A_PROVIDER)
          else checkPreset(errors, presetOf(row), current, context)
        }
      }
      return errors
    },

    body(current, changed) {
      // A new row that shares its name with a saved one never passes the checks, so each key has one row.
      const entries = changed.map((key): [string, ReturnType<typeof presetBody>] => {
        const added = newRows(current).find((row) => clean(current[fieldOf(row, 'name')]) === key)
        return [key, presetBody(presetOf(added ?? savedRow(key)), current)]
      })
      return { aliases: Object.fromEntries(entries) }
    },

    summary(loaded) {
      const total = savedTotal(loaded)
      return total === 0 ? 'No aliases' : total === 1 ? '1 alias' : `${String(total)} aliases`
    },

    notes(loaded) {
      const more = savedTotal(loaded) - savedRows(loaded).length
      if (more <= 0) return []
      return [more === 1 ? '1 more alias is not shown. Edit it in config.yaml.' : `${String(more)} more aliases are not shown. Edit them in config.yaml.`]
    }
  }
}
