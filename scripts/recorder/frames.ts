// Server-sent event frames, split and read as the release sent them.

export interface Frame {
  /** The frame as sent, without the blank line that ends it. */
  raw: string
  event?: string
  id?: string
  /** A line that starts with a colon: Archon's keep-alive. */
  comment?: string
  /** The `data` lines joined, parsed as JSON when they are JSON. */
  data?: unknown
}

/** One frame's fields. */
export function parseFrame(raw: string): Frame {
  const frame: Frame = { raw }
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim()
      continue
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data.push(value)
    else if (field === 'event') frame.event = value
    else if (field === 'id') frame.id = value
  }
  if (data.length > 0) {
    const text = data.join('\n')
    try {
      frame.data = JSON.parse(text) as unknown
    } catch {
      frame.data = text
    }
  }
  return frame
}

/** Cuts a stream into frames as its text arrives. A frame ends at a blank line. */
export function createFrameSplitter(): (chunk: string) => Frame[] {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    const frames: Frame[] = []
    for (;;) {
      const end = /\r?\n\r?\n/.exec(buffer)
      if (end === null) return frames
      frames.push(parseFrame(buffer.slice(0, end.index)))
      buffer = buffer.slice(end.index + end[0].length)
    }
  }
}
