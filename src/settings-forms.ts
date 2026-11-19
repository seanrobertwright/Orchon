// The editable groups of the Settings section, in the worker: one unsaved form per group, held in
// memory, and the save. A save checks the changed keys, re-reads `GET /api/config` and compares
// each changed key's saved value with its loaded value; on a difference nothing is written and the
// person chooses to load, overwrite or keep editing. The request holds only the changed keys. No
// save is retried: one that times out is followed by a read that says whether it landed (#20, part 9).
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { Client, ClientFailure } from './client'
import { CONFIG_PATH, parseConfig, parseProviders, PROVIDERS_PATH, type ConfigFacts, type Providers } from './config'
import type { ConnectionView } from './connection-view'
import { defaultsForm } from './defaults-form'
import { clean, type GroupContext, type GroupSpec, type Loaded, type Values } from './form-group'
import type { ConflictChoice, FormGroupId, FormNotice, FormsAnswer, FormsView, FormView } from './forms-view'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { isRecord, own, refuseRequest } from './records'
import { tiersForm } from './tiers-form'

/** The groups, in the order the section shows them. */
const GROUP_IDS: readonly FormGroupId[] = ['defaults', 'tiers']

/** A value from a frame longer than this is refused, not cut. The field's own limit is checked on Save. */
const VALUE_LENGTH = 1_000
/** A frame's edit names at most this many fields. */
const EDITS_CAP = 200
/** Archon's message on a refused save is shown cut to this length. */
const MESSAGE_LENGTH = 500

const SAVED = 'Saved.'
const NOT_CONNECTED = 'Changes are turned off until Archon answers.'

type Conflict = { keys: string[]; latest: Loaded }

type GroupState = {
  spec: GroupSpec
  /** The values as last loaded, or null before the first read. */
  loaded: Loaded | null
  /** The form: the loaded values with the person's edits over them. */
  current: Values
  saving: boolean
  notice: FormNotice | null
  conflict: Conflict | null
}

export type SettingsFormsPorts = {
  client: Client
  /** The connection state now, once the settings were first read. */
  current(): Promise<ConnectionView>
  now(): number
  /** Called with each view made by a save or a read that no request waits for. */
  changed(view: FormsView): void
}

export type SettingsForms = {
  read(): Promise<FormsAnswer>
  edit(group: FormGroupId, edits: Values): Promise<FormsAnswer>
  discard(group: FormGroupId): Promise<FormsAnswer>
  save(group: FormGroupId): Promise<FormsAnswer>
  resolve(group: FormGroupId, choice: ConflictChoice): Promise<FormsAnswer>
}

/** A canonical text of one key's saved value: its fields' trimmed values, empty ones left out. */
function keyValue(spec: GroupSpec, loaded: Loaded, key: string, values: Values = loaded.values): string {
  const parts: string[] = []
  for (const fieldId of Object.keys(values).sort()) {
    if (spec.keyOf(fieldId) !== key) continue
    if (loaded.unreadable.has(fieldId)) parts.push(`${fieldId}\u0000unreadable`)
    else if (clean(values[fieldId]) !== '') parts.push(`${fieldId}\u0000${clean(values[fieldId])}`)
  }
  return parts.join('\u0001')
}

/** The keys whose value in the form differs from the loaded one. */
function changedKeys(state: GroupState): string[] {
  const { loaded, spec } = state
  if (loaded === null) return []
  const keys = new Set([...Object.keys(loaded.values), ...Object.keys(state.current)].map((fieldId) => spec.keyOf(fieldId)))
  return [...keys].filter((key) => keyValue(spec, loaded, key, state.current) !== keyValue(spec, loaded, key))
}

/** Archon's message on a refused save, or a sentence of our own when it sent none. */
function refusal(failure: Extract<ClientFailure, { kind: 'status' }>): string {
  const error = isRecord(failure.body) ? own(failure.body, 'error') : undefined
  if (typeof error === 'string' && error.trim() !== '') return error.trim().slice(0, MESSAGE_LENGTH)
  return `Archon refused the change (${String(failure.status)}).`
}

const EMPTY_PROVIDERS: Providers = { shown: [], all: new Map(), more: 0, unreadable: 0 }

export function createSettingsForms(ports: SettingsFormsPorts): SettingsForms {
  const groups = new Map<FormGroupId, GroupState>(
    [defaultsForm(), tiersForm()].map((spec) => [spec.id, { spec, loaded: null, current: {}, saving: false, notice: null, conflict: null }])
  )
  let providers: Providers = EMPTY_PROVIDERS
  let failure: string | null = null
  let since = ports.now()
  /** The store the forms were loaded from: its id, or the base URL when the server reports none. */
  let store: string | null = null

  const context = (): GroupContext => ({ providers })
  const group = (id: FormGroupId): GroupState => {
    const found = groups.get(id)
    if (found === undefined) throw new Error(`No group ${id}.`)
    return found
  }

  /** A changed store clears every form: nothing is carried from one Archon to another. */
  function checkStore(connection: ConnectionView): void {
    if (connection.kind !== 'connected') return
    const next = connection.storeId ?? connection.baseUrl
    if (store !== null && store !== next) {
      for (const state of groups.values()) {
        Object.assign(state, { loaded: null, current: {}, notice: null, conflict: null })
      }
      providers = EMPTY_PROVIDERS
      failure = null
    }
    store = next
  }

  function groupView(state: GroupState): FormView {
    const { spec, loaded } = state
    const changed = changedKeys(state)
    const notes: string[] = []
    if (providers.more > 0) {
      notes.push(`${String(providers.more)} more registered providers are not listed. Edit config.yaml to use one of them.`)
    }
    if (providers.unreadable > 0) notes.push(`${String(providers.unreadable)} providers could not be read and are not listed.`)
    if (loaded === null) {
      return { group: spec.id, title: spec.title, summary: '', loaded: false, fields: [], notes, dirty: false, saving: state.saving, notice: state.notice, conflict: null }
    }
    const errors = spec.check(state.current, loaded, changed, context())
    return {
      group: spec.id,
      title: spec.title,
      summary: changed.length > 0 ? 'Unsaved changes' : spec.summary(loaded, context()),
      loaded: true,
      fields: spec.fields(state.current, loaded, errors, context()),
      notes,
      dirty: changed.length > 0,
      saving: state.saving,
      notice: state.notice,
      conflict: state.conflict === null ? null : { keys: state.conflict.keys.map((key) => spec.keyLabel(key)) }
    }
  }

  function view(): FormsView {
    since = Math.max(ports.now(), since + 1)
    return {
      since,
      failure,
      providers: providers.shown,
      defaults: groupView(group('defaults')),
      tiers: groupView(group('tiers'))
    }
  }

  async function answer(): Promise<FormsAnswer> {
    return { connection: await ports.current(), forms: view() }
  }

  /** Fills a group from a config. A group with unsaved edits, or a save out, keeps its form. */
  function fill(state: GroupState, config: ConfigFacts, force = false): void {
    if (!force && (state.saving || changedKeys(state).length > 0)) return
    state.loaded = state.spec.load(config)
    state.current = { ...state.loaded.values }
  }

  /** The config now, or why it could not be read. */
  async function readConfig(baseUrl: string, version: string | null): Promise<ConfigFacts | string> {
    const answer = await ports.client.request({ baseUrl, path: CONFIG_PATH, timeout: 'read' })
    if (!answer.ok) return readFailureText(answer.failure)
    return parseConfig(answer.value) ?? unreadableAnswerText(version)
  }

  /** The read in flight, so a second one waits for it instead of starting its own. */
  let reading: Promise<void> | undefined

  /** Reads the config and the providers, and fills every group without unsaved edits. */
  function readAll(): Promise<void> {
    reading ??= (async () => {
      const connection = await ports.current()
      checkStore(connection)
      if (connection.kind !== 'connected') return
      const { baseUrl, version } = connection
      const [config, listed] = await Promise.all([
        readConfig(baseUrl, version),
        ports.client.request({ baseUrl, path: PROVIDERS_PATH, timeout: 'read' })
      ])
      const parsed = listed.ok ? parseProviders(listed.value) : null
      if (parsed !== null) providers = parsed
      if (typeof config === 'string') failure = config
      else if (!listed.ok) failure = readFailureText(listed.failure)
      else if (parsed === null) failure = unreadableAnswerText(version)
      else failure = null
      if (typeof config !== 'string') for (const state of groups.values()) fill(state, config)
    })().finally(() => {
      reading = undefined
    })
    return reading
  }

  /** Sends the changed keys. The outcome is the group's notice; the view is posted when it ends. */
  async function send(state: GroupState, baseUrl: string, version: string | null): Promise<void> {
    const changed = changedKeys(state)
    const sent = { ...state.current }
    const result = await ports.client.request({
      baseUrl,
      path: state.spec.path,
      method: 'PATCH',
      timeout: 'write',
      body: state.spec.body(sent, changed),
      errorBody: true
    })
    if (result.ok) {
      const config = parseConfig(result.value)
      if (config === null) {
        state.notice = { tone: 'warning', text: `The change was sent, but ${unreadableAnswerText(version)}` }
        return
      }
      fill(state, config, true)
      state.notice = { tone: 'success', text: SAVED }
      return
    }
    if (result.failure.kind === 'status' && result.failure.status === 400) {
      state.notice = { tone: 'danger', text: refusal(result.failure) }
      return
    }
    if (result.failure.kind !== 'timeout') {
      state.notice = { tone: 'danger', text: `${readFailureText(result.failure)} The change was not saved.` }
      return
    }
    // Not retried: a read says whether the change landed.
    const late = `Archon did not answer within ${String(result.failure.timeoutMs / 1000)} seconds.`
    const after = await readConfig(baseUrl, version)
    if (typeof after === 'string') {
      state.notice = { tone: 'danger', text: `${late} Orchon could not tell whether the change was saved. Your edits are kept.` }
      return
    }
    const latest = state.spec.load(after)
    const landed = changed.every((key) => keyValue(state.spec, latest, key) === keyValue(state.spec, latest, key, sent))
    if (landed) {
      fill(state, after, true)
      state.notice = { tone: 'success', text: `${late} The change was saved.` }
    } else {
      state.notice = { tone: 'danger', text: `${late} The change was not saved. Your edits are kept.` }
    }
  }

  /**
   * The save itself, once the group is marked saving. With `overwrite` the outside-change check
   * is skipped: the person chose to overwrite.
   */
  async function run(state: GroupState, overwrite: boolean): Promise<void> {
    try {
      const connection = await ports.current()
      if (connection.kind !== 'connected') {
        state.notice = { tone: 'warning', text: NOT_CONNECTED }
        return
      }
      const { baseUrl, version } = connection
      if (!overwrite) {
        const latest = await readConfig(baseUrl, version)
        if (typeof latest === 'string') {
          state.notice = { tone: 'danger', text: `${latest} Nothing was saved.` }
          return
        }
        const loaded = state.loaded
        if (loaded === null) return
        const fresh = state.spec.load(latest)
        const differs = changedKeys(state).filter((key) => keyValue(state.spec, fresh, key) !== keyValue(state.spec, loaded, key))
        if (differs.length > 0) {
          state.conflict = { keys: differs, latest: fresh }
          return
        }
      }
      await send(state, baseUrl, version)
    } finally {
      state.saving = false
      const after = state.notice?.tone === 'success' ? readAll() : Promise.resolve()
      void after.finally(() => ports.changed(view()))
    }
  }

  /** Starts a save when the group holds changes and passes its checks. The answer comes at once. */
  async function startSave(state: GroupState, overwrite: boolean): Promise<FormsAnswer> {
    const connection = await ports.current()
    checkStore(connection)
    const { loaded } = state
    if (state.saving || loaded === null) return answer()
    if (connection.kind !== 'connected') {
      state.notice = { tone: 'warning', text: NOT_CONNECTED }
      return answer()
    }
    const changed = changedKeys(state)
    if (changed.length === 0) return answer()
    // A failed check shows on its field, and nothing is sent.
    if (state.spec.check(state.current, loaded, changed, context()).size > 0) {
      state.notice = null
      return answer()
    }
    state.saving = true
    state.notice = null
    state.conflict = null
    void run(state, overwrite)
    return answer()
  }

  return {
    async read() {
      await readAll()
      return answer()
    },

    async edit(id, edits) {
      const state = group(id)
      checkStore(await ports.current())
      if (state.saving) refuseRequest('This group is being saved.')
      const loaded = state.loaded
      if (loaded === null) refuseRequest('This group has not loaded yet.')
      for (const [fieldId, value] of Object.entries(edits)) {
        const drawn = state.spec.fields(state.current, loaded, new Map(), context())
        const target = drawn.find((field) => field.id === fieldId)
        if (target === undefined || target.kind === 'unreadable') refuseRequest(`The ${state.spec.title} group has no field ${fieldId}.`)
        if (target.kind === 'select' && !target.options.some((option) => option.value === value)) {
          refuseRequest(`${value} is not a choice of ${target.label}.`)
        }
        state.current = state.spec.edit(state.current, fieldId, value, context())
      }
      state.notice = null
      return answer()
    },

    async discard(id) {
      const state = group(id)
      checkStore(await ports.current())
      if (!state.saving && state.loaded !== null) {
        state.current = { ...state.loaded.values }
        state.notice = null
        state.conflict = null
      }
      return answer()
    },

    save: (id) => startSave(group(id), false),

    async resolve(id, choice) {
      const state = group(id)
      checkStore(await ports.current())
      const conflict = state.conflict
      if (conflict === null || state.saving) return answer()
      state.conflict = null
      if (choice === 'overwrite') return startSave(state, true)
      if (choice === 'load') {
        // Loads the saved values, losing the edits to the keys changed elsewhere only.
        const kept = Object.entries(state.current).filter(([fieldId]) => !conflict.keys.includes(state.spec.keyOf(fieldId)))
        state.loaded = conflict.latest
        state.current = { ...conflict.latest.values, ...Object.fromEntries(kept.filter(([fieldId]) => !conflict.latest.unreadable.has(fieldId))) }
      }
      return answer()
    }
  }
}

/** A frame sends `forms.read` with no input. */
function refuseInput(input: unknown): void {
  if (input === undefined || input === null) return
  refuseRequest('This request takes no input.')
}

const isGroup = (value: unknown): value is FormGroupId => GROUP_IDS.some((id) => id === value)
const CHOICES: readonly ConflictChoice[] = ['load', 'overwrite', 'keep']

/** A frame's request input: a record of the given keys only, with a known group. */
function parseGroupInput(input: unknown, keys: readonly string[]): Record<string, unknown> & { group: FormGroupId } {
  if (!isRecord(input)) refuseRequest('The request takes a group.')
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) refuseRequest(`The request does not take ${key}.`)
  }
  const id = own(input, 'group')
  if (!isGroup(id)) refuseRequest(`The group must be one of ${GROUP_IDS.join(', ')}.`)
  return { ...input, group: id }
}

function parseEdits(value: unknown): Values {
  if (!isRecord(value)) refuseRequest('The edits must be an object of field ids and values.')
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > EDITS_CAP) refuseRequest(`An edit names from 1 to ${String(EDITS_CAP)} fields.`)
  const edits: Values = {}
  for (const [fieldId, text] of entries) {
    if (typeof text !== 'string' || text.length > VALUE_LENGTH) refuseRequest(`The value of ${fieldId} must be text of at most ${String(VALUE_LENGTH)} characters.`)
    Object.defineProperty(edits, fieldId, { value: text, enumerable: true, writable: true, configurable: true })
  }
  return edits
}

/** Answers the frames' forms requests. */
export function startSettingsForms(orca: OrcaWorkerApi, ports: Omit<SettingsFormsPorts, 'changed'>): Disposable {
  const forms = createSettingsForms({ ...ports, changed: (view) => orca.panels.post('forms.changed', view) })
  const subscriptions = [
    orca.panels.handle('forms.read', (input) => {
      refuseInput(input)
      return forms.read()
    }),
    orca.panels.handle('forms.edit', (input) => {
      const parsed = parseGroupInput(input, ['group', 'edits'])
      return forms.edit(parsed.group, parseEdits(own(parsed, 'edits')))
    }),
    orca.panels.handle('forms.discard', (input) => forms.discard(parseGroupInput(input, ['group']).group)),
    orca.panels.handle('forms.save', (input) => forms.save(parseGroupInput(input, ['group']).group)),
    orca.panels.handle('forms.resolve', (input) => {
      const parsed = parseGroupInput(input, ['group', 'choice'])
      const choice = own(parsed, 'choice')
      const known = CHOICES.find((option) => option === choice)
      if (known === undefined) refuseRequest(`The choice must be one of ${CHOICES.join(', ')}.`)
      return forms.resolve(parsed.group, known)
    })
  ]
  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
