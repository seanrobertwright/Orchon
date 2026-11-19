// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, and a stand-in Orca host. These tests cover sending a chat message: what the
// worker sends Archon, only once, with which body, and what it refuses before anything is sent.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, HANG, health, json, recorded, RELEASES, scene, type MountedScene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import type { ChatProjectsAnswer, ChatSendAnswer, ChatSendOutcome } from './chat-send-view'

/** The one web conversation and the one project each release's recording holds. */
const CONVERSATION: Record<Release, string> = {
  '0.12.1': 'web-1795050072354-vqr978',
  '0.13.2': 'web-1795050191420-o7xrhr',
  '0.14.0': 'web-1795050310074-i0mt96'
}
const PROJECTS: Record<Release, string> = {
  '0.12.1': 'cd8c6f17a56a08ff6e8c24143751f5c4',
  '0.13.2': '6feec5b110ac5147f1d58ffa49d2790c',
  '0.14.0': '4fb57f7e8043f7efd57270977e68c598'
}
const PROJECT = PROJECTS['0.12.1']

const CODEBASES = `${DEFAULT}/api/codebases`
const CREATE = `${DEFAULT}/api/conversations`
const messageUrl = (id: string): string => `${DEFAULT}/api/conversations/${id}/message`

/**
 * A release's Archon. The recordings hold no send to an existing conversation, so its answer is
 * the recorded answer of the launch route, the same `DispatchResponse` the path list documents
 * for `POST /api/conversations/{id}/message`.
 */
function sendScene(release: Release): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  stage.archon.answer(messageUrl(CONVERSATION[release]), recorded(release, 'launch-accepted', 6))
  stage.archon.answer(CREATE, recorded(release, 'launch-accepted', 0))
  return stage
}

async function send(mounted: MountedScene, input: Record<string, unknown>): Promise<ChatSendOutcome> {
  return ((await mounted.worker.request('chat.send', input as never)) as ChatSendAnswer).outcome
}

/** Every write the worker sent Archon: method, path and the body as sent. */
const writes = (stage: Scene): { method: string; path: string; body: unknown }[] =>
  stage.archon.calls
    .filter((call) => call.method !== 'GET')
    .map((call) => ({ method: call.method, path: new URL(call.url).pathname, body: call.body === undefined ? undefined : (JSON.parse(call.body) as unknown) }))

/** The refusal a request gets, or null when it was answered. */
async function refusal(mounted: MountedScene, name: 'chat.send' | 'chat.projects', input: unknown): Promise<string | null> {
  try {
    await mounted.worker.request(name, input as never)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('sending in an existing conversation', () => {
  for (const release of RELEASES) {
    test(`${release}: posts the message as typed, slash command and all, once, with only the floor's key`, async () => {
      const stage = sendScene(release)
      const mounted = await stage.mount({})
      const outcome = await send(mounted, { conversationId: CONVERSATION[release], message: '/status\n  and more  ' })
      assert.deepEqual(outcome, { kind: 'sent', conversationId: CONVERSATION[release] })
      assert.deepEqual(writes(stage), [
        { method: 'POST', path: `/api/conversations/${CONVERSATION[release]}/message`, body: { message: '/status\n  and more  ' } }
      ])
      await mounted.worker.deactivate()
    })
  }
})

describe('what the worker refuses before anything is sent', () => {
  const release: Release = '0.12.1'
  const id = CONVERSATION[release]
  const cases: [string, unknown][] = [
    ['an empty message', { conversationId: id, message: '' }],
    ['a message over 32 KiB', { conversationId: id, message: 'a'.repeat(32 * 1024 + 1) }],
    // 11,000 characters of three bytes each: 33,000 bytes of UTF-8.
    ['a message under 32 Ki characters but over 32 KiB of UTF-8', { conversationId: id, message: '€'.repeat(11_000) }],
    ['a message that is not text', { conversationId: id, message: 42 }],
    ['no message', { conversationId: id }],
    ['a conversation id outside the rule', { conversationId: 'web/../x', message: 'Hi' }],
    ['an empty conversation id', { conversationId: '', message: 'Hi' }],
    ['both a conversation and a project', { conversationId: id, codebaseId: PROJECT, message: 'Hi' }],
    ['neither a conversation nor a project', { message: 'Hi' }],
    ['an empty project id', { codebaseId: '', message: 'Hi' }],
    ['a key the request does not take', { conversationId: id, message: 'Hi', files: [] }],
    ['no object', 'Hi']
  ]
  for (const [name, input] of cases) {
    test(`${name}`, async () => {
      const stage = sendScene(release)
      const mounted = await stage.mount({})
      const refused = await refusal(mounted, 'chat.send', input)
      assert.ok(refused !== null && refused !== '', 'refused')
      assert.deepEqual(writes(stage), [])
      await mounted.worker.deactivate()
    })
  }

  test('a message of blanks only is 1 character or more, so it is sent as typed', async () => {
    const stage = sendScene(release)
    const mounted = await stage.mount({})
    assert.deepEqual(await send(mounted, { conversationId: id, message: ' \n\t ' }), { kind: 'sent', conversationId: id })
    assert.deepEqual(writes(stage), [{ method: 'POST', path: `/api/conversations/${id}/message`, body: { message: ' \n\t ' } }])
    await mounted.worker.deactivate()
  })

  test('a message of exactly 32 KiB is sent', async () => {
    const stage = sendScene(release)
    const mounted = await stage.mount({})
    const message = 'a'.repeat(32 * 1024)
    assert.deepEqual(await send(mounted, { conversationId: id, message }), { kind: 'sent', conversationId: id })
    assert.equal(writes(stage).length, 1)
    await mounted.worker.deactivate()
  })
})

describe('the first send of a new chat', () => {
  for (const release of RELEASES) {
    test(`${release}: reads Archon's projects afresh, then creates the conversation with only codebaseId and message`, async () => {
      const stage = sendScene(release)
      const mounted = await stage.mount({})
      const outcome = await send(mounted, { codebaseId: PROJECTS[release], message: 'What does this project build?' })
      assert.deepEqual(outcome, { kind: 'sent', conversationId: CONVERSATION[release] })
      assert.deepEqual(writes(stage), [{ method: 'POST', path: '/api/conversations', body: { codebaseId: PROJECTS[release], message: 'What does this project build?' } }])
      // The project list is read for this send, after the worker connected.
      const calls = stage.archon.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
      assert.deepEqual(calls.slice(-2), ['GET /api/codebases', 'POST /api/conversations'])
      // A second new chat reads the list again.
      await send(mounted, { codebaseId: PROJECTS[release], message: 'And another?' })
      assert.equal(stage.archon.calls.filter((call) => call.url === CODEBASES).length, 2)
      await mounted.worker.deactivate()
    })
  }

  test('a project Archon does not list is refused, and no conversation is created', async () => {
    const stage = sendScene('0.12.1')
    const mounted = await stage.mount({})
    const outcome = await send(mounted, { codebaseId: 'not-a-listed-project', message: 'Hi' })
    assert.equal(outcome.kind, 'refused')
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })

  test('when the project list cannot be read, no conversation is created', async () => {
    const stage = sendScene('0.12.1')
    stage.archon.answer(CODEBASES, json({ error: 'boom' }, 500))
    const mounted = await stage.mount({})
    const outcome = await send(mounted, { codebaseId: PROJECT, message: 'Hi' })
    assert.equal(outcome.kind, 'refused')
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })
})

describe('a send that is not answered or not accepted', () => {
  const release: Release = '0.12.1'
  const id = CONVERSATION[release]

  test('a send that times out is answered as a timeout and never sent again, in a conversation or a new chat', async () => {
    for (const [url, input] of [
      [messageUrl(id), { conversationId: id, message: 'Hi' }],
      [CREATE, { codebaseId: PROJECT, message: 'Hi' }]
    ] as const) {
      const stage = sendScene(release)
      stage.archon.answer(url, HANG)
      const mounted = await stage.mount({})
      const pending = send(mounted, input)
      await stage.clock.advance(30_000)
      assert.deepEqual(await pending, { kind: 'timeout', timeoutMs: 30_000 })
      await stage.clock.advance(120_000)
      assert.equal(writes(stage).length, 1)
      await mounted.worker.deactivate()
    }
  })

  test("Archon's refusal is said in Archon's words, a conversation that no longer exists is gone, and a send Archon did not accept is refused", async () => {
    const stage = sendScene(release)
    const mounted = await stage.mount({})
    stage.archon.answer(messageUrl(id), json({ error: 'Conversation is not a web conversation' }, 400))
    assert.deepEqual(await send(mounted, { conversationId: id, message: 'Hi' }), { kind: 'refused', message: 'Conversation is not a web conversation' })
    stage.archon.answer(messageUrl(id), json({ error: 'Conversation not found' }, 404))
    assert.deepEqual(await send(mounted, { conversationId: id, message: 'Hi' }), { kind: 'gone' })
    stage.archon.answer(messageUrl(id), json({ accepted: false, status: 'rejected' }))
    assert.equal((await send(mounted, { conversationId: id, message: 'Hi' })).kind, 'refused')
    stage.archon.answer(CREATE, json({ error: 'codebaseId is required' }, 400))
    assert.deepEqual(await send(mounted, { codebaseId: PROJECT, message: 'Hi' }), { kind: 'refused', message: 'codebaseId is required' })
    await mounted.worker.deactivate()
  })

  test('one send at a time: a second while one waits for Archon is refused and not sent', async () => {
    const stage = sendScene(release)
    stage.archon.answer(messageUrl(id), HANG)
    const mounted = await stage.mount({})
    const pending = send(mounted, { conversationId: id, message: 'First' })
    await stage.clock.advance(1_000)
    const second = await send(mounted, { codebaseId: PROJECT, message: 'Second' })
    assert.equal(second.kind, 'refused')
    await stage.clock.advance(30_000)
    await pending
    assert.deepEqual(
      writes(stage).map((write) => write.body),
      [{ message: 'First' }]
    )
    await mounted.worker.deactivate()
  })

  test('while not Connected nothing is sent', async () => {
    const stage = scene()
    const mounted = await stage.mount({})
    assert.deepEqual(await send(mounted, { conversationId: id, message: 'Hi' }), { kind: 'not-connected' })
    assert.deepEqual(writes(stage), [])
    await mounted.worker.deactivate()
  })
})

describe("a new chat's projects", () => {
  for (const release of RELEASES) {
    test(`${release}: Archon's projects with the folder each one's agent works in, and the scope's project when named`, async () => {
      const stage = sendScene(release)
      const mounted = await stage.mount({})
      const project = { id: PROJECTS[release], name: 'orchon-recorder/throwaway-project', defaultCwd: '<project-path>' }
      const named = (await mounted.worker.request('chat.projects', { codebaseId: PROJECTS[release] })) as ChatProjectsAnswer
      assert.deepEqual(named.projects, { kind: 'ready', chosen: project, projects: [project], more: 0, unreadable: 0 })
      const all = (await mounted.worker.request('chat.projects', {})) as ChatProjectsAnswer
      assert.deepEqual(all.projects, { kind: 'ready', chosen: null, projects: [project], more: 0, unreadable: 0 })
      await mounted.worker.deactivate()
    })
  }

  test('lists the first 100 by name and counts the rest and the rows it could not read; a project past the cap can still be the chosen one', async () => {
    const stage = sendScene('0.12.1')
    const rows = Array.from({ length: 103 }, (_, index) => ({ id: `p-${String(index)}`, name: `project ${String(index).padStart(3, '0')}`, default_cwd: `/code/${String(index)}` }))
    stage.archon.answer(CODEBASES, json([...rows.reverse(), { id: 'broken' }]))
    const mounted = await stage.mount({})
    const answer = ((await mounted.worker.request('chat.projects', { codebaseId: 'p-102' })) as ChatProjectsAnswer).projects
    if (answer.kind !== 'ready') throw new Error(answer.kind)
    assert.equal(answer.projects.length, 100)
    assert.equal(answer.projects[0]?.name, 'project 000')
    assert.equal(answer.projects[99]?.name, 'project 099')
    assert.equal(answer.more, 3)
    assert.equal(answer.unreadable, 1)
    assert.deepEqual(answer.chosen, { id: 'p-102', name: 'project 102', defaultCwd: '/code/102' })
    await mounted.worker.deactivate()
  })

  test('a list that cannot be read is a failure in words, and a malformed request is refused', async () => {
    const stage = sendScene('0.12.1')
    stage.archon.answer(CODEBASES, json({ error: 'boom' }, 500))
    const mounted = await stage.mount({})
    const answer = ((await mounted.worker.request('chat.projects', {})) as ChatProjectsAnswer).projects
    assert.equal(answer.kind, 'failed')
    for (const input of [{ codebaseId: '' }, { codebaseId: 7 }, { other: 1 }, 'x']) {
      assert.ok((await refusal(mounted, 'chat.projects', input)) !== null, JSON.stringify(input))
    }
    await mounted.worker.deactivate()
  })
})
