// Pure logic: the frame parser that reads Archon's dashboard stream by hand from the text of the
// `fetch` body, and the reading of one frame's data. Frames are scripted the way Archon's
// `streamSSE` writes them: a `data:` line of JSON and a blank line.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import { createFrameParser, FRAME_CAP_CHARS, readConversationFrame, readDashboardFrame, type StreamFrame } from './stream-frames'

/** Pushes every chunk in order and returns every frame they completed, or null on an overflow. */
function parseAll(chunks: readonly string[]): StreamFrame[] | null {
  const parser = createFrameParser()
  const frames: StreamFrame[] = []
  for (const chunk of chunks) {
    const done = parser.push(chunk)
    if (done === null) return null
    frames.push(...done)
  }
  return frames
}

describe('the frame parser', () => {
  test('reads one frame per blank line, each with its data', () => {
    assert.deepEqual(parseAll(['data: {"type":"heartbeat"}\n\ndata: {"type":"dag_node"}\n\n']), [
      { event: 'message', data: '{"type":"heartbeat"}' },
      { event: 'message', data: '{"type":"dag_node"}' }
    ])
  })

  test('holds a frame split across chunks until its blank line arrives', () => {
    const parser = createFrameParser()
    assert.deepEqual(parser.push('da'), [])
    assert.deepEqual(parser.push('ta: {"type":'), [])
    assert.deepEqual(parser.push('"workflow_status"}\n'), [])
    assert.deepEqual(parser.push('\n'), [{ event: 'message', data: '{"type":"workflow_status"}' }])
  })

  test('takes a CRLF split between two chunks as one line ending', () => {
    assert.deepEqual(parseAll(['data: a\r', '\n\r', '\n']), [{ event: 'message', data: 'a' }])
    assert.deepEqual(parseAll(['data: a\r\r']), [{ event: 'message', data: 'a' }])
  })

  test('skips comment lines, and a comment alone makes no frame', () => {
    assert.deepEqual(parseAll([': keep-alive\n\n: another\ndata: x\n: inside\n\n']), [{ event: 'message', data: 'x' }])
  })

  test('joins the lines of multi-line data with line feeds', () => {
    assert.deepEqual(parseAll(['data: first\ndata:second\ndata:  third\n\n']), [
      { event: 'message', data: 'first\nsecond\n third' }
    ])
  })

  test('keeps the event name, ignores id, retry and unknown fields, and drops a frame with no data', () => {
    assert.deepEqual(parseAll(['event: update\nid: 7\nretry: 10\nwhat: ever\ndata: x\n\nevent: empty\n\n']), [
      { event: 'update', data: 'x' }
    ])
  })

  test('a field with no colon is a field with an empty value', () => {
    assert.deepEqual(parseAll(['data\ndata\n\n']), [{ event: 'message', data: '\n' }])
  })

  test('refuses a frame that grows past its cap', () => {
    assert.equal(parseAll([`data: ${'x'.repeat(FRAME_CAP_CHARS)}`]), null)
    // Many short data lines that never end their frame pass the cap together.
    const line = `data: ${'x'.repeat(1_023)}\n`
    assert.equal(parseAll(Array.from({ length: FRAME_CAP_CHARS / 1_024 + 1 }, () => line)), null)
    // A frame that ends in time is read, and what was held starts over.
    assert.equal(parseAll([line.repeat(10), '\n', line.repeat(FRAME_CAP_CHARS / 1_024 - 1), '\n'])?.length, 2)
  })
})

describe('reading a dashboard frame', () => {
  const frame = (data: string): StreamFrame => ({ event: 'message', data })

  test('reads the type and run id of the two frames that matter', () => {
    assert.deepEqual(readDashboardFrame(frame('{"type":"workflow_status","runId":"run-1","status":"paused"}')), {
      type: 'workflow_status',
      runId: 'run-1'
    })
    assert.deepEqual(readDashboardFrame(frame('{"type":"dag_node","runId":"run-2","nodeId":"n"}')), {
      type: 'dag_node',
      runId: 'run-2'
    })
  })

  test('ignores every other frame type, a heartbeat included', () => {
    for (const type of ['heartbeat', 'workflow_tool_activity', 'container_lifecycle', 'text']) {
      assert.equal(readDashboardFrame(frame(JSON.stringify({ type, runId: 'run-1' }))), null)
    }
  })

  test('ignores data that is not JSON, not an object, or has no usable run id', () => {
    const refused = [
      'not json',
      '[]',
      'null',
      '"workflow_status"',
      '{"type":"workflow_status"}',
      '{"type":"workflow_status","runId":""}',
      '{"type":"workflow_status","runId":7}',
      `{"type":"workflow_status","runId":"${'r'.repeat(201)}"}`,
      '{"runId":"run-1"}'
    ]
    for (const data of refused) assert.equal(readDashboardFrame(frame(data)), null, data)
  })

  test('reads only fields of its own, never inherited ones', () => {
    assert.equal(readDashboardFrame(frame('{"__proto__":{"type":"dag_node","runId":"run-1"}}')), null)
  })
})

describe('reading a conversation frame', () => {
  /** Each recorded frame of the launch conversation in the 0.12.1 recording of an accepted launch, as Archon wrote it. */
  const recordedFrames = (): string[] => {
    const log = JSON.parse(readRepoText('fixtures/0.12.1/launch-accepted.json')) as { log: { kind: string; label?: string; raw?: string }[] }
    return log.log.filter((entry) => entry.kind === 'frame' && entry.label === 'first').map((entry) => entry.raw ?? '')
  }
  const read = (raw: string): ReturnType<typeof readConversationFrame> => readConversationFrame({ event: 'message', data: raw.replace(/^data: /, '') })

  test('reads the lock, the text and the dispatch frames of a recorded launch, in order', () => {
    assert.deepEqual(recordedFrames().map(read).slice(0, 6), [
      null,
      { type: 'lock', locked: true },
      { type: 'text', content: 'Starting workflow: `orchon-recorder-echo`', category: null },
      { type: 'text', content: '\u{1F680} Dispatching workflow: **orchon-recorder-echo** (background)', category: 'workflow_dispatch_status' },
      { type: 'workflow_dispatch' },
      { type: 'lock', locked: false }
    ])
  })

  test("reads an error frame's message, and ignores anything it does not expect", () => {
    assert.deepEqual(read(JSON.stringify({ type: 'error', message: 'Failed to process message: boom.', classification: 'transient' })), { type: 'error', message: 'Failed to process message: boom.' })
    assert.deepEqual(read(JSON.stringify({ type: 'error' })), { type: 'error', message: '' })
    for (const data of ['not json', '[]', '{"type":"text","content":3}', '{"type":"conversation_lock","locked":"yes"}', '{"type":"tool_call"}']) {
      assert.equal(read(data), null, data)
    }
    // A type only inherited is no type.
    assert.equal(read('{"__proto__":{"type":"workflow_dispatch"}}'), null)
  })

  // The shapes `WebAdapter` writes in Archon 0.12.1 (`packages/server/src/adapters/web.ts` and
  // `web/persistence.ts`); no recording holds a tool call, a tool result or a warning.
  test("reads a tool call for its tool's name alone, a tool result and a warning for their type alone", () => {
    const call = { type: 'tool_call', toolCallId: 'call-1', name: 'Bash', input: { command: 'ls' }, timestamp: 1 }
    assert.deepEqual(read(JSON.stringify(call)), { type: 'tool_call', name: 'Bash' })
    const result = { type: 'tool_result', toolCallId: 'call-1', name: 'Bash', output: 'README.md', status: 'completed', duration: 4, timestamp: 2 }
    assert.deepEqual(read(JSON.stringify(result)), { type: 'tool_result' })
    assert.deepEqual(read(JSON.stringify({ type: 'warning', message: 'Assistant response could not be saved to history', timestamp: 3 })), { type: 'warning' })
    for (const data of ['{"type":"tool_call","name":""}', '{"type":"tool_call","name":7}', '{"type":"thinking","content":"hm"}']) {
      assert.equal(read(data), null, data)
    }
  })
})
