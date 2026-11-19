// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, and a stand-in Orca host. These tests cover a chat thread: what the worker
// asks Archon for, the messages it answers and in which order, what it hides, cuts and drops, and
// what it refuses.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT, DEFAULT_HEALTH, health, json, recorded, RELEASES, scene, type MountedScene, type Release, type Scene } from '../scripts/scripted-archon.ts'
import type { Thread, ThreadAnswer, ThreadView } from './chat-thread-view'

/** The one web conversation each release's recording holds, read off the fixtures by hand. */
const RECORDED: Record<Release, { id: string; title: string; user: { id: string; at: number }; assistant: { id: string; at: number } }> = {
  '0.12.1': {
    id: 'web-1795050072354-vqr978',
    title: 'Orchon recorder launch shell step',
    user: { id: 'ad4336d60932433064caeb7c0247160d', at: Date.UTC(2026, 10, 19, 1, 1, 12) },
    assistant: { id: '372a43bd65fa712a173f9c3e0c5ddf91', at: Date.UTC(2026, 10, 19, 1, 1, 15) }
  },
  '0.13.2': {
    id: 'web-1795050191420-o7xrhr',
    title: 'Orchon launch recording shell step',
    user: { id: '3e15411262282c8d2ea8f84b61d822eb', at: Date.UTC(2026, 10, 19, 1, 3, 11) },
    assistant: { id: '5a811e3ff4503b62a553a4c367545fec', at: Date.UTC(2026, 10, 19, 1, 3, 14) }
  },
  '0.14.0': {
    id: 'web-1795050310074-i0mt96',
    title: 'Orchon launch shell step',
    user: { id: 'a4df0322074c4750e409f699004fab4f', at: Date.UTC(2026, 10, 19, 1, 5, 10) },
    assistant: { id: 'a93711901d7f5b4edbbcb52979852ccb', at: Date.UTC(2026, 10, 19, 1, 5, 13) }
  }
}

const CODEBASES = `${DEFAULT}/api/codebases`
const conversationUrl = (id: string): string => `${DEFAULT}/api/conversations/${id}`
const messagesUrl = (id: string, limit = 50): string => `${DEFAULT}/api/conversations/${id}/messages?limit=${String(limit)}`

/** A release's Archon answering its recorded conversation, its messages and its projects. */
function threadScene(release: Release): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  const id = RECORDED[release].id
  stage.archon.answer(conversationUrl(id), recorded(release, 'conversations', 2))
  stage.archon.answer(messagesUrl(id), recorded(release, 'conversations', 3))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  return stage
}

async function read(mounted: MountedScene, input: Record<string, unknown>): Promise<ThreadView> {
  return ((await mounted.worker.request('chat.read', input as never)) as ThreadAnswer).thread
}

const ready = (view: ThreadView): Thread => {
  if (view.kind !== 'ready') throw new Error(`The thread is ${view.kind}${view.kind === 'failed' ? `: ${view.message}` : ''}.`)
  return view.thread
}

describe('a recorded thread', () => {
  for (const release of RELEASES) {
    test(`${release}: the conversation, its project and its saved messages newest first, without framework messages`, async () => {
      const stage = threadScene(release)
      const mounted = await stage.mount({})
      const chat = RECORDED[release]
      const thread = ready(await read(mounted, { conversationId: chat.id, limit: 50 }))
      assert.deepEqual(thread, {
        id: chat.id,
        title: chat.title,
        project: { name: 'orchon-recorder/throwaway-project', defaultCwd: '<project-path>' },
        messages: [
          { id: chat.assistant.id, role: 'assistant', at: chat.assistant.at, format: 'markdown', blocks: ['Starting workflow: `orchon-recorder-echo`'], notShown: 0 },
          { id: chat.user.id, role: 'user', at: chat.user.at, format: 'markdown', blocks: ['Recording a launch for Orchon: one shell step.'], notShown: 0 }
        ],
        limit: 50,
        earlier: false,
        atArchonCap: false,
        unreadable: 0,
        cut: 0
      })
      assert.ok(stage.archon.calls.some((call) => call.url === messagesUrl(chat.id)))
      await mounted.worker.deactivate()
    })
  }
})

/** The recorded messages of a release, for a test that adds its own beside them. */
function recordedMessages(release: Release): Record<string, unknown>[] {
  const answer = recorded(release, 'conversations', 3)
  if (answer.kind !== 'json' || !Array.isArray(answer.value)) throw new Error(`The recorded messages of ${release} are not a list.`)
  return answer.value as Record<string, unknown>[]
}

/** A saved message like the recorded user message, with its own id and the fields given. */
function likeRecorded(release: Release, id: string, change: Record<string, unknown> = {}): Record<string, unknown> {
  const [first] = recordedMessages(release)
  return { ...first, id, ...change }
}

/** A thread whose messages Archon answers with `rows`, oldest first as Archon sends them. */
async function readRows(release: Release, rows: unknown[], input: Record<string, unknown> = {}): Promise<{ view: ThreadView; stage: Scene }> {
  const stage = threadScene(release)
  const id = RECORDED[release].id
  const limit = typeof input.limit === 'number' ? input.limit : 50
  stage.archon.answer(messagesUrl(id, limit), json(rows))
  const mounted = await stage.mount({})
  const view = await read(mounted, { conversationId: id, limit: 50, ...input })
  await mounted.worker.deactivate()
  return { view, stage }
}

describe('what a message carries', () => {
  for (const release of RELEASES) {
    test(`${release}: error metadata, the names of console files, and metadata given as an object or as JSON text`, async () => {
      const files = [
        { name: 'plan.md', mimeType: 'text/markdown', size: 120 },
        { name: 'shot.png', mimeType: 'image/png', size: 4096 }
      ]
      const { view } = await readRows(release, [
        likeRecorded(release, 'm-files', { metadata: JSON.stringify({ files }) }),
        likeRecorded(release, 'm-error', { role: 'assistant', content: 'Partial reply', metadata: { error: { message: 'The provider stopped.', classification: 'provider' } } }),
        likeRecorded(release, 'm-hidden', { role: 'assistant', metadata: { category: 'system_note' } })
      ])
      const messages = ready(view).messages
      assert.deepEqual(
        messages.map((message) => message.id),
        ['m-error', 'm-files']
      )
      assert.equal(messages[0]?.error, 'The provider stopped.')
      assert.deepEqual(messages[0]?.blocks, ['Partial reply'])
      assert.deepEqual(messages[1]?.files, { names: ['plan.md', 'shot.png'], notShown: 0 })
      assert.equal(messages[1]?.error, undefined)
    })
  }
})

/** `count` paragraphs of 1,000 characters each, with a blank line after each: Markdown the cutter cuts at a blank line. */
const paragraphs = (count: number): string => `${'a'.repeat(998)}\n\n`.repeat(count)

describe('long messages', () => {
  test('a message over 16 KiB is split into blocks of at most 16 KiB that join back into the message', async () => {
    const content = paragraphs(40)
    const { view } = await readRows('0.14.0', [likeRecorded('0.14.0', 'm-long', { content })])
    const [message] = ready(view).messages
    assert.ok((message?.blocks.length ?? 0) > 1)
    assert.ok(message?.blocks.every((block) => block.length <= 16 * 1024))
    assert.equal(message?.blocks.join(''), content)
    assert.equal(message?.notShown, 0)
  })

  test('a message over 64 KiB is cut there, and the answer says how much is not shown', async () => {
    const content = paragraphs(80)
    const { view } = await readRows('0.14.0', [likeRecorded('0.14.0', 'm-huge', { content })])
    const [message] = ready(view).messages
    const shown = message?.blocks.join('') ?? ''
    assert.ok(shown.length <= 64 * 1024)
    assert.ok(content.startsWith(shown))
    assert.equal(message?.notShown, content.length - shown.length)
    // 80,000 characters less the 65 whole paragraphs that fit 64 KiB.
    assert.equal(message?.notShown, 15_000)
  })
})

describe("Archon's answer", () => {
  test('drops and counts the messages it cannot read, and keeps one whose time does not parse without its time', async () => {
    const { view } = await readRows('0.12.1', [
      likeRecorded('0.12.1', 'm-good'),
      likeRecorded('0.12.1', 'm-no-time', { created_at: 'yesterday' }),
      likeRecorded('0.12.1', 'm-bad-metadata', { metadata: '{not json' }),
      likeRecorded('0.12.1', 'm-list-metadata', { metadata: '[]' }),
      likeRecorded('0.12.1', 'm-bad-role', { role: 'tool' }),
      likeRecorded('0.12.1', 'm-no-content', { content: null }),
      likeRecorded('0.12.1', 'm-bad-error', { metadata: { error: 'boom' } }),
      likeRecorded('0.12.1', 'm-bad-files', { metadata: { files: [{ size: 3 }] } }),
      { ...likeRecorded('0.12.1', 'x'), id: '' },
      'not a row'
    ])
    const thread = ready(view)
    assert.deepEqual(
      thread.messages.map((message) => [message.id, message.at]),
      [
        ['m-no-time', null],
        ['m-good', RECORDED['0.12.1'].user.at]
      ]
    )
    assert.equal(thread.unreadable, 8)
  })

  test('a messages answer that is not a list fails the read with a sentence naming the version', async () => {
    const { view } = await readRows('0.12.1', { messages: [] } as never)
    assert.equal(view.kind, 'failed')
    assert.match(view.kind === 'failed' ? view.message : '', /Archon 0\.12\.1/)
  })

  for (const [what, url] of [
    ['conversation', conversationUrl],
    ['messages', (id: string) => messagesUrl(id)]
  ] as const) {
    test(`a 404 on the ${what} means the conversation no longer exists`, async () => {
      const stage = threadScene('0.13.2')
      const id = RECORDED['0.13.2'].id
      // Archon's words for it, from its source: no recording holds a missing conversation.
      stage.archon.answer(url(id), json({ error: 'Conversation not found' }, 404))
      const mounted = await stage.mount({})
      assert.deepEqual(await read(mounted, { conversationId: id, limit: 50 }), { kind: 'gone' })
      await mounted.worker.deactivate()
    })
  }

  test('a conversation with no project, or one Archon no longer lists, has no project', async () => {
    const stage = threadScene('0.14.0')
    const id = RECORDED['0.14.0'].id
    stage.archon.answer(CODEBASES, recorded('0.14.0', 'codebases-empty'))
    const mounted = await stage.mount({})
    assert.equal(ready(await read(mounted, { conversationId: id, limit: 50 })).project, null)
    await mounted.worker.deactivate()
  })
})

describe('the limit', () => {
  const rows = (count: number): Record<string, unknown>[] => Array.from({ length: count }, (_, index) => likeRecorded('0.14.0', `m-${String(index)}`))

  test('asks Archon for the limit given; a full page offers earlier messages, a short one does not', async () => {
    const full = await readRows('0.14.0', rows(100), { limit: 100 })
    assert.ok(full.stage.archon.calls.some((call) => call.url === messagesUrl(RECORDED['0.14.0'].id, 100)))
    assert.equal(ready(full.view).limit, 100)
    assert.equal(ready(full.view).earlier, true)
    assert.equal(ready(full.view).atArchonCap, false)
    const short = await readRows('0.14.0', rows(99), { limit: 100 })
    assert.equal(ready(short.view).earlier, false)
    assert.equal(ready(short.view).atArchonCap, false)
  })

  test("at Archon's 500 a full answer offers nothing earlier and says older messages cannot be fetched", async () => {
    const { view } = await readRows('0.14.0', rows(500), { limit: 500 })
    assert.equal(ready(view).earlier, false)
    assert.equal(ready(view).atArchonCap, true)
  })
})

describe('what the worker refuses', () => {
  test('a conversation id with anything but letters, digits, _ and -, and a limit that is not a multiple of 50 from 50 to 500, before asking Archon', async () => {
    const stage = threadScene('0.12.1')
    const mounted = await stage.mount({})
    const id = RECORDED['0.12.1'].id
    for (const input of [
      { conversationId: '../web-1', limit: 50 },
      { conversationId: 'web 1', limit: 50 },
      { conversationId: 'web/1', limit: 50 },
      { conversationId: '', limit: 50 },
      { conversationId: 'x'.repeat(201), limit: 50 },
      { conversationId: 5, limit: 50 },
      { conversationId: id },
      { conversationId: id, limit: 0 },
      { conversationId: id, limit: 75 },
      { conversationId: id, limit: 550 },
      { conversationId: id, limit: Number.NaN },
      { conversationId: id, limit: '50' },
      { conversationId: id, limit: 50, toolCalls: 'yes' },
      { conversationId: id, limit: 50, search: 'x' },
      'web-1'
    ]) {
      await assert.rejects(mounted.worker.request('chat.read', input as never))
    }
    assert.equal(stage.archon.calls.filter((call) => call.url.includes('/api/conversations')).length, 0)
    await mounted.worker.deactivate()
  })
})

describe('tool calls', () => {
  // The shape Archon's web adapter saves: name, input, duration and, once it ended, output.
  const toolCalls = [
    { name: 'Read', input: { file_path: 'src/a.ts' }, duration: 12, output: 'export const a = 1\n' },
    { name: 'Bash', input: { command: 'ls' }, duration: 40 }
  ]
  const withCalls = (): Record<string, unknown> =>
    likeRecorded('0.14.0', 'm-tools', { role: 'assistant', content: '', metadata: JSON.stringify({ toolCalls }) })

  test('are left out unless the request asks for them', async () => {
    const { view } = await readRows('0.14.0', [withCalls()])
    assert.equal(ready(view).messages[0]?.toolCalls, undefined)
  })

  test('when asked for, each has its name, its input as JSON text and its output, or null when none was saved', async () => {
    const { view } = await readRows('0.14.0', [withCalls()], { toolCalls: true })
    assert.deepEqual(ready(view).messages[0]?.toolCalls, {
      calls: [
        { id: 'm-tools-0', name: 'Read', input: '{\n  "file_path": "src/a.ts"\n}', inputNotShown: 0, output: 'export const a = 1\n', outputNotShown: 0 },
        { id: 'm-tools-1', name: 'Bash', input: '{\n  "command": "ls"\n}', inputNotShown: 0, output: null, outputNotShown: 0 }
      ],
      notShown: 0
    })
  })

  test('an output over 16 KiB is cut there with how much is not shown, and a message shows at most 50 calls', async () => {
    const many = Array.from({ length: 53 }, (_, index) => ({ name: `Tool${String(index)}`, input: {}, output: index === 0 ? 'x'.repeat(20_000) : 'ok' }))
    const { view } = await readRows('0.14.0', [likeRecorded('0.14.0', 'm-many', { role: 'assistant', content: '', metadata: { toolCalls: many } })], { toolCalls: true })
    const calls = ready(view).messages[0]?.toolCalls
    assert.equal(calls?.calls.length, 50)
    assert.equal(calls?.notShown, 3)
    assert.equal(calls?.calls[0]?.output?.length, 16 * 1024)
    assert.equal(calls?.calls[0]?.outputNotShown, 20_000 - 16 * 1024)
  })

  test('a tool call with no name makes its message unreadable', async () => {
    const { view } = await readRows('0.14.0', [likeRecorded('0.14.0', 'm-bad', { metadata: { toolCalls: [{ input: {} }] } })], { toolCalls: true })
    assert.equal(ready(view).messages.length, 0)
    assert.equal(ready(view).unreadable, 1)
  })
})

describe("the relay's limit on one answer", () => {
  test('fifty messages of 64 KiB fit no answer of 1 MiB: the newest are kept, the older ones are counted as cut, and nothing earlier is offered', async () => {
    const stage = threadScene('0.14.0')
    const id = RECORDED['0.14.0'].id
    // Oldest first, as Archon sends them: m-0 is the oldest.
    const rows = Array.from({ length: 50 }, (_, index) => likeRecorded('0.14.0', `m-${String(index)}`, { content: paragraphs(64) }))
    stage.archon.answer(messagesUrl(id), json(rows))
    const mounted = await stage.mount({})
    const answer = (await mounted.worker.request('chat.read', { conversationId: id, limit: 50 })) as ThreadAnswer
    // Within the relay's 1 MiB, and within the 512 KiB one render of the panel may draw.
    assert.ok(new TextEncoder().encode(JSON.stringify(answer)).length <= 512 * 1024)
    const thread = ready(answer.thread)
    assert.ok(thread.messages.length > 0 && thread.messages.length < 50)
    assert.equal(thread.messages[0]?.id, 'm-49')
    assert.equal(thread.cut, 50 - thread.messages.length)
    assert.equal(thread.messages.at(-1)?.id, `m-${String(thread.cut)}`)
    assert.equal(thread.earlier, false)
    await mounted.worker.deactivate()
  })

  test('five hundred messages of fifty tool calls each are cut to what one render of the panel can draw in its 5,000 nodes', async () => {
    const calls = Array.from({ length: 50 }, (_, index) => ({ name: `Tool${String(index)}`, input: { n: index }, output: 'ok' }))
    const rows = Array.from({ length: 500 }, (_, index) => likeRecorded('0.14.0', `m-${String(index)}`, { role: 'assistant', content: 'Done.', metadata: { toolCalls: calls } }))
    const { view } = await readRows('0.14.0', rows, { limit: 500, toolCalls: true })
    const thread = ready(view)
    // A drawn message takes at least four nodes and a drawn tool call at least five.
    const drawn = thread.messages.reduce((sum, message) => sum + 4 + 5 * (message.toolCalls?.calls.length ?? 0), 0)
    assert.ok(drawn <= 5_000, `${String(drawn)} nodes`)
    assert.equal(thread.messages[0]?.id, 'm-499')
    assert.equal(thread.cut, 500 - thread.messages.length)
    assert.equal(thread.atArchonCap, false)
  })

  test('a thread within the limit cuts nothing', async () => {
    const { view } = await readRows('0.14.0', Array.from({ length: 5 }, (_, index) => likeRecorded('0.14.0', `m-${String(index)}`, { content: paragraphs(64) })))
    assert.equal(ready(view).messages.length, 5)
    assert.equal(ready(view).cut, 0)
  })
})
