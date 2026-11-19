// Archon's install-wide configuration and its registered providers, as the worker reads them from
// `GET /api/config` and `GET /api/providers`. Each validator lists only the fields the editable
// groups read; unknown fields are ignored, and a field newer than the floor would be optional.
import type { ProviderView } from './forms-view'
import { isRecord, own } from './records'

export const CONFIG_PATH = '/api/config'
export const PROVIDERS_PATH = '/api/providers'

/** The reserved tier names, in the order the form shows them. */
export const TIER_NAMES = ['small', 'medium', 'large'] as const
export type TierName = (typeof TIER_NAMES)[number]

/** Codex's web search modes, the only values Archon takes for `webSearchMode`. */
export const WEB_SEARCH_MODES = ['disabled', 'cached', 'live'] as const

/** The provider whose defaults have two extra fields. */
export const CODEX = 'codex'

/** A model choice: a provider, a model and an optional effort. */
export type Preset = { provider: string; model: string; effort: string | null }

/** A saved value: nothing saved, a value, or something saved that does not validate. */
export type Saved<T> = { kind: 'unset' } | { kind: 'set'; value: T } | { kind: 'unreadable' }

const UNSET = { kind: 'unset' } as const
const UNREADABLE = { kind: 'unreadable' } as const

export type ConfigFacts = {
  /** The default assistant. */
  assistant: Saved<string>
  /** Each provider's saved default model, by provider id, for every provider the config names. */
  models: Map<string, Saved<string>>
  /** Codex's reasoning effort and web search mode. */
  codexEffort: Saved<string>
  codexWebSearch: Saved<string>
  tiers: Record<TierName, Saved<Preset>>
  /** What an unset tier resolves to, or null when there is no built-in default. */
  tierDefaults: Record<TierName, Preset | null>
  /** Every saved alias, by name, as Archon keeps it: a preset, or unreadable when it is not one. */
  aliases: Map<string, Saved<Preset>>
}

/** A field of an optional string: absent is unset, a non-empty string is set, anything else unreadable. */
function savedText(record: Record<string, unknown>, key: string): Saved<string> {
  if (!Object.hasOwn(record, key)) return UNSET
  const value = record[key]
  if (value === undefined || value === null) return UNSET
  return typeof value === 'string' && value !== '' ? { kind: 'set', value } : UNREADABLE
}

/** A preset, or null when it is not one: a non-empty provider and model, and an optional string effort. */
function preset(value: unknown): Preset | null {
  if (!isRecord(value)) return null
  const provider = own(value, 'provider')
  const model = own(value, 'model')
  const effort = own(value, 'effort')
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null
  if (effort !== undefined && (typeof effort !== 'string' || effort === '')) return null
  return { provider, model, effort: effort ?? null }
}

function tierRecord<T>(value: unknown, read: (entry: unknown) => T, unset: T): Record<TierName, T> {
  const record = isRecord(value) ? value : {}
  const entries = TIER_NAMES.map((tier): [TierName, T] => {
    const entry = own(record, tier)
    return [tier, entry === undefined || entry === null ? unset : read(entry)]
  })
  return Object.fromEntries(entries) as Record<TierName, T>
}

/**
 * Validates a config answer. Null when it is not one: no `config` object, or no `assistants`
 * record, which the floor always sends. A value inside that fails is kept as unreadable.
 */
export function parseConfig(value: unknown): ConfigFacts | null {
  if (!isRecord(value)) return null
  const config = own(value, 'config')
  if (!isRecord(config)) return null
  const assistants = own(config, 'assistants')
  if (!isRecord(assistants)) return null
  const tiers = own(config, 'tiers')
  if (tiers !== undefined && !isRecord(tiers)) return null
  const aliasRecord = own(config, 'aliases')
  if (aliasRecord !== undefined && aliasRecord !== null && !isRecord(aliasRecord)) return null
  const aliases = new Map<string, Saved<Preset>>()
  for (const [name, entry] of Object.entries(isRecord(aliasRecord) ? aliasRecord : {})) {
    if (entry === undefined || entry === null) continue
    const read = preset(entry)
    aliases.set(name, read === null ? UNREADABLE : { kind: 'set', value: read })
  }
  const models = new Map<string, Saved<string>>()
  for (const [id, entry] of Object.entries(assistants)) {
    if (id === '') continue
    models.set(id, isRecord(entry) ? savedText(entry, 'model') : UNREADABLE)
  }
  const codex = own(assistants, CODEX)
  const codexFields = isRecord(codex) ? codex : {}
  const webSearch = savedText(codexFields, 'webSearchMode')
  return {
    assistant: savedText(config, 'assistant'),
    models,
    codexEffort: savedText(codexFields, 'modelReasoningEffort'),
    codexWebSearch:
      webSearch.kind === 'set' && !WEB_SEARCH_MODES.some((mode) => mode === webSearch.value) ? UNREADABLE : webSearch,
    tiers: tierRecord<Saved<Preset>>(
      tiers,
      (entry) => {
        const read = preset(entry)
        return read === null ? UNREADABLE : { kind: 'set', value: read }
      },
      UNSET
    ),
    tierDefaults: tierRecord<Preset | null>(own(config, 'tierDefaults'), preset, null),
    aliases
  }
}

/** The providers select lists at most this many. */
export const PROVIDERS_SHOWN = 50

/** Outside text is cut to this length for display. */
const NAME_LENGTH = 100
/** An effort list longer than this is not one Archon wrote. */
const EFFORT_LEVELS_CAP = 50

export type Providers = {
  /** The first registered providers that could be read, at most the cap, in Archon's order. */
  shown: ProviderView[]
  /** Every registered provider that could be read, by id, the ones past the cap included. */
  all: Map<string, ProviderView>
  /** Providers past the cap. */
  more: number
  /** Rows that could not be read, and were dropped. */
  unreadable: number
}

function provider(value: unknown): ProviderView | null {
  if (!isRecord(value)) return null
  const id = own(value, 'id')
  if (typeof id !== 'string' || id === '' || id.length > NAME_LENGTH) return null
  const name = own(value, 'displayName')
  const levels = own(value, 'effortLevels')
  let effortLevels: string[] | null = null
  if (levels !== undefined) {
    if (!Array.isArray(levels) || levels.length > EFFORT_LEVELS_CAP) return null
    if (!levels.every((level): level is string => typeof level === 'string' && level !== '' && level.length <= NAME_LENGTH)) return null
    effortLevels = levels.length === 0 ? null : [...levels]
  }
  const displayName = typeof name === 'string' && name !== '' ? name.slice(0, NAME_LENGTH) : id
  return { id, displayName, effortLevels }
}

/** Validates a providers answer. Null when it holds no `providers` list. A row that fails is dropped and counted. */
export function parseProviders(value: unknown): Providers | null {
  if (!isRecord(value)) return null
  const rows = own(value, 'providers')
  if (!Array.isArray(rows)) return null
  const all = new Map<string, ProviderView>()
  let unreadable = 0
  for (const row of rows) {
    const read = provider(row)
    if (read === null || all.has(read.id)) unreadable += 1
    else all.set(read.id, read)
  }
  const listed = [...all.values()]
  return { shown: listed.slice(0, PROVIDERS_SHOWN), all, more: Math.max(0, listed.length - PROVIDERS_SHOWN), unreadable }
}
