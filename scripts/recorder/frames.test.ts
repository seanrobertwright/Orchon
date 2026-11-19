// Stream frames: every frame the release sends is kept, whole and in order.
import { assert, describe, test } from 'orca/testing'
import { createFrameSplitter, parseFrame } from './frames.ts'

describe('stream frames', () => {
  test('reads the data of a frame as JSON when it is JSON', () => {
    assert.deepEqual(parseFrame('data: {"type":"conversation_lock","locked":true}'), {
      raw: 'data: {"type":"conversation_lock","locked":true}',
      data: { type: 'conversation_lock', locked: true }
    })
    assert.deepEqual(parseFrame('event: note\nid: 7\ndata: plain\ndata: text'), {
      raw: 'event: note\nid: 7\ndata: plain\ndata: text',
      event: 'note',
      id: '7',
      data: 'plain\ntext'
    })
  })

  test('keeps a keep-alive comment', () => {
    assert.deepEqual(parseFrame(': heartbeat'), { raw: ': heartbeat', comment: 'heartbeat' })
  })

  test('cuts frames at blank lines, across chunks and with either line ending', () => {
    const push = createFrameSplitter()
    assert.deepEqual(push('data: {"a"'), [])
    assert.deepEqual(
      push(':1}\n\ndata: 2\r\n\r\ndata: thr').map((frame) => frame.data),
      [{ a: 1 }, 2]
    )
    assert.deepEqual(
      push('ee\n\n').map((frame) => frame.data),
      ['three']
    )
    assert.deepEqual(push(''), [])
  })
})
