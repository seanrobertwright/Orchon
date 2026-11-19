// The worker's request protocol seam for the builder's Save and Validate (#16): the worker mounted
// on a scripted Archon that replays the recorded validation answers. These tests cover
// `builder.save`, which checks for an outside change, has Archon validate the definition and then
// writes it with one PUT, and `builder.validate`, which only validates. They assert the calls the
// worker makes to Archon, the bodies it sends and the outcome the tab is answered.
import { assert, describe, test } from 'orca/testing'
import type { MockHostOptions } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, HANG, health, json, recorded, RELEASES, scene, type Scene, type Scripted, type ScriptedCall } from '../scripts/scripted-archon.ts'
import type { BuilderSaveAnswer, BuilderValidateAnswer } from '../editors/builder/builder-view'

const CODEBASES = `${DEFAULT}/api/codebases`
const VALIDATE = `${DEFAULT}/api/workflows/validate`
const WEB = 'aaaa0000bbbb1111cccc2222dddd3333'
const WEB_FOLDER = 'C:/Projects/web'
const webProject = { id: WEB, name: 'web', default_cwd: WEB_FOLDER, repository_url: null }
const readUrl = (name: string, cwd: string | null): string => `${DEFAULT}/api/workflows/${encodeURIComponent(name)}${cwd === null ? '' : `?cwd=${encodeURIComponent(cwd)}`}`
const putUrl = (name: string, query: string): string => `${DEFAULT}/api/workflows/${encodeURIComponent(name)}?${query}`

const orca: MockHostOptions = {
  results: {
    'workspace.readContext': { workspaceId: 'ws-web', branch: 'main', displayName: 'web', terminals: [] },
    'workspace.list': { workspaces: [], truncated: false }
  }
}

/** The definition the builder opened, and the one it saves. */
const OPENED = { name: 'plan', description: 'Plans', nodes: [{ id: 'a', prompt: 'p' }] }
const EDITED = { name: 'plan', description: 'Plans better', nodes: [{ id: 'a', prompt: 'p' }, { id: 'b', bash: 'true', depends_on: ['a'] }] }

/** A read of the workflow as Archon answers it, from `source`. */
const served = (authored: Record<string, unknown>, source = 'project') => json({ workflow: authored, authored, filename: 'plan.yaml', source })
/** What Archon 0.12.1's save answers on success, by its source: the normalised workflow, the file and the source. No release's save was recorded. */
const putAnswer = (source = 'project') => json({ workflow: EDITED, filename: 'plan.yaml', source })

function stageFor(release: (typeof RELEASES)[number] = '0.12.1'): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, json([webProject]))
  return stage
}

const workflowCalls = (stage: Scene): { method: string; url: string; body: unknown }[] =>
  stage.archon.calls
    .filter((call) => call.url.startsWith(`${DEFAULT}/api/workflows`))
    .map((call: ScriptedCall) => ({ method: call.method, url: call.url, body: call.body === undefined ? undefined : JSON.parse(call.body) }))

const saveInput = (extra: Record<string, unknown> = {}) => ({
  name: 'plan',
  codebaseId: WEB,
  scope: 'project',
  definition: EDITED,
  base: { source: 'project', authored: OPENED },
  locale: 'en-GB',
  ...extra
})

async function save(stage: Scene, input: Record<string, unknown>): Promise<BuilderSaveAnswer> {
  const { worker } = await stage.mount(orca)
  const answer = (await worker.request('builder.save', input as never)) as BuilderSaveAnswer
  await worker.deactivate()
  return answer
}

describe('the builder save', () => {
  for (const release of RELEASES) {
    test(`checks for an outside change, has Archon validate, then writes once, sending only the definition (${release})`, async () => {
      const stage = stageFor(release)
      stage.archon.answer(readUrl('plan', WEB_FOLDER), served(OPENED))
      stage.archon.answer(VALIDATE, recorded(release, 'validate', 0))
      stage.archon.answer(putUrl('plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), putAnswer())
      const answer = await save(stage, saveInput())
      assert.deepEqual(answer.save, { kind: 'saved', source: 'project' })
      assert.deepEqual(workflowCalls(stage), [
        { method: 'GET', url: readUrl('plan', WEB_FOLDER), body: undefined },
        { method: 'POST', url: VALIDATE, body: { definition: EDITED } },
        { method: 'PUT', url: putUrl('plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), body: { definition: EDITED } }
      ])
    })
  }

  test('an outside change since the copy the builder opened stops the save: nothing is validated or written, and the answer carries what Archon serves now', async () => {
    const outside = { ...OPENED, description: 'Changed by someone else' }
    const stage = stageFor()
    stage.archon.answer(readUrl('plan', WEB_FOLDER), served(outside))
    const answer = await save(stage, saveInput())
    assert.deepEqual(answer.save, {
      kind: 'changed',
      message: 'This workflow changed outside the builder since you opened it, so nothing was written.',
      current: { source: 'project', authored: outside }
    })
    assert.deepEqual(workflowCalls(stage).map((call) => call.method), ['GET'])
  })

  test('a re-read that holds the same workflow with its keys in another order is no outside change', async () => {
    const stage = stageFor()
    stage.archon.answer(readUrl('plan', WEB_FOLDER), served({ nodes: [{ prompt: 'p', id: 'a' }], description: 'Plans', name: 'plan' }))
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
    stage.archon.answer(putUrl('plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), putAnswer())
    assert.deepEqual((await save(stage, saveInput())).save, { kind: 'saved', source: 'project' })
  })

  test('a workflow removed outside, or now served from another source, is an outside change too', async () => {
    const removed = stageFor()
    removed.archon.answer(readUrl('plan', WEB_FOLDER), json({ error: 'Workflow not found: plan' }, 404))
    assert.deepEqual((await save(removed, saveInput())).save, {
      kind: 'changed',
      message: 'Archon no longer serves this workflow here: it was removed or replaced outside the builder, so nothing was written.',
      current: null
    })
    const replaced = stageFor()
    replaced.archon.answer(readUrl('plan', WEB_FOLDER), served(OPENED, 'global'))
    const answer = await save(replaced, saveInput())
    assert.equal(answer.save.kind, 'changed')
    assert.deepEqual(workflowCalls(replaced).map((call) => call.method), ['GET'])
  })

  test('overwrite: a save whose expected copy is the outside change it was shown writes over it', async () => {
    const outside = { ...OPENED, description: 'Changed by someone else' }
    const stage = stageFor()
    stage.archon.answer(readUrl('plan', WEB_FOLDER), served(outside))
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
    stage.archon.answer(putUrl('plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), putAnswer())
    const answer = await save(stage, saveInput({ base: { source: 'project', authored: outside } }))
    assert.deepEqual(answer.save, { kind: 'saved', source: 'project' })
    assert.deepEqual(workflowCalls(stage).map((call) => call.method), ['GET', 'POST', 'PUT'])
  })

  for (const release of RELEASES) {
    test(`a draft Archon's validation rejects is not written, and its sentences are answered as Archon gave them (${release})`, async () => {
      const stage = stageFor(release)
      stage.archon.answer(readUrl('plan', WEB_FOLDER), served(OPENED))
      stage.archon.answer(VALIDATE, recorded(release, 'validate', 1))
      const answer = await save(stage, saveInput())
      assert.deepEqual(answer.save, { kind: 'invalid', errors: ["Node 'a' depends_on unknown node 'missing'"], more: 0 })
      assert.deepEqual(workflowCalls(stage).map((call) => call.method), ['GET', 'POST'])
    })
  }

  test('a validation that fails or answers something else writes nothing', async () => {
    for (const validation of [recorded('0.12.1', 'validate', 2), json({ ok: true }), HANG]) {
      const stage = stageFor()
      stage.archon.answer(readUrl('plan', WEB_FOLDER), served(OPENED))
      stage.archon.answer(VALIDATE, validation)
      const { worker } = await stage.mount(orca)
      const pending = worker.request('builder.save', saveInput() as never) as Promise<BuilderSaveAnswer>
      await stage.clock.advance(30_000)
      const answer = await pending
      await worker.deactivate()
      assert.equal(answer.save.kind, 'failed')
      assert.ok(answer.save.kind === 'failed' && answer.save.message.endsWith('so nothing was written.'), JSON.stringify(answer.save))
      assert.deepEqual(workflowCalls(stage).map((call) => call.method), ['GET', 'POST'])
    }
  })

  test("Archon's refusal of the write is said in its own words with its detail", async () => {
    const stage = stageFor()
    stage.archon.answer(readUrl('plan', WEB_FOLDER), served(OPENED))
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
    stage.archon.answer(putUrl('plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), json({ error: 'Workflow definition is invalid', detail: 'nodes[1]: unknown kind' }, 400))
    assert.deepEqual((await save(stage, saveInput())).save, { kind: 'failed', message: 'Workflow definition is invalid: nodes[1]: unknown kind' })
  })

  /** A scripted read of the workflow that serves the opened copy first and `after` from then on. */
  const readsThen = (after: () => Scripted): (() => Scripted) => {
    let reads = 0
    return () => {
      reads += 1
      return reads === 1 ? served(OPENED) : after()
    }
  }

  test('a save that times out is not sent again: the worker reads the workflow to learn whether it landed, and says which', async () => {
    const cases = [
      { after: () => served(EDITED), landed: true, message: 'The save was not answered in time and was not sent again. Archon holds the workflow as you saved it.', source: 'project' },
      { after: () => served(OPENED), landed: false, message: 'The save was not answered in time and was not sent again. Archon does not hold your changes; they are still here.', source: null },
      { after: () => json({ error: 'boom' }, 500), landed: null, message: 'The save was not answered in time and was not sent again. Orchon could not read the workflow to learn whether it was saved.', source: null }
    ]
    for (const { after, landed, message, source } of cases) {
      const stage = stageFor()
      stage.archon.answer(readUrl('plan', WEB_FOLDER), readsThen(after))
      stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
      stage.archon.answer(putUrl('plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), HANG)
      const { worker } = await stage.mount(orca)
      const pending = worker.request('builder.save', saveInput() as never) as Promise<BuilderSaveAnswer>
      await stage.clock.advance(30_000)
      const answer = await pending
      await stage.clock.advance(120_000)
      await worker.deactivate()
      assert.deepEqual(answer.save, { kind: 'timeout', landed, message, source })
      assert.deepEqual(workflowCalls(stage).map((call) => call.method), ['GET', 'POST', 'PUT', 'GET'])
    }
  })

  test("a bundled workflow saves as the chosen project's own copy, always with cwd; with no project chosen nothing is sent", async () => {
    const stage = stageFor()
    const bundled = { name: 'archon-plan', nodes: [{ id: 'plan', prompt: 'p' }] }
    stage.archon.answer(readUrl('archon-plan', WEB_FOLDER), served(bundled, 'bundled'))
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
    stage.archon.answer(putUrl('archon-plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), putAnswer())
    const input = { name: 'archon-plan', scope: 'bundled', definition: EDITED, base: { source: 'bundled', authored: bundled } }
    assert.deepEqual((await save(stage, saveInput(input))).save, { kind: 'saved', source: 'project' })
    assert.equal(workflowCalls(stage).at(-1)?.url, putUrl('archon-plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`))

    const none = stageFor()
    assert.deepEqual((await save(none, saveInput({ ...input, codebaseId: null }))).save, {
      kind: 'refused',
      message: "A bundled workflow saves as a project's own copy, so it needs a project. Choose a project in the Workflows section and open the workflow from there."
    })
    assert.deepEqual(workflowCalls(none), [])
  })

  test("a global workflow saves to Archon's home folder; a project's workflow needs its project", async () => {
    const stage = stageFor()
    stage.archon.answer(readUrl('plan', null), served(OPENED, 'global'))
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
    stage.archon.answer(putUrl('plan', 'source=global'), putAnswer('global'))
    const answer = await save(stage, saveInput({ codebaseId: null, scope: 'global', base: { source: 'global', authored: OPENED } }))
    assert.deepEqual(answer.save, { kind: 'saved', source: 'global' })
    assert.equal(workflowCalls(stage).at(-1)?.url, putUrl('plan', 'source=global'))

    const none = stageFor()
    assert.equal((await save(none, saveInput({ codebaseId: null }))).save.kind, 'refused')
    assert.deepEqual(workflowCalls(none), [])
  })

  for (const release of RELEASES) {
    test(`content the builder does not understand reaches Archon unchanged: a recorded workflow with unknown fields added (${release})`, async () => {
      const recordedAnswer = recorded(release, 'workflows/archon-plan')
      if (recordedAnswer.kind !== 'json') throw new Error('The recorded workflow is not JSON.')
      const authored = (recordedAnswer.value as { authored: Record<string, unknown> }).authored
      const nodes = authored.nodes as Record<string, unknown>[]
      const strange = {
        ...authored,
        'x-team': { owner: 'someone', tags: ['a', 'b'] },
        nodes: [...nodes.map((node, index) => (index === 0 ? { ...node, teleport: { to: 'mars', at: 3 } } : node)), { id: 'mystery', unknown_kind: { deep: [1, null, true] } }]
      }
      const stage = stageFor(release)
      stage.archon.answer(readUrl('archon-plan', WEB_FOLDER), served(authored, 'bundled'))
      stage.archon.answer(VALIDATE, recorded(release, 'validate', 0))
      stage.archon.answer(putUrl('archon-plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), putAnswer())
      await save(stage, saveInput({ name: 'archon-plan', scope: 'bundled', definition: strange, base: { source: 'bundled', authored } }))
      const put = workflowCalls(stage).find((call) => call.method === 'PUT')
      assert.deepEqual(put?.body, { definition: strange })
    })
  }

  test('an installed workflow is view-only, and nothing is sent while not connected', async () => {
    const installed = stageFor()
    assert.deepEqual((await save(installed, saveInput({ scope: 'installed' }))).save, { kind: 'refused', message: 'This workflow is installed, so it can only be viewed here.' })
    assert.deepEqual(workflowCalls(installed), [])
    const off = scene()
    const answer = await save(off, saveInput())
    assert.deepEqual(answer.save, { kind: 'refused', message: 'Orchon is not connected to Archon.' })
    assert.equal(answer.connection.kind, 'screen')
    assert.deepEqual(workflowCalls(off), [])
  })

  test('one save at a time: a second save while one waits for Archon is refused and sends nothing', async () => {
    const stage = stageFor()
    stage.archon.answer(readUrl('plan', WEB_FOLDER), served(OPENED))
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 0))
    stage.archon.answer(putUrl('plan', `source=project&cwd=${encodeURIComponent(WEB_FOLDER)}`), HANG)
    const { worker } = await stage.mount(orca)
    const first = worker.request('builder.save', saveInput() as never) as Promise<BuilderSaveAnswer>
    await stage.clock.advance(0)
    const second = (await worker.request('builder.save', saveInput() as never)) as BuilderSaveAnswer
    assert.deepEqual(second.save, { kind: 'refused', message: 'Another save is still waiting for Archon.' })
    await stage.clock.advance(30_000)
    await first
    await worker.deactivate()
    assert.equal(workflowCalls(stage).filter((call) => call.method === 'PUT').length, 1)
  })

  test('refuses a request that is not an identity, a definition within 1 MiB, an expected copy and a language', async () => {
    const { worker } = await stageFor().mount(orca)
    const big = { name: 'plan', nodes: [{ id: 'a', prompt: 'x'.repeat(1024 * 1024) }] }
    const noBase: Record<string, unknown> = saveInput()
    delete noBase.base
    const inputs = [
      saveInput({ definition: { name: 'plan', nodes: 'none' } }),
      saveInput({ definition: big }),
      saveInput({ base: { source: 'project', authored: big } }),
      saveInput({ base: { source: '', authored: OPENED } }),
      saveInput({ base: { source: 'project', authored: OPENED, more: 1 } }),
      saveInput({ more: 1 }),
      saveInput({ locale: 'not a tag' }),
      noBase
    ]
    for (const input of inputs) {
      await assert.rejects(worker.request('builder.save', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    for (const input of [{ definition: big, locale: 'en-GB' }, { definition: EDITED }, { definition: EDITED, locale: 'en-GB', name: 'plan' }]) {
      await assert.rejects(worker.request('builder.validate', input as never), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
    }
    await worker.deactivate()
  })
})

describe('the builder validate', () => {
  for (const release of RELEASES) {
    test(`asks Archon with only the definition, writes nothing, and answers its verdict and sentences (${release})`, async () => {
      const cases: [Scripted, unknown][] = [
        [recorded(release, 'validate', 0), { kind: 'valid' }],
        [recorded(release, 'validate', 1), { kind: 'invalid', errors: ["Node 'a' depends_on unknown node 'missing'"], more: 0 }]
      ]
      for (const [answer, outcome] of cases) {
        const stage = stageFor(release)
        stage.archon.answer(VALIDATE, answer)
        const { worker } = await stage.mount(orca)
        const validated = (await worker.request('builder.validate', { definition: EDITED, locale: 'en-GB' } as never)) as BuilderValidateAnswer
        await worker.deactivate()
        assert.deepEqual(validated.validate, outcome)
        assert.deepEqual(workflowCalls(stage), [{ method: 'POST', url: VALIDATE, body: { definition: EDITED } }])
      }
    })
  }

  test("a malformed request's 400 is said in Archon's words, and the sentences are capped with a count of the rest", async () => {
    const stage = stageFor()
    stage.archon.answer(VALIDATE, recorded('0.12.1', 'validate', 2))
    const { worker } = await stage.mount(orca)
    const failed = (await worker.request('builder.validate', { definition: EDITED, locale: 'en-GB' } as never)) as BuilderValidateAnswer
    assert.deepEqual(failed.validate, { kind: 'failed', message: 'definition: Invalid input: expected record, received undefined' })
    stage.archon.answer(VALIDATE, json({ valid: false, errors: Array.from({ length: 25 }, (_, index) => `Error ${String(index + 1)}`) }))
    const many = (await worker.request('builder.validate', { definition: EDITED, locale: 'en-GB' } as never)) as BuilderValidateAnswer
    await worker.deactivate()
    assert.ok(many.validate.kind === 'invalid')
    assert.equal(many.validate.errors.length, 20)
    assert.equal(many.validate.errors[19], 'Error 20')
    assert.equal(many.validate.more, 5)
  })
})
