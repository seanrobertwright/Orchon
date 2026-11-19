// The Defaults group: the default assistant, a plain-text model per registered provider and, when
// Codex is registered, its reasoning effort and web search mode. A saved value can be replaced
// here but not cleared, because `PATCH /api/config/assistants` merges what it is sent over what
// is saved (#20, part 5).
import { CODEX, WEB_SEARCH_MODES, type ConfigFacts, type Saved } from './config'
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
  type GroupContext,
  type GroupSpec,
  type Loaded,
  type Values
} from './form-group'
import type { FormField } from './forms-view'

export const ASSISTANTS_PATH = '/api/config/assistants'

/** The message of #20 for a saved value emptied. */
export const CANNOT_CLEAR = 'A saved value can be replaced here but not removed. Edit config.yaml to remove it.'

const ASSISTANT = 'assistant'
const CODEX_EFFORT = 'codex:effort'
const CODEX_WEB_SEARCH = 'codex:webSearch'
const MODEL_PREFIX = 'model:'
const INHERIT = { value: '', label: 'Inherit' }

const modelField = (providerId: string): string => `${MODEL_PREFIX}${providerId}`

/** The labels of the fields that are not a provider's model. A field id is its Archon key. */
const LABELS: Readonly<Record<string, string>> = {
  [ASSISTANT]: 'Default assistant',
  [CODEX_EFFORT]: 'Codex reasoning effort',
  [CODEX_WEB_SEARCH]: 'Codex web search'
}

/** A field's label. A model field is named by its provider, through `name`. */
function labelOf(fieldId: string, name: (providerId: string) => string): string {
  if (Object.hasOwn(LABELS, fieldId)) return LABELS[fieldId] ?? fieldId
  return `${name(fieldId.slice(MODEL_PREFIX.length))} model`
}

export function defaultsForm(): GroupSpec {
  const label = (fieldId: string, context: GroupContext): string =>
    labelOf(fieldId, (id) => context.providers.all.get(id)?.displayName ?? id)

  return {
    id: 'defaults',
    title: 'Defaults',
    path: ASSISTANTS_PATH,

    load(config: ConfigFacts): Loaded {
      const values: Values = {}
      const unreadable = new Set<string>()
      const put = (fieldId: string, saved: Saved<string>): void => {
        values[fieldId] = saved.kind === 'set' ? saved.value : ''
        if (saved.kind === 'unreadable') unreadable.add(fieldId)
      }
      put(ASSISTANT, config.assistant)
      for (const [id, saved] of config.models) put(modelField(id), saved)
      put(CODEX_EFFORT, config.codexEffort)
      put(CODEX_WEB_SEARCH, config.codexWebSearch)
      return { values, unreadable }
    },

    keyOf: (fieldId) => fieldId,

    keyLabel: (key) => labelOf(key, (id) => id),

    fields(current, loaded, errors, context) {
      const fields: FormField[] = []
      const draw = (fieldId: string, make: () => FormField): void => {
        fields.push(loaded.unreadable.has(fieldId) ? { kind: 'unreadable', id: fieldId, label: label(fieldId, context) } : make())
      }
      const error = (fieldId: string): string | null => errors.get(fieldId) ?? null
      const value = (fieldId: string): string => current[fieldId] ?? ''
      draw(ASSISTANT, () => ({
        kind: 'select',
        id: ASSISTANT,
        label: label(ASSISTANT, context),
        value: value(ASSISTANT),
        options: providerOptions(INHERIT, context, loaded.values[ASSISTANT] ?? '', value(ASSISTANT)),
        error: error(ASSISTANT)
      }))
      for (const provider of context.providers.shown) {
        const fieldId = modelField(provider.id)
        draw(fieldId, () => ({
          kind: 'text',
          id: fieldId,
          label: label(fieldId, context),
          value: value(fieldId),
          placeholder: 'Inherit',
          maxLength: MODEL_LENGTH,
          error: error(fieldId)
        }))
      }
      if (registered(context, CODEX)) {
        draw(CODEX_EFFORT, () => ({
          kind: 'select',
          id: CODEX_EFFORT,
          label: label(CODEX_EFFORT, context),
          value: value(CODEX_EFFORT),
          options: effortOptions(INHERIT, effortLevelsOf(context, CODEX), loaded.values[CODEX_EFFORT] ?? '', value(CODEX_EFFORT)),
          error: error(CODEX_EFFORT)
        }))
        draw(CODEX_WEB_SEARCH, () => ({
          kind: 'select',
          id: CODEX_WEB_SEARCH,
          label: label(CODEX_WEB_SEARCH, context),
          value: value(CODEX_WEB_SEARCH),
          options: [INHERIT, ...WEB_SEARCH_MODES.map((mode) => ({ value: mode, label: mode }))],
          error: error(CODEX_WEB_SEARCH)
        }))
      }
      return fields
    },

    edit: (current, fieldId, value) => ({ ...current, [fieldId]: value }),

    check(current, loaded, changed, context) {
      const errors = new Map<string, string>()
      for (const fieldId of changed) {
        const value = clean(current[fieldId])
        if (value === '') {
          if (clean(loaded.values[fieldId]) !== '') errors.set(fieldId, CANNOT_CLEAR)
          continue
        }
        if (fieldId === ASSISTANT && !registered(context, value)) errors.set(fieldId, NOT_REGISTERED)
        else if (fieldId === CODEX_EFFORT && !effortLevelsOf(context, CODEX).includes(value)) {
          errors.set(fieldId, `${providerName(context, CODEX)} does not accept this effort.`)
        } else if (fieldId === CODEX_WEB_SEARCH && !WEB_SEARCH_MODES.some((mode) => mode === value)) {
          errors.set(fieldId, 'Choose disabled, cached or live.')
        } else if (fieldId.startsWith(MODEL_PREFIX)) {
          if (!registered(context, fieldId.slice(MODEL_PREFIX.length))) errors.set(fieldId, NOT_REGISTERED)
          else if (value.length > MODEL_LENGTH) errors.set(fieldId, MODEL_TOO_LONG)
        }
      }
      return errors
    },

    body(current, changed) {
      const body: { assistant?: string; assistants?: Record<string, Record<string, string>> } = {}
      const assistants = new Map<string, Record<string, string>>()
      const entry = (id: string): Record<string, string> => {
        const found = assistants.get(id) ?? {}
        assistants.set(id, found)
        return found
      }
      for (const fieldId of changed) {
        const value = clean(current[fieldId])
        if (fieldId === ASSISTANT) body.assistant = value
        else if (fieldId === CODEX_EFFORT) entry(CODEX).modelReasoningEffort = value
        else if (fieldId === CODEX_WEB_SEARCH) entry(CODEX).webSearchMode = value
        else if (fieldId.startsWith(MODEL_PREFIX)) entry(fieldId.slice(MODEL_PREFIX.length)).model = value
      }
      if (assistants.size > 0) body.assistants = Object.fromEntries(assistants)
      return body
    },

    summary(loaded, context) {
      if (loaded.unreadable.has(ASSISTANT)) return 'Default assistant Unreadable'
      const id = loaded.values[ASSISTANT] ?? ''
      if (id === '') return 'Default assistant Inherit'
      const model = loaded.unreadable.has(modelField(id)) ? 'Unreadable' : loaded.values[modelField(id)] || 'Inherit'
      return `${providerName(context, id)}, model ${model}`
    }
  }
}
