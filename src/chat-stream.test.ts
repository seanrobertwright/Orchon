// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded fixtures, with the conversation's stream held open and fed the frames Archon wrote
// during the recorded turn. These tests cover live chat: when the worker reads a conversation's
// stream, what it takes from the frames, the hints it posts, and how it gives the stream up.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  health,
  openStream,
  recorded,
  RELEASES,
  scene,
  type MountedScene,
  type Release,
  type Scene,
  type ScriptedStream
} from '../scripts/scripted-archon.ts'
import { field } from '../scripts/shape.ts'
import { readRepoText } from '../scripts/repo-files.ts'
import type { Thread, ThreadAnswer, ThreadView } from './chat-thread-view'
import type { ChatsAnswer } from './chats-view'

/** The one web conversation each release's recording holds, read off the fixtures by hand. */
const RECORDED_ID: Record<Release, string> = {
  '0.12.1': 'web-1795050072354-vqr978',
  '0.13.2': 'web-1795050191420-o7xrhr',
  '0.14.0': 'web-1795050310074-i0mt96'
}

const CODEBASES = `${DEFAULT}/api/codebases`
const conversationUrl = (id: string): string => `${DEFAULT}/api/conversations/${id}`
const messagesUrl = (id: string): string => `${DEFAULT}/api/conversations/${id}/messages?limit=50`
const streamUrl = (id: string): string => `${DEFAULT}/api/stream/${id}`

/**
 * The frames Archon wrote on the conversation's stream during the recorded turn (the message
 * that launched the recorded run), as one reader received them, in order.
 */
function recordedTurn(release: Release): string[] {
  const log = field(JSON.parse(readRepoText(`fixtures/${release}/launch-accepted.json`)), 'log') as Record<string, unknown>[]
  return log.filter((entry) => entry['kind'] === 'frame' && entry['label'] === 'first').map((entry) => `${String(entry['raw'])}\n\n`)
}

/** The recorded turn's frames up to and including the first one whose data holds `marker`. */
function until(frames: string[], marker: string): string[] {
  const index = frames.findIndex((frame) => frame.includes(marker))
  if (index < 0) throw new Error(`No recorded frame holds ${marker}.`)
  return frames.slice(0, index + 1)
}

/** A frame as Archon's `WebAdapter` writes it, for the frames no recording holds. */
const frame = (data: Record<string, unknown>): string => `data: ${JSON.stringify(data)}\n\n`

/** A release's Archon answering its recorded conversation, its messages and its projects, with its stream held open. */
function chatScene(release: Release): { stage: Scene; id: string; streams: ScriptedStream[] } {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: release }))
  const id = RECORDED_ID[release]
  stage.archon.answer(conversationUrl(id), recorded(release, 'conversations', 2))
  stage.archon.answer(messagesUrl(id), recorded(release, 'conversations', 3))
  stage.archon.answer(CODEBASES, recorded(release, 'codebases', 1))
  const streams: ScriptedStream[] = []
  // Each open of the stream takes a fresh answer, as each reader gets its own body.
  stage.archon.answer(streamUrl(id), () => {
    const stream = openStream()
    streams.push(stream)
    return stream
  })
  return { stage, id, streams }
}

async function readThread(mounted: MountedScene, conversationId: string, open = false): Promise<Thread> {
  const answer = (await mounted.worker.request('chat.read', { conversationId, limit: 50, ...(open ? { open: true } : {}) } as never)) as ThreadAnswer
  return ready(answer.thread)
}

const ready = (view: ThreadView): Thread => {
  if (view.kind !== 'ready') throw new Error(`The thread is ${view.kind}${view.kind === 'failed' ? `: ${view.message}` : ''}.`)
  return view.thread
}

/** Every chat hint the worker posted, in order. */
const hints = (mounted: MountedScene): unknown[] => mounted.worker.posts.filter((post) => post.event === 'chat.changed').map((post) => post.payload)

const opens = (stage: Scene, id: string): number => stage.archon.streams.filter((call) => call.url === streamUrl(id)).length

describe("a thread on screen reads its conversation's stream", () => {
  for (const release of RELEASES) {
    test(`${release}: the recorded turn's lock frames say busy, then not`, async () => {
      const { stage, id, streams } = chatScene(release)
      const mounted = await stage.mount()
      const first = await readThread(mounted, id, true)
      // No lock frame yet: the worker knows nothing, and the panel infers.
      assert.equal(first.live, undefined)
      assert.equal(opens(stage, id), 1)
      const turn = recordedTurn(release)
      const locked = until(turn, '"locked":true').length
      for (const text of turn.slice(0, locked)) streams[0]?.send(text)
      await stage.clock.advance(100)
      assert.deepEqual((await readThread(mounted, id)).live, { busy: true, tool: null })
      for (const text of turn.slice(locked, until(turn, '"locked":false').length)) streams[0]?.send(text)
      await stage.clock.advance(100)
      assert.deepEqual((await readThread(mounted, id)).live, { busy: false, tool: null })
      // One reader all along.
      assert.equal(opens(stage, id), 1)
      await mounted.worker.deactivate()
      assert.equal(streams[0]?.closed, true)
    })
  }
})

describe('what the worker takes from the frames', () => {
  test("a tool call names the tool the agent is using until its result; a frame's other fields are never taken", async () => {
    const { stage, id, streams } = chatScene('0.14.0')
    const mounted = await stage.mount()
    await readThread(mounted, id, true)
    const turn = recordedTurn('0.14.0')
    for (const text of until(turn, '"locked":true')) streams[0]?.send(text)
    streams[0]?.send(frame({ type: 'tool_call', toolCallId: 'call-1', name: 'Bash', input: { command: 'cat secret-reply.txt' }, timestamp: 1 }))
    await stage.clock.advance(100)
    const working = await readThread(mounted, id)
    assert.deepEqual(working.live, { busy: true, tool: 'Bash' })
    assert.ok(!JSON.stringify(working).includes('secret-reply'))
    streams[0]?.send(frame({ type: 'tool_result', toolCallId: 'call-1', name: 'Bash', output: 'the reply so far', status: 'completed', duration: 3, timestamp: 2 }))
    await stage.clock.advance(100)
    const after = await readThread(mounted, id)
    assert.deepEqual(after.live, { busy: true, tool: null })
    assert.ok(!JSON.stringify(after).includes('the reply so far'))
    await mounted.worker.deactivate()
  })

  for (const release of RELEASES) {
    test(`${release}: each frame read posts a hint naming only the conversation, at most one a second`, async () => {
      const { stage, id, streams } = chatScene(release)
      const mounted = await stage.mount()
      await readThread(mounted, id, true)
      for (const text of recordedTurn(release)) streams[0]?.send(text)
      await stage.clock.advance(100)
      assert.deepEqual(hints(mounted), [{ conversationId: id }])
      await stage.clock.advance(1_000)
      // The rest of the turn's frames arrived within the second, so they make one hint more.
      assert.deepEqual(hints(mounted), [{ conversationId: id }, { conversationId: id }])
      await stage.clock.advance(10_000)
      assert.equal(hints(mounted).length, 2)
      assert.deepEqual((await readThread(mounted, id)).live, { busy: false, tool: null })
      await mounted.worker.deactivate()
    })

    test(`${release}: heartbeats, the dispatch and the run frames of the recorded turn post no hint`, async () => {
      const { stage, id, streams } = chatScene(release)
      const mounted = await stage.mount()
      await readThread(mounted, id, true)
      const ignored = recordedTurn(release).filter((text) => /"type":"(heartbeat|workflow_dispatch|workflow_status|dag_node)"/.test(text))
      assert.ok(ignored.length >= 4)
      for (const text of ignored) streams[0]?.send(text)
      streams[0]?.send(frame({ type: 'thinking', content: 'hm', timestamp: 1 }))
      await stage.clock.advance(5_000)
      assert.deepEqual(hints(mounted), [])
      assert.equal((await readThread(mounted, id)).live, undefined)
      await mounted.worker.deactivate()
    })
  }
})

describe('how long the worker holds the stream', () => {
  test("the panel's reads are the lease: 60 seconds without one lets the stream go, and the next read opens it again", async () => {
    const { stage, id, streams } = chatScene('0.14.0')
    const mounted = await stage.mount()
    await readThread(mounted, id, true)
    // A read every 30 seconds, as a thread on screen and not busy makes, keeps the one stream.
    for (let read = 0; read < 4; read += 1) {
      await stage.clock.advance(30_000)
      await readThread(mounted, id)
    }
    assert.equal(opens(stage, id), 1)
    assert.equal(streams[0]?.closed, false)
    await stage.clock.advance(59_000)
    assert.equal(streams[0]?.closed, false)
    await stage.clock.advance(1_000)
    assert.equal(streams[0]?.closed, true)
    await readThread(mounted, id)
    assert.equal(opens(stage, id), 2)
    await mounted.worker.deactivate()
    assert.equal(streams[1]?.closed, true)
  })

  test('a read of the chat list holds no stream', async () => {
    const { stage, id } = chatScene('0.14.0')
    stage.archon.answer(`${DEFAULT}/api/conversations?platform=web`, recorded('0.14.0', 'conversations', 0))
    const mounted = await stage.mount()
    await mounted.worker.request('chats.read', {})
    await stage.clock.advance(100)
    assert.equal(opens(stage, id), 0)
    await mounted.worker.deactivate()
  })
})

describe('when the stream ends', () => {
  for (const release of RELEASES) {
    test(`${release}: displaced by another reader, as recorded, it is not opened again until the thread is, and the tool name is lost`, async () => {
      const { stage, id, streams } = chatScene(release)
      const mounted = await stage.mount()
      await readThread(mounted, id, true)
      const turn = recordedTurn(release)
      for (const text of until(turn, '"locked":true')) streams[0]?.send(text)
      streams[0]?.send(frame({ type: 'tool_call', toolCallId: 'call-1', name: 'Read', input: {}, timestamp: 1 }))
      await stage.clock.advance(1_000)
      assert.deepEqual((await readThread(mounted, id)).live, { busy: true, tool: 'Read' })
      const before = hints(mounted).length
      // The recording: the server ends the first reader's body when a second reader opens.
      streams[0]?.end()
      await stage.clock.advance(1_000)
      assert.equal(hints(mounted).length, before + 1)
      // The thread keeps refreshing on its timers, and the panel infers busy again.
      for (let read = 0; read < 3; read += 1) {
        assert.equal((await readThread(mounted, id)).live, undefined)
        await stage.clock.advance(3_000)
      }
      await stage.clock.advance(60_000)
      assert.equal(opens(stage, id), 1)
      await readThread(mounted, id, true)
      assert.equal(opens(stage, id), 2)
      await mounted.worker.deactivate()
    })
  }

  test("after a network error it reconnects on the dashboard stream's backoff, 1 second doubling to 30, started over once a frame comes", async () => {
    const { stage, id, streams } = chatScene('0.14.0')
    const mounted = await stage.mount()
    await readThread(mounted, id, true)
    const gaps: number[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const count = opens(stage, id)
      streams.at(-1)?.break()
      await stage.clock.advance(0)
      let waited = 0
      while (opens(stage, id) === count && waited < 40_000) {
        await stage.clock.advance(500)
        waited += 500
      }
      gaps.push(waited)
      // The lease is kept while it waits.
      await readThread(mounted, id)
    }
    assert.deepEqual(gaps, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    streams.at(-1)?.send(until(recordedTurn('0.14.0'), '"locked":true').at(-1) ?? '')
    await stage.clock.advance(100)
    const count = opens(stage, id)
    streams.at(-1)?.break()
    await stage.clock.advance(1_000)
    assert.equal(opens(stage, id), count + 1)
    await mounted.worker.deactivate()
  })

  test('a stream that cannot open because nothing listens is tried again on the same backoff', async () => {
    const { stage, id } = chatScene('0.14.0')
    stage.archon.answer(streamUrl(id), { kind: 'refuse' })
    const mounted = await stage.mount()
    await readThread(mounted, id, true)
    await stage.clock.advance(100)
    assert.equal(opens(stage, id), 1)
    await stage.clock.advance(1_000)
    assert.equal(opens(stage, id), 2)
    // The second wait is 2 seconds from the second open, 1.1 seconds in.
    await stage.clock.advance(1_899)
    assert.equal(opens(stage, id), 2)
    await stage.clock.advance(1)
    assert.equal(opens(stage, id), 3)
    // Deactivating with a reconnect and the lease waiting leaves no timer behind.
    await mounted.worker.deactivate()
    assert.deepEqual(stage.clock.waiting(), [])
    await stage.clock.advance(120_000)
    assert.equal(opens(stage, id), 3)
  })
})

describe('the chat list', () => {
  for (const release of RELEASES) {
    test(`${release}: a row says Working while the stream says the conversation is busy, and nothing once it is not`, async () => {
      const { stage, id, streams } = chatScene(release)
      stage.archon.answer(`${DEFAULT}/api/conversations?platform=web`, recorded(release, 'conversations', 0))
      const mounted = await stage.mount()
      const rowOf = async (): Promise<Record<string, unknown> | undefined> => {
        const answer = (await mounted.worker.request('chats.read', {})) as ChatsAnswer
        if (answer.chats.kind !== 'ready') throw new Error(answer.chats.kind)
        return answer.chats.rows.find((row) => row.id === id)
      }
      assert.equal(Object.hasOwn((await rowOf()) ?? {}, 'working'), false)
      await readThread(mounted, id, true)
      const turn = recordedTurn(release)
      const locked = until(turn, '"locked":true').length
      for (const text of turn.slice(0, locked)) streams[0]?.send(text)
      await stage.clock.advance(100)
      assert.equal((await rowOf())?.['working'], true)
      for (const text of turn.slice(locked, until(turn, '"locked":false').length)) streams[0]?.send(text)
      await stage.clock.advance(100)
      assert.equal(Object.hasOwn((await rowOf()) ?? {}, 'working'), false)
      await mounted.worker.deactivate()
    })
  }
})

describe('how many streams chat holds', () => {
  test('at most 5: a sixth thread on screen runs on polling alone', async () => {
    const stage = scene()
    stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
    const ids = Array.from({ length: 6 }, (_, index) => `web-chat-${String(index)}`)
    for (const id of ids) {
      stage.archon.answer(conversationUrl(id), recorded('0.14.0', 'conversations', 2))
      stage.archon.answer(messagesUrl(id), recorded('0.14.0', 'conversations', 3))
      stage.archon.answer(streamUrl(id), openStream())
    }
    stage.archon.answer(CODEBASES, recorded('0.14.0', 'codebases', 1))
    const mounted = await stage.mount()
    for (const id of ids) await mounted.worker.request('chat.read', { conversationId: id, limit: 50, open: true } as never)
    await stage.clock.advance(100)
    assert.deepEqual(
      ids.map((id) => opens(stage, id)),
      [1, 1, 1, 1, 1, 0]
    )
    await mounted.worker.deactivate()
  })
})
