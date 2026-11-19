// The text cutter: cuts long text into blocks Orca can draw. Step output, artifacts and chat
// messages all go through it. It is pure logic: no host, no network, no disk.
//
// Every size here is a count of UTF-16 code units, a string's `length`. That is how Orca counts
// its limit for one text: 16,384 units draw and 16,385 are refused, whatever the characters.
//
// The cutter never rewrites text. Joined end to end, the blocks are the start of the input,
// apart from the lines `Block.addedBefore` and `Block.addedAfter` count.

/** Orca's limit for one text, and so the size of the largest block. */
export const BLOCK_LIMIT = 16 * 1024

/**
 * The longest fence opening line, or pair of table header rows, that is said again in the next
 * block. A longer one is cut as plain lines, so a block always has room for the input's own text.
 */
const CARRY_LIMIT = BLOCK_LIMIT / 4

export interface Block {
  /** One text for Orca to draw, at most `BLOCK_LIMIT` in size. */
  text: string
  /**
   * The size of the lines at the start of `text` that are not at this place in the input: a
   * fence's opening line or a table's header rows, said again. 0 in plain text.
   */
  addedBefore: number
  /**
   * The size of the lines at the end of `text` that are not in the input: the line that closes
   * a fence cut here. 0 in plain text.
   */
  addedAfter: number
}

export interface Cut {
  /** In the input's order. Empty when nothing is shown. */
  blocks: Block[]
  /** The size of the end of the input that is in no block. 0 when all of it is shown. */
  notShown: number
}

function checkSize(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a whole number of zero or more, not ${String(value)}`)
  }
  return value
}

/** `index`, or one less when a cut there would split a surrogate pair or a CR LF. */
function between(text: string, index: number): number {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  const pair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  return pair || (before === 13 && after === 10) ? index - 1 : index
}

/**
 * The start of `text`, at most `count` in size, for the one-line cuts. It never ends with half
 * of a surrogate pair or of a CR LF, so it can be one unit shorter than `count`. A text that
 * fits is returned unchanged.
 */
export function cutAt(text: string, count: number): string {
  checkSize(count, 'count')
  return text.length <= count ? text : text.slice(0, between(text, count))
}

/**
 * Cuts plain text into blocks. The blocks hold the start of the text up to `cap` in size, less
 * one unit when the cap falls inside a character or a CR LF. A block ends at the last line break
 * that fits it, the line break included; a block with no line break ends where it is full,
 * between two characters. Nothing is added to a block.
 */
export function cutText(text: string, cap: number): Cut {
  const end = between(text, Math.min(text.length, checkSize(cap, 'cap')))
  const blocks: Block[] = []
  let from = 0
  while (from < end) {
    let to = end
    if (end - from > BLOCK_LIMIT) {
      const full = between(text, from + BLOCK_LIMIT)
      const lineBreak = text.lastIndexOf('\n', full - 1)
      to = lineBreak >= from ? lineBreak + 1 : full
    }
    blocks.push({ text: text.slice(from, to), addedBefore: 0, addedAfter: 0 })
    from = to
  }
  return { blocks, notShown: text.length - end }
}

// ------------------------------------------------------------------------------ Markdown

/** A code fence that is open. `open` and `close` are whole lines, each with its line break. */
interface Fence {
  mark: string
  count: number
  open: string
  close: string
  lineBreak: string
}

/** One line of the input, line break included, with what a cut beside it would do. */
interface Line {
  start: number
  end: number
  /** How good a cut right before this line is: one of the ranks below. */
  rank: number
  /** The fence this line is inside, when a cut before it or within it has to close that fence. */
  fence: Fence | null
  /** The header rows of the table this line is a body row of. */
  head: string | null
  /** Room to keep after this line while it ends a block: its fence's closing line. */
  reserve: number
}

// Where a block may end, best first. A block ends at the last place of the best rank it holds.
/** After a blank line, before a line with no indent. */
const RANK_BLANK = 6
/** After a blank line, before an indented line: a cut here takes a nested line from its parent. */
const RANK_BLANK_NESTED = 5
/** At a line break before a line with no indent, when the block holds no blank line to cut at. */
const RANK_LINE = 4
/** Inside a fence or a table that no blank line let the block avoid: closed and opened again. */
const RANK_INSIDE = 3
/** At a line break before an indented line. */
const RANK_LINE_NESTED = 2
/** Where a cut leaves a fence with no code or a table with no rows, or parts the header rows. */
const RANK_EMPTY = 1

const FENCE_OPENING = /^([ \t]*)(`{3,}|~{3,})/
/** A line that ends a table without being blank: a fence, a heading or a quote. */
const TABLE_END = /^[ \t]*(`{3,}|~{3,}|#{1,6}([ \t]|$)|>)/
const DELIMITER_START = /^[ \t]*[|:-]/
const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/

/** The fence `line` opens, or null. `lineBreak` is the line's own line break. */
function fenceOpenedBy(line: string, lineBreak: string): Fence | null {
  const match = FENCE_OPENING.exec(line)
  if (match === null) return null
  const indent = match[1] ?? ''
  const marks = match[2] ?? ''
  const mark = marks.charAt(0)
  // A backtick fence has no backtick after its marks: that would be inline code.
  if (mark === '`' && line.includes('`', match[0].length)) return null
  if (line.length + lineBreak.length > CARRY_LIMIT) return null
  return { mark, count: marks.length, open: line + lineBreak, close: indent + marks + lineBreak, lineBreak }
}

function closesFence(line: string, fence: Fence): boolean {
  const marks = line.trim()
  if (marks.length < fence.count) return false
  for (let index = 0; index < marks.length; index++) {
    if (marks.charAt(index) !== fence.mark) return false
  }
  return true
}

/** The cells of a table row, or null when the line holds no cell separator. */
function cellsOf(row: string): string[] | null {
  const cells = row.trim().split(/(?<!\\)\|/)
  if (cells.length === 1) return null
  if (cells[0]?.trim() === '') cells.shift()
  if (cells.at(-1)?.trim() === '') cells.pop()
  return cells
}

/** Whether `header` and `delimiter` are the two header rows of a table. */
function startsTable(header: string, delimiter: string): boolean {
  if (!header.includes('|') || !DELIMITER_START.test(delimiter)) return false
  if (header.length + delimiter.length > CARRY_LIMIT) return false
  const columns = cellsOf(delimiter)
  if (columns === null || columns.length === 0 || !columns.every((cell) => DELIMITER_CELL.test(cell))) return false
  return cellsOf(header)?.length === columns.length
}

/** Where the line starting at `start` ends, its line break included. */
function lineEnd(text: string, start: number): number {
  const lineBreak = text.indexOf('\n', start)
  return lineBreak === -1 ? text.length : lineBreak + 1
}

/** Where the words of the line `[start, end)` end: before its line break. */
function wordsEnd(text: string, start: number, end: number): number {
  let stop = end
  if (stop > start && text.charCodeAt(stop - 1) === 10) stop--
  if (stop > start && text.charCodeAt(stop - 1) === 13) stop--
  return stop
}

/** The lines of `text` that start before `end`, each with its place among fences and tables. */
function* scan(text: string, end: number): Generator<Line> {
  let fence: Fence | null = null
  /** The previous line opened `fence`. */
  let fenceIsNew = false
  let head: string | null = null
  /** How many lines of the table `head` have been seen after its first. */
  let tableLines = 0
  let afterBlank = false

  for (let start = 0; start < end; ) {
    const stop = lineEnd(text, start)
    const words = text.slice(start, wordsEnd(text, start, stop))
    const line: Line = { start, end: stop, rank: RANK_LINE, fence: null, head: null, reserve: 0 }

    if (fence !== null) {
      const closing = closesFence(words, fence)
      line.fence = fence
      line.rank = fenceIsNew || closing ? RANK_EMPTY : RANK_INSIDE
      if (closing) fence = null
      else line.reserve = fence.close.length
      fenceIsNew = false
    } else {
      const blank = words.trim() === ''
      if (head !== null && (blank || TABLE_END.test(words))) head = null
      if (head !== null) {
        // The delimiter row, then the body rows.
        if (tableLines > 0) line.head = head
        line.rank = tableLines < 2 ? RANK_EMPTY : RANK_INSIDE
        tableLines++
      } else {
        const nested = words.startsWith(' ') || words.startsWith('\t')
        if (afterBlank) line.rank = nested ? RANK_BLANK_NESTED : RANK_BLANK
        else line.rank = nested ? RANK_LINE_NESTED : RANK_LINE
        fence = blank ? null : fenceOpenedBy(words, text.slice(start + words.length, stop) || '\n')
        if (fence !== null) {
          fenceIsNew = true
          line.reserve = fence.close.length
        } else if (!blank && stop < text.length) {
          const next = lineEnd(text, stop)
          // The delimiter row needs a line break of its own, or no row could follow the header.
          if (text.charCodeAt(next - 1) === 10 && startsTable(words, text.slice(stop, wordsEnd(text, stop, next)))) {
            head = text.slice(start, next)
            tableLines = 0
          }
        }
      }
      afterBlank = blank
    }

    yield line
    start = stop
  }
}

/**
 * Cuts Markdown into blocks, each of which draws by itself.
 *
 * A block ends after a blank line that is outside a code fence and outside a table: the last one
 * that fits it, and before a line with no indent when there is one. When a block holds no such
 * blank line it ends, in this order of choice:
 *
 * - at a line break before a line with no indent that is outside a fence and a table;
 * - inside a fence, which is closed there and opened again in the next block with its opening
 *   line, or inside a table, whose header rows start the next block;
 * - at any other line break.
 *
 * A fence is cut right after its opening line or right before its closing line, and a table
 * right after its header rows, only when the block holds no other place to end.
 *
 * A single line that no block can hold is cut where the block it starts in is full, between two
 * characters. Inside a fence, the fence is closed and opened again around that cut too.
 *
 * The blocks hold whole lines up to `cap` in size: the first line that does not fit under the
 * cap ends them. Only a line longer than a block, or the first line of the text, is cut at the
 * cap itself. A fence the cap ends is left open.
 */
export function cutMarkdown(text: string, cap: number): Cut {
  const end = Math.min(text.length, checkSize(cap, 'cap'))
  const blocks: Block[] = []
  /** The lines said again at the start of the block being built. */
  let carry = ''
  /** Where the block being built starts in the text, and its whole lines so far. */
  let from = 0
  let held: Line[] = []
  /** Lines to place again after a cut, last first. They come before the scanner's next line. */
  const again: Line[] = []
  const scanner = scan(text, end)
  const nextLine = (): Line | undefined => again.pop() ?? scanner.next().value

  const emit = (to: number, after: string): void => {
    blocks.push({ text: carry + text.slice(from, to) + after, addedBefore: carry.length, addedAfter: after.length })
    from = to
    held = []
  }

  for (let line = nextLine(); line !== undefined && line.start < end; line = nextLine()) {
    const size = carry.length + (line.end - from) + line.reserve
    if (line.end <= end && size <= BLOCK_LIMIT) {
      held.push(line)
      continue
    }
    // The line fits the block and only the cap is in its way: the blocks end before it.
    const capOnly = size <= BLOCK_LIMIT
    if (capOnly && (held.length > 0 || blocks.length > 0)) break

    const opened = line.fence?.open ?? line.head ?? ''
    if (capOnly || opened.length + (line.end - line.start) + line.reserve > BLOCK_LIMIT) {
      // No block holds this line whole, so it is cut where this block is full.
      const closing = line.fence === null ? '' : line.fence.lineBreak + line.fence.close
      const stop = between(text, Math.min(from + BLOCK_LIMIT - carry.length - closing.length, end))
      if (stop > line.start) {
        emit(stop, stop < end ? closing : '')
        carry = opened
        line.start = stop
        again.push(line)
        continue
      }
    }
    if (held.length === 0) break

    // The block ends before the held line of the best rank, or before this line.
    let at = held.length
    let target = line
    for (let index = held.length - 1; index > 0 && target.rank < RANK_BLANK; index--) {
      const candidate = held[index]
      if (candidate !== undefined && candidate.rank > target.rank) {
        at = index
        target = candidate
      }
    }
    again.push(line)
    for (let index = held.length - 1; index >= at; index--) again.push(held[index] as Line)
    emit(target.start, target.fence?.close ?? '')
    carry = target.fence?.open ?? target.head ?? ''
  }

  const last = held.at(-1)
  if (last !== undefined) emit(last.end, '')
  return { blocks, notShown: text.length - from }
}
