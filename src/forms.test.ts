// The worker's request protocol seam: the worker mounted on a scripted Archon and clock. These
// tests cover the editable groups of the Settings section, Defaults and Model tiers: what the
// config and the providers are read into, what a save sends, and the outside-change check. The
// `PATCH /api/config/*` exchanges are replayed from the recorded fixtures.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  HANG,
  json,
  recorded,
  recordedRequest,
  RELEASES,
  scene,
  settle,
  type MountedScene,
  type Release,
  type Scene,
  type Scripted,
  type ScriptedCall
} from '../scripts/scripted-archon.ts'
import type { FormField, FormsView, FormView } from './forms-view'

const CONFIG = `${DEFAULT}/api/config`
const PROVIDERS = `${DEFAULT}/api/providers`
const ASSISTANTS = `${DEFAULT}/api/config/assistants`
const TIERS = `${DEFAULT}/api/config/tiers`

/** A worker connected at the default address to a release, answering its recorded fixtures. */
async function connectedTo(release: Release): Promise<{ stage: Scene; mounted: MountedScene }> {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, recorded(release, 'health'))
  stage.archon.answer(DEFAULT_OPENAPI, recorded(release, 'openapi'))
  stage.archon.answer(CONFIG, recorded(release, 'config'))
  stage.archon.answer(PROVIDERS, recorded(release, 'providers'))
  const mounted = await stage.mount()
  assert.equal(mounted.latest().kind, 'connected')
  return { stage, mounted }
}

/** The recorded providers answer with Codex added, as an Archon with Codex registered gives it. */
function providersWithCodex(release: Release): ReturnType<typeof json> {
  const answer = recorded(release, 'providers')
  if (answer.kind !== 'json') throw new Error('The recorded providers answer is not JSON.')
  const body = answer.value as { providers: unknown[] }
  const codex = { id: 'codex', displayName: 'Codex', builtIn: true, effortLevels: ['low', 'medium', 'high'], capabilities: { x: true } }
  return json({ ...body, providers: [...body.providers, codex] })
}

/** A config answer: the recorded one of a release with its `config` fields replaced. */
function configWith(release: Release, fields: Record<string, unknown>): ReturnType<typeof json> {
  const answer = recorded(release, 'config')
  if (answer.kind !== 'json') throw new Error('The recorded config answer is not JSON.')
  const body = answer.value as { config: Record<string, unknown>; database: string }
  return json({ ...body, config: { ...body.config, ...fields } })
}

const field = (form: FormView, id: string): FormField => {
  const found = form.fields.find((candidate) => candidate.id === id)
  assert.ok(found, `no field ${id} in ${form.group}`)
  return found
}

/** A field's value, or null for an unreadable one. */
const valueOf = (form: FormView, id: string): string | null => {
  const found = field(form, id)
  return found.kind === 'unreadable' || found.kind === 'button' ? null : found.value
}

const errorOf =(form: FormView, id: string): string | null => {
  const found = field(form, id)
  return found.kind === 'select' || found.kind === 'text' ? found.error : null
}

/** Every forms view the worker posted, in order. */
const formsPosts = (mounted: MountedScene): FormsView[] =>
  mounted.worker.posts.filter((post) => post.event === 'forms.changed').map((post) => post.payload as FormsView)

/** The newest forms view, of the answers given and the posts, as a frame keeps it. */
function newest(mounted: MountedScene, answered: FormsView): FormsView {
  return [answered, ...formsPosts(mounted)].reduce((kept, next) => (next.since > kept.since ? next : kept))
}

/** The calls made to Archon since the mark, as "METHOD path". */
const callsSince = (stage: Scene, mark: number): string[] =>
  stage.archon.calls.slice(mark).map((call) => `${call.method} ${new URL(call.url).pathname}`)

const bodyOf = (call: ScriptedCall | undefined): unknown => (call?.body === undefined ? undefined : JSON.parse(call.body))

const RECORDED_PROVIDERS = [
  { value: 'opencode', label: 'OpenCode (community)' },
  { value: 'copilot', label: 'Copilot (GitHub)' },
  { value: 'claude', label: 'Claude (Anthropic)' }
]
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']

describe('reading the editable groups', () => {
  for (const release of RELEASES) {
    test(`reads the recorded config and providers of ${release} into Defaults and Model tiers`, async () => {
      const { mounted } = await connectedTo(release)
      const { connection, forms } = await mounted.worker.request('forms.read')
      assert.equal(connection.kind, 'connected')
      assert.equal(forms.failure, null)
      // Read by eye from the recorded providers: Codex is not registered in any recorded release.
      assert.deepEqual(forms.providers, [
        { id: 'opencode', displayName: 'OpenCode (community)', effortLevels: null },
        { id: 'copilot', displayName: 'Copilot (GitHub)', effortLevels: EFFORT_LEVELS },
        { id: 'claude', displayName: 'Claude (Anthropic)', effortLevels: EFFORT_LEVELS }
      ])
      assert.deepEqual(forms.defaults.fields, [
        {
          kind: 'select',
          id: 'assistant',
          label: 'Default assistant',
          value: 'claude',
          options: [{ value: '', label: 'Inherit' }, ...RECORDED_PROVIDERS],
          error: null
        },
        ...RECORDED_PROVIDERS.map(({ value, label }) => ({
          kind: 'text',
          id: `model:${value}`,
          label: `${label} model`,
          value: '',
          placeholder: 'Inherit',
          maxLength: 200,
          error: null
        }))
      ])
      assert.equal(forms.defaults.summary, 'Claude (Anthropic), model Inherit')
      assert.equal(forms.defaults.dirty, false)
      assert.equal(forms.defaults.loaded, true)
      const tiers = forms.tiers
      assert.deepEqual(
        tiers.fields.map((one) => [one.id, one.kind === 'button' ? one.text : one.label, one.kind === 'unreadable' || one.kind === 'button' ? '' : one.value]),
        [
          ['small:provider', 'Small provider', ''],
          ['small:model', 'Small model', ''],
          ['medium:provider', 'Medium provider', ''],
          ['medium:model', 'Medium model', ''],
          ['large:provider', 'Large provider', ''],
          ['large:model', 'Large model', '']
        ]
      )
      const provider = field(tiers, 'small:provider')
      assert.ok(provider.kind === 'select')
      assert.deepEqual(provider.options, [{ value: '', label: 'Default' }, ...RECORDED_PROVIDERS])
      // The recorded tier defaults: claude haiku, sonnet and opus.
      const placeholders = ['small', 'medium', 'large'].map((tier) => {
        const model = field(tiers, `${tier}:model`)
        return model.kind === 'text' ? model.placeholder : ''
      })
      assert.deepEqual(placeholders, ['claude/haiku', 'claude/sonnet', 'claude/opus'])
      assert.equal(tiers.summary, 'Small claude/haiku, medium claude/sonnet, large claude/opus')
      await mounted.worker.deactivate()
    })
  }
})

describe('the providers', () => {
  test('lists at most 50, says how many more there are, and drops and counts a row it cannot read', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    const rows: unknown[] = Array.from({ length: 53 }, (_, index) => ({ id: `p${String(index)}`, displayName: `P ${String(index)}` }))
    rows.push({ displayName: 'no id' })
    stage.archon.answer(PROVIDERS, json({ providers: rows }))
    const { forms } = await mounted.worker.request('forms.read')
    assert.equal(forms.providers.length, 50)
    const assistant = field(forms.defaults, 'assistant')
    assert.ok(assistant.kind === 'select')
    // Besides "Inherit" and the 50 listed, the saved claude, which this Archon does not list.
    assert.equal(assistant.options.filter((option) => option.value.startsWith('p')).length, 50)
    assert.deepEqual(assistant.options.at(-1), { value: 'claude', label: 'claude (not registered)' })
    assert.deepEqual(forms.defaults.notes, [
      '3 more registered providers are not listed. Edit config.yaml to use one of them.',
      '1 provider could not be read and is not listed.'
    ])
    assert.deepEqual(forms.tiers.notes, forms.defaults.notes)
    await mounted.worker.deactivate()
  })
})

describe('editing a group', () => {
  test('shows Codex reasoning effort from its effort levels and web search when Codex is registered', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    stage.archon.answer(PROVIDERS, providersWithCodex('0.14.0'))
    const { forms } = await mounted.worker.request('forms.read')
    // Codex's capabilities never reach the frame.
    assert.deepEqual(forms.providers.at(-1), { id: 'codex', displayName: 'Codex', effortLevels: ['low', 'medium', 'high'] })
    assert.deepEqual(field(forms.defaults, 'codex:effort'), {
      kind: 'select',
      id: 'codex:effort',
      label: 'Codex reasoning effort',
      value: '',
      options: [
        { value: '', label: 'Inherit' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' }
      ],
      error: null
    })
    const search = field(forms.defaults, 'codex:webSearch')
    assert.ok(search.kind === 'select')
    assert.deepEqual(
      search.options.map((option) => option.label),
      ['Inherit', 'disabled', 'cached', 'live']
    )
    await mounted.worker.deactivate()
  })

  test('says "Unsaved changes" while the group holds edits, and Discard returns it to its loaded values', async () => {
    const { mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    const { forms } = await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'my-model' } })
    assert.equal(forms.defaults.summary, 'Unsaved changes')
    assert.equal(forms.defaults.dirty, true)
    assert.equal(forms.tiers.dirty, false)
    const back = await mounted.worker.request('forms.discard', { group: 'defaults' })
    assert.equal(back.forms.defaults.dirty, false)
    assert.equal(back.forms.defaults.summary, 'Claude (Anthropic), model Inherit')
    assert.equal(valueOf(back.forms.defaults, 'model:claude'), '')
    await mounted.worker.deactivate()
  })

  test('a refetch does not refill a group with unsaved edits, and refills one without', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'mine' } })
    // Elsewhere, the Claude model and the small tier were saved.
    stage.archon.answer(CONFIG, recorded('0.12.1', 'config-tiers', 1))
    const { forms } = await mounted.worker.request('forms.read')
    assert.equal(valueOf(forms.defaults, 'model:claude'), 'mine')
    assert.equal(forms.defaults.summary, 'Unsaved changes')
    assert.equal(valueOf(forms.tiers, 'small:model'), 'orchon-recorded-model')
    await mounted.worker.deactivate()
  })

  test('a changed store id clears the unsaved forms', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'mine' } })
    // Another Archon store answers at the same address. A read that times out sends the health
    // check that finds it.
    const health = recorded('0.14.0', 'health')
    if (health.kind !== 'json') throw new Error('The recorded health answer is not JSON.')
    stage.archon.answer(DEFAULT_HEALTH, json({ ...(health.value as object), storeId: '<another-store>' }))
    stage.archon.answer(CONFIG, HANG)
    void mounted.worker.request('forms.read')
    await stage.clock.advance(10_000)
    stage.archon.answer(CONFIG, recorded('0.14.0', 'config'))
    assert.equal(mounted.latest().kind, 'connected')
    const { forms } = await mounted.worker.request('forms.read')
    assert.equal(forms.defaults.dirty, false)
    assert.equal(valueOf(forms.defaults, 'model:claude'), '')
    await mounted.worker.deactivate()
  })

  test('on a change of provider a tier keeps an effort the new provider accepts and clears one it does not', async () => {
    const { mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:provider': 'claude', 'small:effort': 'high' } })
    const kept = await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:provider': 'copilot' } })
    assert.equal(valueOf(kept.forms.tiers, 'small:effort'), 'high')
    const effort = field(kept.forms.tiers, 'small:effort')
    assert.ok(effort.kind === 'select' && effort.options[0]?.label === 'None')
    // OpenCode takes no effort: the select is hidden and the effort cleared.
    const cleared = await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:provider': 'opencode' } })
    assert.equal(cleared.forms.tiers.fields.some((one) => one.id === 'small:effort'), false)
    const back = await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:provider': 'claude' } })
    assert.equal(valueOf(back.forms.tiers, 'small:effort'), '')
    await mounted.worker.deactivate()
  })

  test('choosing "Default" empties the row', async () => {
    const { mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', {
      group: 'tiers',
      edits: { 'large:provider': 'claude', 'large:model': 'x', 'large:effort': 'low' }
    })
    const { forms } = await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'large:provider': '' } })
    assert.equal(valueOf(forms.tiers, 'large:model'), '')
    assert.equal(forms.tiers.fields.some((one) => one.id === 'large:effort'), false)
    assert.equal(forms.tiers.dirty, false)
    await mounted.worker.deactivate()
  })

  test('refuses an edit to a field the group does not draw, or a choice a select does not offer', async () => {
    const { mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:codex': 'x' } }), /no field model:codex/)
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'defaults', edits: { assistant: 'codex' } }), /not a choice/)
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'notifications', edits: { a: 'b' } } as never), /group must be one of/)
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:model': 5 } } as never), /must be text/)
    await assert.rejects(mounted.worker.request('forms.read', { group: 'tiers' } as never), /takes no input/)
    await mounted.worker.deactivate()
  })
})

/**
 * Scripts `GET /api/config` to answer `before` until `count` `PATCH` requests have been sent, and
 * `after` from then on, as Archon does once a save lands.
 */
function configAcrossSave(stage: Scene, before: Scripted, after: Scripted, count = 1): void {
  stage.archon.answer(CONFIG, () => (patches(stage).length >= count ? after : before))
}

/** Sends a save and lets everything it set off run. The newest view, as a frame keeps it. */
async function saved(mounted: MountedScene, group: 'defaults' | 'tiers'): Promise<FormsView> {
  const { forms } = await mounted.worker.request('forms.save', { group })
  await settle()
  return newest(mounted, forms)
}

const patches = (stage: Scene): ScriptedCall[] => stage.archon.calls.filter((call) => call.method === 'PATCH')

describe('saving a group', () => {
  for (const release of RELEASES) {
    test(`Defaults sends only the changed model, replaying the recorded PATCH of ${release}`, async () => {
      const { stage, mounted } = await connectedTo(release)
      await mounted.worker.request('forms.read')
      configAcrossSave(stage, recorded(release, 'config'), recorded(release, 'config-assistants', 1))
      stage.archon.answer(ASSISTANTS, recorded(release, 'config-assistants', 0))
      await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': '  orchon-recorded-model ' } })
      const mark = stage.archon.calls.length
      const forms = await saved(mounted, 'defaults')
      assert.deepEqual(callsSince(stage, mark).slice(0, 2), ['GET /api/config', 'PATCH /api/config/assistants'])
      assert.deepEqual(bodyOf(patches(stage)[0]), recordedRequest(release, 'config-assistants', 0))
      assert.deepEqual(forms.defaults.notice, { tone: 'success', text: 'Saved.' })
      assert.equal(forms.defaults.dirty, false)
      assert.equal(valueOf(forms.defaults, 'model:claude'), 'orchon-recorded-model')
      assert.equal(forms.defaults.summary, 'Claude (Anthropic), model orchon-recorded-model')
      // Config and providers load again after a save.
      assert.deepEqual(callsSince(stage, mark).slice(2).sort(), ['GET /api/config', 'GET /api/providers'])
      await mounted.worker.deactivate()
    })

    test(`Model tiers sets a tier and removes it with null, replaying the recorded PATCHes of ${release}`, async () => {
      const { stage, mounted } = await connectedTo(release)
      await mounted.worker.request('forms.read')
      configAcrossSave(stage, recorded(release, 'config'), recorded(release, 'config-tiers', 1))
      stage.archon.answer(TIERS, recorded(release, 'config-tiers', 0))
      await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:provider': 'claude', 'small:model': 'orchon-recorded-model' } })
      const set = await saved(mounted, 'tiers')
      assert.deepEqual(bodyOf(patches(stage)[0]), recordedRequest(release, 'config-tiers', 0))
      assert.deepEqual(set.tiers.notice, { tone: 'success', text: 'Saved.' })
      assert.equal(set.tiers.summary, 'Small claude/orchon-recorded-model, medium claude/sonnet, large claude/opus')

      // Choosing "Default" removes the tier on Save.
      configAcrossSave(stage, recorded(release, 'config-tiers', 1), recorded(release, 'config-tiers', 3), 2)
      stage.archon.answer(TIERS, recorded(release, 'config-tiers', 2))
      await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:provider': '' } })
      const removed = await saved(mounted, 'tiers')
      assert.deepEqual(bodyOf(patches(stage)[1]), recordedRequest(release, 'config-tiers', 2))
      assert.deepEqual(bodyOf(patches(stage)[1]), { tiers: { small: null } })
      assert.equal(valueOf(removed.tiers, 'small:provider'), '')
      assert.equal(removed.tiers.dirty, false)
      await mounted.worker.deactivate()
    })

    test(`a 400 shows Archon's message under the group and refills nothing, on ${release}`, async () => {
      const { stage, mounted } = await connectedTo(release)
      await mounted.worker.request('forms.read')
      stage.archon.answer(TIERS, recorded(release, 'config-tiers', 5))
      await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'medium:provider': 'copilot', 'medium:model': 'm' } })
      const forms = await saved(mounted, 'tiers')
      assert.deepEqual(forms.tiers.notice, {
        tone: 'danger',
        text: "tier 'small': Unknown provider: 'orchon-recorder-no-such-provider'. Available: opencode, copilot, claude"
      })
      assert.equal(forms.tiers.dirty, true)
      assert.equal(valueOf(forms.tiers, 'medium:model'), 'm')
      assert.equal(patches(stage).length, 1)
      await mounted.worker.deactivate()
    })
  }

  test('sends nothing and says so on the field when a saved value is emptied', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    stage.archon.answer(CONFIG, recorded('0.12.1', 'config-assistants', 1))
    await mounted.worker.request('forms.read')
    const { forms: edited } = await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': ' ', assistant: '' } })
    const message = 'A saved value can be replaced here but not removed. Edit config.yaml to remove it.'
    assert.equal(errorOf(edited.defaults, 'model:claude'), message)
    assert.equal(errorOf(edited.defaults, 'assistant'), message)
    const mark = stage.archon.calls.length
    const forms = await saved(mounted, 'defaults')
    assert.deepEqual(callsSince(stage, mark), [])
    assert.equal(forms.defaults.dirty, true)
    await mounted.worker.deactivate()
  })

  test('the checks before sending: a provider with no model, a model too long, a model with no provider', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    const { forms } = await mounted.worker.request('forms.edit', {
      group: 'tiers',
      edits: { 'small:provider': 'claude', 'medium:provider': 'copilot', 'medium:model': 'x'.repeat(201), 'large:model': 'orphan' }
    })
    assert.equal(errorOf(forms.tiers, 'small:model'), 'Enter a model')
    assert.equal(errorOf(forms.tiers, 'medium:model'), 'A model is at most 200 characters.')
    assert.equal(errorOf(forms.tiers, 'large:provider'), 'Choose a provider')
    const mark = stage.archon.calls.length
    await saved(mounted, 'tiers')
    assert.deepEqual(callsSince(stage, mark), [])
    // Trimmed, a model of 200 characters passes.
    const fine = await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'medium:model': ` ${'x'.repeat(200)} ` } })
    assert.equal(errorOf(fine.forms.tiers, 'medium:model'), null)
    await mounted.worker.deactivate()
  })

  test('a saved provider Archon does not list is shown by its id and is not sent while untouched', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    stage.archon.answer(CONFIG, configWith('0.12.1', { tiers: { small: { provider: 'gone', model: 'old' } } }))
    await mounted.worker.request('forms.read')
    const { forms } = await mounted.worker.request('forms.read')
    const provider = field(forms.tiers, 'small:provider')
    assert.ok(provider.kind === 'select')
    assert.deepEqual(provider.options.at(-1), { value: 'gone', label: 'gone (not registered)' })
    assert.equal(provider.value, 'gone')
    stage.archon.answer(TIERS, recorded('0.12.1', 'config-tiers', 0))
    await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'medium:provider': 'claude', 'medium:model': 'm' } })
    await saved(mounted, 'tiers')
    assert.deepEqual(bodyOf(patches(stage)[0]), { tiers: { medium: { provider: 'claude', model: 'm' } } })
    await mounted.worker.deactivate()
  })

  test('a changed row with an unregistered provider, or an effort its provider does not accept, fails its check', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    stage.archon.answer(
      CONFIG,
      configWith('0.12.1', {
        tiers: { small: { provider: 'gone', model: 'old' }, medium: { provider: 'claude', model: 'm', effort: 'turbo' } }
      })
    )
    await mounted.worker.request('forms.read')
    const { forms } = await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:model': 'new', 'medium:model': 'n' } })
    assert.equal(errorOf(forms.tiers, 'small:provider'), 'This provider is not registered with Archon.')
    assert.equal(errorOf(forms.tiers, 'medium:effort'), 'Claude (Anthropic) does not accept this effort.')
    const mark = stage.archon.calls.length
    await saved(mounted, 'tiers')
    assert.deepEqual(callsSince(stage, mark), [])
    await mounted.worker.deactivate()
  })

  test('a preset that fails validation is shown as "Unreadable" and is not sent', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    stage.archon.answer(CONFIG, configWith('0.12.1', { tiers: { small: { provider: 'claude' } } }))
    const { forms } = await mounted.worker.request('forms.read')
    assert.deepEqual(field(forms.tiers, 'small:provider'), { kind: 'unreadable', id: 'small:provider', label: 'Small tier' })
    assert.equal(forms.tiers.fields.some((one) => one.id === 'small:model'), false)
    assert.equal(forms.tiers.summary, 'Small Unreadable, medium claude/sonnet, large claude/opus')
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'small:model': 'x' } }), /no field/)
    stage.archon.answer(TIERS, recorded('0.12.1', 'config-tiers', 0))
    await mounted.worker.request('forms.edit', { group: 'tiers', edits: { 'large:provider': 'claude', 'large:model': 'l' } })
    await saved(mounted, 'tiers')
    assert.deepEqual(bodyOf(patches(stage)[0]), { tiers: { large: { provider: 'claude', model: 'l' } } })
    await mounted.worker.deactivate()
  })

  test('Codex reasoning effort and web search are sent on the codex entry', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    stage.archon.answer(PROVIDERS, providersWithCodex('0.14.0'))
    await mounted.worker.request('forms.read')
    stage.archon.answer(ASSISTANTS, recorded('0.14.0', 'config-assistants', 0))
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'codex:effort': 'high', 'codex:webSearch': 'live', assistant: 'copilot' } })
    await saved(mounted, 'defaults')
    assert.deepEqual(bodyOf(patches(stage)[0]), {
      assistant: 'copilot',
      assistants: { codex: { modelReasoningEffort: 'high', webSearchMode: 'live' } }
    })
    await mounted.worker.deactivate()
  })

  test('a save that times out is not retried, and a read says it landed', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    configAcrossSave(stage, recorded('0.12.1', 'config'), recorded('0.12.1', 'config-assistants', 1))
    stage.archon.answer(ASSISTANTS, HANG)
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'orchon-recorded-model' } })
    const { forms: out } = await mounted.worker.request('forms.save', { group: 'defaults' })
    assert.equal(out.defaults.saving, true)
    await stage.clock.advance(30_000)
    const forms = newest(mounted, out)
    assert.equal(patches(stage).length, 1)
    assert.deepEqual(forms.defaults.notice, { tone: 'success', text: 'Archon did not answer within 30 seconds. The change was saved.' })
    assert.equal(forms.defaults.dirty, false)
    assert.equal(forms.defaults.saving, false)
    await mounted.worker.deactivate()
  })

  test('a save that times out and did not land keeps the edits and says so', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    stage.archon.answer(ASSISTANTS, HANG)
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'mine' } })
    const { forms: out } = await mounted.worker.request('forms.save', { group: 'defaults' })
    await stage.clock.advance(30_000)
    const forms = newest(mounted, out)
    assert.equal(patches(stage).length, 1)
    assert.deepEqual(forms.defaults.notice, {
      tone: 'danger',
      text: 'Archon did not answer within 30 seconds. The change was not saved. Your edits are kept.'
    })
    assert.equal(valueOf(forms.defaults, 'model:claude'), 'mine')
    await mounted.worker.deactivate()
  })

  test('refuses edits while a save is out, and says changes are off when not connected', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    stage.archon.answer(ASSISTANTS, HANG)
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'mine' } })
    await mounted.worker.request('forms.save', { group: 'defaults' })
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'x' } }), /being saved/)
    await mounted.worker.deactivate()
  })
})

describe('the outside-change check', () => {
  /** A group loaded from the recorded config, with the Claude model edited, then saved elsewhere. */
  async function changedElsewhere(): Promise<{ stage: Scene; mounted: MountedScene; forms: FormsView }> {
    const { stage, mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:claude': 'mine', assistant: 'copilot' } })
    // The recorded config after the Claude model was saved, as another editor would leave it.
    stage.archon.answer(CONFIG, recorded('0.12.1', 'config-assistants', 1))
    stage.archon.answer(ASSISTANTS, recorded('0.12.1', 'config-assistants', 0))
    const forms = await saved(mounted, 'defaults')
    return { stage, mounted, forms }
  }

  test('re-reads the config and writes nothing when a changed key differs from its loaded value', async () => {
    const { stage, mounted, forms } = await changedElsewhere()
    assert.deepEqual(forms.defaults.conflict, { keys: ['claude model'] })
    assert.equal(patches(stage).length, 0)
    assert.equal(stage.archon.calls.at(-1)?.url, CONFIG)
    assert.equal(valueOf(forms.defaults, 'model:claude'), 'mine')
    await mounted.worker.deactivate()
  })

  test('keep editing leaves the edits and sends nothing', async () => {
    const { stage, mounted } = await changedElsewhere()
    const { forms } = await mounted.worker.request('forms.resolve', { group: 'defaults', choice: 'keep' })
    assert.equal(forms.defaults.conflict, null)
    assert.equal(valueOf(forms.defaults, 'model:claude'), 'mine')
    assert.equal(forms.defaults.dirty, true)
    assert.equal(patches(stage).length, 0)
    await mounted.worker.deactivate()
  })

  test('load takes the saved values and loses the edits to the keys changed elsewhere only', async () => {
    const { stage, mounted } = await changedElsewhere()
    const { forms } = await mounted.worker.request('forms.resolve', { group: 'defaults', choice: 'load' })
    assert.equal(forms.defaults.conflict, null)
    assert.equal(valueOf(forms.defaults, 'model:claude'), 'orchon-recorded-model')
    assert.equal(valueOf(forms.defaults, 'assistant'), 'copilot')
    assert.equal(patches(stage).length, 0)
    // The next save compares with the values just loaded, and goes through.
    const after = await saved(mounted, 'defaults')
    assert.deepEqual(bodyOf(patches(stage)[0]), { assistant: 'copilot' })
    assert.equal(after.defaults.conflict, null)
    await mounted.worker.deactivate()
  })

  test('overwrite sends the changed keys over the outside change', async () => {
    const { stage, mounted } = await changedElsewhere()
    const { forms: out } = await mounted.worker.request('forms.resolve', { group: 'defaults', choice: 'overwrite' })
    await settle()
    const forms = newest(mounted, out)
    assert.deepEqual(bodyOf(patches(stage)[0]), { assistant: 'copilot', assistants: { claude: { model: 'mine' } } })
    assert.equal(forms.defaults.conflict, null)
    await mounted.worker.deactivate()
  })

  test('an outside change to a key the person did not change does not stop the save', async () => {
    const { stage, mounted } = await connectedTo('0.12.1')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'defaults', edits: { 'model:copilot': 'c' } })
    stage.archon.answer(CONFIG, recorded('0.12.1', 'config-assistants', 1))
    stage.archon.answer(ASSISTANTS, recorded('0.12.1', 'config-assistants', 0))
    const forms = await saved(mounted, 'defaults')
    assert.equal(forms.defaults.conflict, null)
    assert.deepEqual(bodyOf(patches(stage)[0]), { assistants: { copilot: { model: 'c' } } })
    await mounted.worker.deactivate()
  })
})
