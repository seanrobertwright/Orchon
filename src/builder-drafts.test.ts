// The worker's request protocol seam for builder drafts (#61): the worker mounted on a scripted
// Archon and a stand-in Orca host whose plugin storage the test reads. These tests cover what the
// worker keeps of a builder tab's unsaved edits, when it writes them to plugin storage, what a
// tab's read is given back, the cap, and what removes a draft: a save and a discard.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, scene, type MountedScene, type Scene } from '../scripts/scripted-archon.ts'
import type { BuilderAnswer, BuilderDraftWriteAnswer, BuilderSaveAnswer } from '../editors/builder/builder-view'

const CODEBASES = `${DEFAULT}/api/codebases`
const VALIDATE = `${DEFAULT}/api/workflows/validate`
const WEB = 'aaaa0000bbbb1111cccc2222dddd3333'
const WEB_FOLDER = 'C:/Projects/web'
const webProject = { id: WEB, name: 'web', default_cwd: WEB_FOLDER, repository_url: null }
const readUrl = (name: string, cwd: string | null = WEB_FOLDER): string =>
  `${DEFAULT}/api/workflows/${encodeURIComponent(name)}${cwd === null ? '' : `?cwd=${encodeURIComponent(cwd)}`}`
const putUrl = (name: string): string => `${DEFAULT}/api/workflows/${encodeURIComponent(name)}?source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`

const orca: MockHostOptions = {
  results: {
    'workspace.readContext': { workspaceId: 'ws-web', branch: 'main', displayName: 'web', terminals: [] },
    'workspace.list': { workspaces: [], truncated: false }
  }
}

const OPENED = { name: 'plan', description: 'Plans', nodes: [{ id: 'a', prompt: 'p' }] }
const EDITED = { name: 'plan', description: 'Plans better', nodes: [{ id: 'a', prompt: 'p' }] }
const FILE = 'C:/Projects/web/.archon/workflows/plan.yaml'
const IDENTITY = { name: 'plan', codebaseId: WEB, scope: 'project' }
const served = (authored: Record<string, unknown>, source = 'project') => json({ workflow: authored, authored, filename: 'plan.yaml', source })

function stageFor(storeId: string | undefined = 'store-a'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health(storeId === undefined ? {} : { storeId }))
  stage.archon.answer(CODEBASES, json([webProject]))
  stage.archon.answer(readUrl('plan'), served(OPENED))
  return stage
}

const draftInput = (extra: Record<string, unknown> = {}) => ({ ...IDENTITY, definition: EDITED, base: { source: 'project', authored: OPENED }, file: FILE, ...extra })
const write = (mounted: MountedScene, input: Record<string, unknown> = draftInput()): Promise<BuilderDraftWriteAnswer> =>
  mounted.worker.request('builder.draft.write', input as never) as Promise<BuilderDraftWriteAnswer>
const readTab = (mounted: MountedScene, identity: Record<string, unknown> = IDENTITY): Promise<BuilderAnswer> =>
  mounted.worker.request('builder.read', { ...identity, locale: 'en-GB' } as never) as Promise<BuilderAnswer>
const draftKeys = (mounted: MountedScene): string[] => Object.keys(mounted.host.data().storage).filter((key) => key.startsWith('builder-draft:'))

describe('builder drafts', () => {
  test('an edit is kept at once, reaches plugin storage after a pause with the copy it started from and the store id, and a read gives it back', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orca)
    assert.deepEqual(await write(mounted), { kept: true })
    assert.deepEqual(draftKeys(mounted), [])
    await stage.clock.advance(1_000)
    const keys = draftKeys(mounted)
    assert.equal(keys.length, 1)
    assert.deepEqual(mounted.host.data().storage[keys[0] ?? ''], {
      storeId: 'store-a',
      ...IDENTITY,
      isNew: false,
      definition: EDITED,
      base: { source: 'project', authored: OPENED },
      file: FILE
    })
    const answer = await readTab(mounted)
    assert.equal(answer.builder.kind, 'ready')
    assert.deepEqual(answer.draft, { definition: EDITED, base: { source: 'project', authored: OPENED }, file: FILE, isNew: false, otherArchon: false })
    await mounted.worker.deactivate()
  })

  test('at most 20 drafts exist: a 21st workflow is refused with a sentence, while a kept draft still takes edits', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orca)
    for (let index = 0; index < 20; index += 1) assert.deepEqual(await write(mounted, draftInput({ name: `plan-${String(index)}` })), { kept: true })
    assert.deepEqual(await write(mounted, draftInput({ name: 'plan-20' })), {
      kept: false,
      reason: 'Orchon keeps at most 20 builder drafts, so this one is not kept. Save or discard another draft first.'
    })
    assert.deepEqual(await write(mounted, draftInput({ name: 'plan-3', definition: OPENED })), { kept: true })
    await stage.clock.advance(1_000)
    assert.equal(draftKeys(mounted).length, 20)
    await mounted.worker.request('builder.draft.discard', { ...IDENTITY, name: 'plan-0' } as never)
    assert.deepEqual(await write(mounted, draftInput({ name: 'plan-20' })), { kept: true })
    await mounted.worker.deactivate()
  })

  test('drafts survive a restart and are never removed by age; one that cannot be read at all is deleted, and only that one', async () => {
    const kept = { storeId: 'store-a', ...IDENTITY, isNew: false, definition: EDITED, base: { source: 'project', authored: OPENED }, file: FILE }
    const stage = stageFor()
    const mounted = await stage.mount({
      ...orca,
      storage: { 'builder-draft:4': kept, 'builder-draft:7': { storeId: 'store-a', name: 'broken' }, 'builder-draft:9': 'not a draft', 'chat-drafts': [] }
    })
    await stage.clock.advance(400 * 24 * 60 * 60 * 1000)
    const answer = await readTab(mounted)
    assert.deepEqual(answer.draft, { definition: EDITED, base: { source: 'project', authored: OPENED }, file: FILE, isNew: false, otherArchon: false })
    assert.deepEqual(draftKeys(mounted), ['builder-draft:4'])
    assert.deepEqual(mounted.host.data().storage['builder-draft:4'], kept)
    assert.deepEqual(mounted.host.data().storage['chat-drafts'], [])
    await mounted.worker.deactivate()
  })

  test('a draft still waiting for the pause is written when the worker stops', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orca)
    await write(mounted)
    await mounted.worker.deactivate()
    assert.equal(draftKeys(mounted).length, 1)
  })

  test('discarding deletes the draft from plugin storage at once, and a read then gives none', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orca)
    await write(mounted)
    await stage.clock.advance(1_000)
    assert.equal(await mounted.worker.request('builder.draft.discard', IDENTITY as never), null)
    assert.deepEqual(draftKeys(mounted), [])
    await stage.clock.advance(1_000)
    assert.deepEqual(draftKeys(mounted), [])
    assert.equal((await readTab(mounted)).draft, null)
    await mounted.worker.deactivate()
  })

  test('a save that Archon accepts deletes the draft; a save that is refused keeps it', async () => {
    const stage = stageFor()
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
    stage.archon.answer(putUrl('plan'), json({ workflow: EDITED, filename: 'plan.yaml', source: 'project' }))
    const mounted = await stage.mount(orca)
    await write(mounted)
    await stage.clock.advance(1_000)
    const saveInput = { ...IDENTITY, definition: EDITED, base: { source: 'project', authored: { ...OPENED, description: 'Elsewhere' } }, locale: 'en-GB' }
    const refused = (await mounted.worker.request('builder.save', saveInput as never)) as BuilderSaveAnswer
    assert.equal(refused.save.kind, 'changed')
    assert.equal(draftKeys(mounted).length, 1)
    const saved = (await mounted.worker.request('builder.save', { ...saveInput, base: { source: 'project', authored: OPENED } } as never)) as BuilderSaveAnswer
    assert.deepEqual(saved.save, { kind: 'saved', source: 'project' })
    assert.deepEqual(draftKeys(mounted), [])
    assert.equal((await readTab(mounted)).draft, null)
    await mounted.worker.deactivate()
  })

  test('a draft made on another Archon is given back marked so, and is neither deleted nor rewritten under the new store id', async () => {
    const stage = stageFor('store-b')
    const kept = { storeId: 'store-a', ...IDENTITY, isNew: false, definition: EDITED, base: { source: 'project', authored: OPENED }, file: FILE }
    const mounted = await stage.mount({ ...orca, storage: { 'builder-draft:1': kept } })
    assert.equal((await readTab(mounted)).draft?.otherArchon, true)
    await write(mounted, draftInput({ definition: OPENED }))
    await stage.clock.advance(1_000)
    assert.deepEqual(mounted.host.data().storage['builder-draft:1'], { ...kept, definition: OPENED })
    const save = { ...IDENTITY, definition: OPENED, base: { source: 'project', authored: OPENED }, locale: 'en-GB' }
    const answer = (await mounted.worker.request('builder.save', save as never)) as BuilderSaveAnswer
    assert.deepEqual(answer.save, { kind: 'refused', message: 'This draft was made on a different Archon. It is not saved here, and it is kept.' })
    assert.ok(stage.archon.calls.every((call) => call.method === 'GET'))
    assert.deepEqual(draftKeys(mounted), ['builder-draft:1'])
    await mounted.worker.deactivate()
  })

  test('refuses a write that is not an identity, a definition within 1 MiB, a base or null, and the file in words', async () => {
    const stage = stageFor()
    const mounted = await stage.mount(orca)
    const big = { name: 'plan', nodes: [{ id: 'a', prompt: 'x'.repeat(1024 * 1024) }] }
    for (const input of [{}, draftInput({ definition: { nodes: 'no' } }), draftInput({ definition: big }), draftInput({ base: undefined }), draftInput({ file: '' }), draftInput({ more: 1 })]) {
      await assert.rejects(write(mounted, input), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await mounted.worker.deactivate()
  })
})
