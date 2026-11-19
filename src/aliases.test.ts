// The worker's request protocol seam: the worker mounted on a scripted Archon and clock. These
// tests cover the Aliases group of the Settings section: what the config is read into, adding,
// changing and removing an alias, the name checks, and that an alias the form does not show is
// never touched. The `PATCH /api/config/aliases` exchanges are replayed from the recorded fixtures.
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
const ALIASES = `${DEFAULT}/api/config/aliases`

/** A worker connected at the default address to a release, answering its recorded fixtures. */
async function connectedTo(release: Release, config: Scripted = recorded(release, 'config')): Promise<{ stage: Scene; mounted: MountedScene }> {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, recorded(release, 'health'))
  stage.archon.answer(DEFAULT_OPENAPI, recorded(release, 'openapi'))
  stage.archon.answer(CONFIG, config)
  stage.archon.answer(PROVIDERS, recorded(release, 'providers'))
  const mounted = await stage.mount()
  assert.equal(mounted.latest().kind, 'connected')
  return { stage, mounted }
}

/** A config answer: the recorded one of a release with its `config` fields replaced. */
function configWith(release: Release, fields: Record<string, unknown>): Scripted {
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

const valueOf = (form: FormView, id: string): string | null => {
  const found = field(form, id)
  return found.kind === 'unreadable' || found.kind === 'button' ? null : found.value
}

const errorOf = (form: FormView, id: string): string | null => {
  const found = field(form, id)
  return found.kind === 'select' || found.kind === 'text' ? found.error : null
}

const formsPosts = (mounted: MountedScene): FormsView[] =>
  mounted.worker.posts.filter((post) => post.event === 'forms.changed').map((post) => post.payload as FormsView)

function newest(mounted: MountedScene, answered: FormsView): FormsView {
  return [answered, ...formsPosts(mounted)].reduce((kept, next) => (next.since > kept.since ? next : kept))
}

const patches = (stage: Scene): ScriptedCall[] => stage.archon.calls.filter((call) => call.method === 'PATCH')
const bodyOf = (call: ScriptedCall | undefined): unknown => (call?.body === undefined ? undefined : JSON.parse(call.body))

/** Sends a save of Aliases and lets everything it set off run. The newest view, as a frame keeps it. */
async function saved(mounted: MountedScene): Promise<FormsView> {
  const { forms } = await mounted.worker.request('forms.save', { group: 'aliases' })
  await settle()
  return newest(mounted, forms)
}

/** `GET /api/config` answers `before` until `count` `PATCH` requests have been sent, and `after` from then on. */
function configAcrossSave(stage: Scene, before: Scripted, after: Scripted, count = 1): void {
  stage.archon.answer(CONFIG, () => (patches(stage).length >= count ? after : before))
}

/** The ids, kinds and values of a group's fields, as a compact list. */
const drawn = (form: FormView): string[][] =>
  form.fields.map((one) => [one.id, one.kind, one.kind === 'button' ? one.text : one.kind === 'unreadable' ? one.label : one.value])

describe('reading Aliases', () => {
  for (const release of RELEASES) {
    test(`reads the recorded alias of ${release} into a row with a read-only name`, async () => {
      // The recorded config after the alias was added.
      const { mounted } = await connectedTo(release, recorded(release, 'config-aliases', 1))
      const { forms } = await mounted.worker.request('forms.read')
      const aliases = forms.aliases
      assert.equal(aliases.title, 'Aliases')
      assert.equal(aliases.loaded, true)
      assert.equal(aliases.summary, '1 alias')
      assert.equal(aliases.dirty, false)
      assert.deepEqual(drawn(aliases), [
        ['saved:@orchon-recorded:name', 'fixed', '@orchon-recorded'],
        ['saved:@orchon-recorded:provider', 'select', 'claude'],
        ['saved:@orchon-recorded:model', 'text', 'orchon-recorded-model'],
        ['saved:@orchon-recorded:effort', 'select', ''],
        ['saved:@orchon-recorded:remove', 'button', 'Remove @orchon-recorded'],
        ['add', 'button', 'Add alias']
      ])
      await mounted.worker.deactivate()
    })
  }

  test('a config with no aliases says so in the summary', async () => {
    const { mounted } = await connectedTo('0.14.0')
    const { forms } = await mounted.worker.request('forms.read')
    assert.equal(forms.aliases.summary, 'No aliases')
    assert.deepEqual(drawn(forms.aliases), [['add', 'button', 'Add alias']])
    await mounted.worker.deactivate()
  })
})

describe('saving Aliases', () => {
  for (const release of RELEASES) {
    test(`adds an alias and removes it with null, replaying the recorded PATCHes of ${release}`, async () => {
      const { stage, mounted } = await connectedTo(release)
      await mounted.worker.request('forms.read')
      configAcrossSave(stage, recorded(release, 'config'), recorded(release, 'config-aliases', 1))
      stage.archon.answer(ALIASES, recorded(release, 'config-aliases', 0))
      const { forms: added } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
      assert.deepEqual(drawn(added.aliases), [
        ['new:0:name', 'text', ''],
        ['new:0:provider', 'select', ''],
        ['new:0:model', 'text', ''],
        ['new:0:remove', 'button', 'Remove new alias 1'],
        ['add', 'button', 'Add alias']
      ])
      // An empty row is nothing to save.
      assert.equal(added.aliases.dirty, false)
      await mounted.worker.request('forms.edit', {
        group: 'aliases',
        edits: { 'new:0:name': ' @orchon-recorded ', 'new:0:provider': 'claude', 'new:0:model': 'orchon-recorded-model' }
      })
      const set = await saved(mounted)
      assert.deepEqual(bodyOf(patches(stage)[0]), recordedRequest(release, 'config-aliases', 0))
      assert.deepEqual(set.aliases.notice, { tone: 'success', text: 'Saved.' })
      assert.equal(set.aliases.dirty, false)
      assert.equal(set.aliases.summary, '1 alias')
      assert.equal(valueOf(set.aliases, 'saved:@orchon-recorded:name'), '@orchon-recorded')

      // Remove keeps the row, struck through with Undo, until Save sends null.
      configAcrossSave(stage, recorded(release, 'config-aliases', 1), recorded(release, 'config-aliases', 3), 2)
      stage.archon.answer(ALIASES, recorded(release, 'config-aliases', 2))
      const { forms: removing } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@orchon-recorded:remove': 'remove' } })
      assert.deepEqual(drawn(removing.aliases), [
        ['saved:@orchon-recorded:name', 'struck', '@orchon-recorded'],
        ['saved:@orchon-recorded:remove', 'button', 'Undo removing @orchon-recorded'],
        ['add', 'button', 'Add alias']
      ])
      assert.equal(removing.aliases.dirty, true)
      const removed = await saved(mounted)
      assert.deepEqual(bodyOf(patches(stage)[1]), recordedRequest(release, 'config-aliases', 2))
      assert.deepEqual(bodyOf(patches(stage)[1]), { aliases: { '@orchon-recorded': null } })
      assert.equal(removed.aliases.summary, 'No aliases')
      assert.deepEqual(drawn(removed.aliases), [['add', 'button', 'Add alias']])
      await mounted.worker.deactivate()
    })
  }
})

/** `count` aliases `@a000`, `@a001`… in name order, each on Claude. */
function manyAliases(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`@a${String(index).padStart(3, '0')}`, { provider: 'claude', model: `m${String(index)}` }]))
}

/** The config Archon answers a patch with, scripted: the recordings hold no change to an existing alias. */
const afterPatch = (aliases: Record<string, unknown>): Scripted => configWith('0.14.0', { aliases })

const disabledOf = (form: FormView, id: string): boolean | null => {
  const found = field(form, id)
  return found.kind === 'button' ? found.disabled : null
}

describe('changing and removing', () => {
  test('a changed model sends the whole preset of that alias only', async () => {
    const before = { '@fast': { provider: 'claude', model: 'haiku' }, '@slow': { provider: 'claude', model: 'opus', effort: 'high' } }
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: before }))
    await mounted.worker.request('forms.read')
    const after = { ...before, '@slow': { provider: 'claude', model: 'opus-2', effort: 'high' } }
    configAcrossSave(stage, configWith('0.14.0', { aliases: before }), afterPatch(after))
    stage.archon.answer(ALIASES, afterPatch(after))
    const { forms } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@slow:model': 'opus-2' } })
    assert.equal(forms.aliases.summary, 'Unsaved changes')
    const done = await saved(mounted)
    assert.deepEqual(bodyOf(patches(stage)[0]), { aliases: { '@slow': { provider: 'claude', model: 'opus-2', effort: 'high' } } })
    assert.deepEqual(done.aliases.notice, { tone: 'success', text: 'Saved.' })
    assert.equal(valueOf(done.aliases, 'saved:@slow:model'), 'opus-2')
    await mounted.worker.deactivate()
  })

  test('a saved name cannot be edited, and Undo and Discard bring a removed alias back', async () => {
    const before = { '@fast': { provider: 'claude', model: 'haiku' } }
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: before }))
    await mounted.worker.request('forms.read')
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@fast:name': '@quick' } }), /no field/)
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@fast:model': 'other' } })
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@fast:remove': 'remove' } })
    // The struck row offers Undo only: Remove again is refused.
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@fast:remove': 'remove' } }), /not available/)
    const { forms: undone } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@fast:remove': 'undo' } })
    assert.equal(valueOf(undone.aliases, 'saved:@fast:model'), 'haiku')
    assert.equal(undone.aliases.dirty, false)
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@fast:remove': 'remove', add: 'add' } })
    const { forms: discarded } = await mounted.worker.request('forms.discard', { group: 'aliases' })
    assert.deepEqual(
      drawn(discarded.aliases).map(([id]) => id),
      ['saved:@fast:name', 'saved:@fast:provider', 'saved:@fast:model', 'saved:@fast:effort', 'saved:@fast:remove', 'add']
    )
    assert.equal(patches(stage).length, 0)
    await mounted.worker.deactivate()
  })

  test('a new row is removed at once, and a typed name names its Remove button', async () => {
    const { mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    const { forms } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'new:0:name': '@mine ' } })
    assert.deepEqual(field(forms.aliases, 'new:0:remove'), { kind: 'button', id: 'new:0:remove', text: 'Remove @mine', value: 'remove', disabled: false })
    const { forms: gone } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'new:0:remove': 'remove' } })
    assert.deepEqual(drawn(gone.aliases), [['add', 'button', 'Add alias']])
    assert.equal(gone.aliases.dirty, false)
    await mounted.worker.deactivate()
  })
})

describe('the first 100', () => {
  test('shows the first 100 by name, says how many more exist, and never touches one it does not show', async () => {
    const many = manyAliases(102)
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: many }))
    const { forms } = await mounted.worker.request('forms.read')
    const names = forms.aliases.fields.flatMap((one) => (one.kind === 'fixed' ? [one.value] : []))
    assert.equal(names.length, 100)
    assert.equal(names[0], '@a000')
    assert.equal(names.at(-1), '@a099')
    assert.equal(forms.aliases.summary, '102 aliases')
    assert.ok(forms.aliases.notes.includes('2 more aliases are not shown. Edit them in config.yaml.'))
    // Saved and unsaved together have reached 100: Add alias is off, and refused.
    assert.equal(disabledOf(forms.aliases, 'add'), true)
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } }), /not available/)
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@a101:model': 'x' } }), /no field/)

    // Elsewhere, an alias the form does not show changed: a save of shown ones goes through and leaves it alone.
    const elsewhere = { ...many, '@a101': { provider: 'claude', model: 'changed' } }
    stage.archon.answer(CONFIG, configWith('0.14.0', { aliases: elsewhere }))
    stage.archon.answer(ALIASES, afterPatch(elsewhere))
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@a000:remove': 'remove', 'saved:@a001:model': 'n1' } })
    const done = await saved(mounted)
    assert.equal(done.aliases.conflict, null)
    assert.deepEqual(bodyOf(patches(stage)[0]), { aliases: { '@a000': null, '@a001': { provider: 'claude', model: 'n1' } } })
    await mounted.worker.deactivate()
  })

  test('Add alias counts saved and new rows together, and a name saved elsewhere past the first 100 stops the save', async () => {
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: manyAliases(99) }))
    await mounted.worker.request('forms.read')
    const { forms: one } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    assert.equal(disabledOf(one.aliases, 'add'), true)
    // Elsewhere, two aliases were added: one of them is past the first 100.
    stage.archon.answer(CONFIG, configWith('0.14.0', { aliases: manyAliases(101) }))
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'new:0:name': '@a100', 'new:0:provider': 'claude', 'new:0:model': 'x' } })
    const forms = await saved(mounted)
    assert.deepEqual(forms.aliases.conflict, { keys: ['alias @a100'] })
    assert.equal(patches(stage).length, 0)
    // Loading the saved values drops the new row, whose name was taken elsewhere.
    const { forms: loaded } = await mounted.worker.request('forms.resolve', { group: 'aliases', choice: 'load' })
    assert.equal(loaded.aliases.dirty, false)
    assert.equal(loaded.aliases.summary, '101 aliases')
    assert.ok(loaded.aliases.notes.includes('1 more alias is not shown. Edit it in config.yaml.'))
    assert.equal(loaded.aliases.fields.some((one) => one.id.startsWith('new:')), false)
    assert.equal(disabledOf(loaded.aliases, 'add'), true)
    assert.equal(patches(stage).length, 0)
    await mounted.worker.deactivate()
  })
})

describe('the checks before sending', () => {
  test('a name starts with @, is not a tier name, appears once and is at most 64 characters once trimmed', async () => {
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: { '@fast': { provider: 'claude', model: 'haiku' } } }))
    await mounted.worker.request('forms.read')
    for (let index = 0; index < 7; index += 1) await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    const names = ['', 'fast', 'small', `@${'x'.repeat(64)}`, '@fast', '@twice', ' @twice ']
    const edits = Object.fromEntries(
      names.flatMap((name, index) => [
        [`new:${String(index)}:name`, name],
        [`new:${String(index)}:provider`, 'claude'],
        [`new:${String(index)}:model`, 'm']
      ])
    )
    const { forms } = await mounted.worker.request('forms.edit', { group: 'aliases', edits })
    assert.deepEqual(
      names.map((_, index) => errorOf(forms.aliases, `new:${String(index)}:name`)),
      [
        'Enter a name',
        'A name starts with @.',
        'small, medium and large are tier names. Choose another name.',
        'A name is at most 64 characters.',
        'Another alias has this name.',
        'Another alias has this name.',
        'Another alias has this name.'
      ]
    )
    // Trimmed, a name of 64 characters passes.
    const { forms: fine } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'new:3:name': ` @${'x'.repeat(63)} ` } })
    assert.equal(errorOf(fine.aliases, 'new:3:name'), null)
    await saved(mounted)
    assert.equal(patches(stage).length, 0)
    await mounted.worker.deactivate()
  })

  test('the preset checks: a provider chosen and registered, and a model entered', async () => {
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: { '@gone': { provider: 'gone', model: 'm' } } }))
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    const { forms } = await mounted.worker.request('forms.edit', {
      group: 'aliases',
      edits: { 'new:0:name': '@a', 'new:1:name': '@b', 'new:1:provider': 'claude', 'saved:@gone:model': 'n' }
    })
    assert.equal(errorOf(forms.aliases, 'new:0:provider'), 'Choose a provider')
    assert.equal(errorOf(forms.aliases, 'new:1:model'), 'Enter a model')
    assert.equal(errorOf(forms.aliases, 'saved:@gone:provider'), 'This provider is not registered with Archon.')
    await saved(mounted)
    assert.equal(patches(stage).length, 0)
    await mounted.worker.deactivate()
  })

  test('an alias that fails validation is shown as "Unreadable" and is not sent', async () => {
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: { '@bad': { provider: 'claude' } } }))
    const { forms } = await mounted.worker.request('forms.read')
    assert.deepEqual(drawn(forms.aliases)[0], ['saved:@bad:provider', 'unreadable', 'Alias @bad'])
    assert.equal(forms.aliases.summary, '1 alias')
    await assert.rejects(mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@bad:model': 'x' } }), /no field/)
    stage.archon.answer(ALIASES, afterPatch({}))
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'new:0:name': '@ok', 'new:0:provider': 'claude', 'new:0:model': 'm' } })
    await saved(mounted)
    assert.deepEqual(bodyOf(patches(stage)[0]), { aliases: { '@ok': { provider: 'claude', model: 'm' } } })
    await mounted.worker.deactivate()
  })

  test('an Unreadable alias has a Remove button naming it, with Undo, and Save sends null for it', async () => {
    const { stage, mounted } = await connectedTo('0.14.0', configWith('0.14.0', { aliases: { '@bad': { provider: 'claude' } } }))
    const { forms: read } = await mounted.worker.request('forms.read')
    assert.deepEqual(drawn(read.aliases).slice(0, 2), [
      ['saved:@bad:provider', 'unreadable', 'Alias @bad'],
      ['saved:@bad:remove', 'button', 'Remove @bad']
    ])
    const { forms: removed } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@bad:remove': 'remove' } })
    assert.deepEqual(drawn(removed.aliases).slice(0, 2), [
      ['saved:@bad:name', 'struck', '@bad'],
      ['saved:@bad:remove', 'button', 'Undo removing @bad']
    ])
    const { forms: undone } = await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@bad:remove': 'undo' } })
    assert.deepEqual(drawn(undone.aliases), drawn(read.aliases))
    await saved(mounted)
    assert.equal(patches(stage).length, 0)
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'saved:@bad:remove': 'remove' } })
    stage.archon.answer(ALIASES, afterPatch({}))
    await saved(mounted)
    assert.deepEqual(bodyOf(patches(stage)[0]), { aliases: { '@bad': null } })
    await mounted.worker.deactivate()
  })
})

describe('the outside-change check and Archon refusing', () => {
  test('a new alias whose name was saved elsewhere since loading stops the save, and overwrite sends it', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('forms.read')
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    await mounted.worker.request('forms.edit', {
      group: 'aliases',
      edits: { 'new:0:name': '@orchon-recorded', 'new:0:provider': 'copilot', 'new:0:model': 'mine' }
    })
    // The recorded config after another editor added the same alias.
    stage.archon.answer(CONFIG, recorded('0.14.0', 'config-aliases', 1))
    const forms = await saved(mounted)
    assert.deepEqual(forms.aliases.conflict, { keys: ['alias @orchon-recorded'] })
    assert.equal(patches(stage).length, 0)
    stage.archon.answer(ALIASES, recorded('0.14.0', 'config-aliases', 0))
    await mounted.worker.request('forms.resolve', { group: 'aliases', choice: 'overwrite' })
    await settle()
    assert.deepEqual(bodyOf(patches(stage)[0]), { aliases: { '@orchon-recorded': { provider: 'copilot', model: 'mine' } } })
    await mounted.worker.deactivate()
  })

  for (const release of RELEASES) {
    test(`a 400 shows Archon's recorded message under the group and keeps the edits, on ${release}`, async () => {
      const { stage, mounted } = await connectedTo(release)
      await mounted.worker.request('forms.read')
      stage.archon.answer(ALIASES, recorded(release, 'config-aliases', 5))
      await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
      await mounted.worker.request('forms.edit', { group: 'aliases', edits: { 'new:0:name': '@x', 'new:0:provider': 'claude', 'new:0:model': 'm' } })
      const forms = await saved(mounted)
      assert.deepEqual(forms.aliases.notice, { tone: 'danger', text: "Alias name 'no-at-sign' must start with '@' (e.g. '@no-at-sign')." })
      assert.equal(forms.aliases.dirty, true)
      assert.equal(valueOf(forms.aliases, 'new:0:name'), '@x')
      await mounted.worker.deactivate()
    })
  }

  test('a new alias whose save timed out is found by the read after it', async () => {
    const { stage, mounted } = await connectedTo('0.14.0')
    await mounted.worker.request('forms.read')
    configAcrossSave(stage, recorded('0.14.0', 'config'), recorded('0.14.0', 'config-aliases', 1))
    stage.archon.answer(ALIASES, HANG)
    await mounted.worker.request('forms.edit', { group: 'aliases', edits: { add: 'add' } })
    await mounted.worker.request('forms.edit', {
      group: 'aliases',
      edits: { 'new:0:name': '@orchon-recorded', 'new:0:provider': 'claude', 'new:0:model': 'orchon-recorded-model' }
    })
    const { forms: out } = await mounted.worker.request('forms.save', { group: 'aliases' })
    await stage.clock.advance(30_000)
    const forms = newest(mounted, out)
    assert.equal(patches(stage).length, 1)
    assert.deepEqual(forms.aliases.notice, { tone: 'success', text: 'Archon did not answer within 30 seconds. The change was saved.' })
    assert.equal(forms.aliases.dirty, false)
    await mounted.worker.deactivate()
  })
})
