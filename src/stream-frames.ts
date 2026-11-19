// The frame parser: reads Server-Sent Events by hand from the text of a `fetch` body, since the
// worker has no `EventSource`, and reads the data of one dashboard frame. It is pure logic.
import { isRecord, own } from './records'

/** One dispatched event: its name (`message` unless the stream named one) and its data lines joined. */
export type StreamFrame = { event: string; data: string }

/** The longest frame, or line, the parser holds before it refuses the stream. */
export const FRAME_CAP_CHARS = 1024 * 1024

export type FrameParser = {
  /** Takes the next piece of text and returns the frames it completed, or null once the cap is passed. */
  push(text: string): StreamFrame[] | null
}

export function createFrameParser(): FrameParser {
  /** The part of the last line that has not ended yet. */
  let pending = ''
  /** The text ended on a CR, so a LF that starts the next piece ends nothing. */
  let afterCr = false
  let event = ''
  let data: string[] = []
  let held = 0

  function line(text: string, frames: StreamFrame[]): void {
    if (text === '') {
      if (data.length > 0) frames.push({ event: event === '' ? 'message' : event, data: data.join('\n') })
      event = ''
      data = []
      held = 0
      return
    }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const name = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? '' : text.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'data') {
      data.push(value)
      held += value.length + 1
    } else if (name === 'event') {
      event = value
    }
    // `id`, `retry` and any other field change nothing the plugin reads.
  }

  return {
    push(text) {
      const frames: StreamFrame[] = []
      let start = afterCr && text.startsWith('\n') ? 1 : 0
      afterCr = false
      for (let index = start; index < text.length; index += 1) {
        const char = text[index]
        if (char !== '\r' && char !== '\n') continue
        line(pending + text.slice(start, index), frames)
        pending = ''
        if (char === '\r') {
          if (index === text.length - 1) afterCr = true
          else if (text[index + 1] === '\n') index += 1
        }
        start = index + 1
      }
      pending += text.slice(start)
      if (pending.length + held > FRAME_CAP_CHARS) return null
      return frames
    }
  }
}

/** The two dashboard frames the plugin acts on, the same two Archon's console acts on. */
export const HINT_TYPES = ['workflow_status', 'dag_node'] as const
export type HintType = (typeof HINT_TYPES)[number]

/** The longest run id the plugin takes from a frame. */
const RUN_ID_CAP = 200

/** What one dashboard frame says changed, or null for any frame the plugin does not act on. */
export function readDashboardFrame(frame: StreamFrame): { type: HintType; runId: string } | null {
  let value: unknown
  try {
    value = JSON.parse(frame.data)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const type = HINT_TYPES.find((known) => known === own(value, 'type'))
  const runId = own(value, 'runId')
  if (type === undefined || typeof runId !== 'string' || runId === '' || runId.length > RUN_ID_CAP) return null
  return { type, runId }
}
