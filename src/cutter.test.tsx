// The pure logic seam for the text cutter: src/cutter.ts driven through its exports. One test
// draws blocks with Orca's runtime, to hold the block size to the way Orca measures one text.
import { Code, Text } from 'orca'
import { assert, mount, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import { BLOCK_LIMIT, cutAt, cutMarkdown, cutText, type Cut } from './cutter'

const KIB = 1024
/** A character outside the Basic Multilingual Plane: one character, two units of a string's length. */
const ASTRAL = '\u{1F600}'

/** `count` lines of `width` characters, line break included, each starting with `word`. */
function lines(count: number, width: number, word = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${word} ${index} `.padEnd(width - 1, 'x') + '\n').join('')
}

/** `size` of hard-wrapped paragraphs of four lines, each followed by a blank line. */
function paragraphs(size: number, word = 'prose'): string {
  let text = ''
  for (let index = 0; text.length < size; index++) text += `${lines(4, 90, `${word}${index}`)}\n`
  return text
}

/** The input's own text in each block: the block without the lines the cutter added. */
function own(cut: Cut): string[] {
  return cut.blocks.map((block) => block.text.slice(block.addedBefore, block.text.length - block.addedAfter))
}

function texts(cut: Cut): string[] {
  return cut.blocks.map((block) => block.text)
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Whether a cut at `index` would fall between the two halves of one character or of a CR LF. */
function splits(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return (isHigh(before) && isLow(after)) || (before === 13 && after === 10)
}

/**
 * What holds for every cut: no block is empty or over the limit, the blocks' own text joined is
 * the start of the input, the rest is counted as not shown, and no cut splits a character or a
 * CR LF.
 */
function assertSound(input: string, cut: Cut): void {
  let at = 0
  for (const [index, block] of cut.blocks.entries()) {
    assert.ok(block.text.length > 0, `block ${index} is empty`)
    assert.ok(block.text.length <= BLOCK_LIMIT, `block ${index} is ${block.text.length} long`)
    assert.ok(block.addedBefore >= 0 && block.addedAfter >= 0, `block ${index} added a negative size`)
    assert.ok(block.addedBefore + block.addedAfter < block.text.length, `block ${index} holds none of the input`)
    assert.ok(!splits(input, at), `block ${index} starts inside a character`)
    at += block.text.length - block.addedBefore - block.addedAfter
  }
  assert.ok(!splits(input, at), 'the last block ends inside a character')
  assert.equal(own(cut).join(''), input.slice(0, at))
  assert.equal(cut.notShown, input.length - at)
}

function isRangeError(error: unknown): boolean {
  return error instanceof RangeError
}

/** Whether every fence a block opens is closed in that block, for fences of three backticks. */
function fencesBalanced(block: string): boolean {
  return block.split('\n').filter((line) => line.startsWith('```')).length % 2 === 0
}

// ------------------------------------------------------------------------------ one-line cuts

test('cutAt returns a text that is short enough unchanged', () => {
  assert.equal(cutAt('', 5), '')
  assert.equal(cutAt('hello', 5), 'hello')
  assert.equal(cutAt(`a${ASTRAL}`, 3), `a${ASTRAL}`)
})

test('cutAt cuts at the count', () => {
  assert.equal(cutAt('hello world', 5), 'hello')
  assert.equal(cutAt('hello', 0), '')
  assert.equal(cutAt(`${ASTRAL}${ASTRAL}${ASTRAL}`, 4), `${ASTRAL}${ASTRAL}`)
})

test('cutAt never leaves half of a surrogate pair', () => {
  assert.equal(cutAt(`ab${ASTRAL}cd`, 3), 'ab')
  assert.equal(cutAt(`${ASTRAL}${ASTRAL}`, 3), ASTRAL)
  assert.equal(cutAt(`${ASTRAL}${ASTRAL}`, 1), '')
})

test('cutAt refuses a count that is not a whole number of zero or more', () => {
  for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => cutAt('hello', count), isRangeError)
  }
})

// ------------------------------------------------------------------------------ plain text

test('cutText keeps a text that fits one block whole', () => {
  assert.deepEqual(cutText('', 256 * KIB), { blocks: [], notShown: 0 })
  const short = 'one\ntwo\n'
  assert.deepEqual(cutText(short, 256 * KIB), {
    blocks: [{ text: short, addedBefore: 0, addedAfter: 0 }],
    notShown: 0
  })
  const full = lines(128, 128)
  assert.equal(full.length, BLOCK_LIMIT)
  assert.deepEqual(texts(cutText(full, 256 * KIB)), [full])
})

test('cutText cuts at the last line break that fits a block', () => {
  const input = lines(400, 100)
  const cut = cutText(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, 0)
  assert.equal(cut.blocks.length, 3)
  for (const block of texts(cut).slice(0, -1)) {
    assert.ok(block.endsWith('\n'), 'a block ends at a line break')
    assert.ok(block.length + 100 > BLOCK_LIMIT, 'a block holds every line that fits')
  }
  assert.deepEqual(cut.blocks.map((block) => block.addedBefore + block.addedAfter), [0, 0, 0])
})

test('cutText keeps a carriage return with its line feed', () => {
  const input = lines(400, 99).replaceAll('\n', '\r\n')
  const cut = cutText(input, 256 * KIB)
  assertSound(input, cut)
  for (const block of texts(cut)) {
    assert.ok(block.endsWith('\r\n'))
    assert.ok(!block.startsWith('\n'))
  }
  // A line that has to be cut where the block ends is not cut between the two either.
  const long = `${'a'.repeat(BLOCK_LIMIT - 1)}\r\nb`
  assert.deepEqual(texts(cutText(long, 256 * KIB)), ['a'.repeat(BLOCK_LIMIT - 1), '\r\nb'])
})

test('cutText cuts a single line longer than a block where the block ends, between characters', () => {
  // The pair lies across every block's last unit, so each cut has to step back by one.
  const input = `a${ASTRAL.repeat(BLOCK_LIMIT)}\nlast line\n`
  const cut = cutText(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, 0)
  assert.deepEqual(
    texts(cut).map((block) => block.length),
    [BLOCK_LIMIT - 1, BLOCK_LIMIT, 13]
  )
})

test('cutText shows the start of the text up to the cap and counts the rest', () => {
  const input = lines(3000, 100)
  const cut = cutText(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(own(cut).join(''), input.slice(0, 256 * KIB))
  assert.equal(cut.notShown, input.length - 256 * KIB)
  assert.equal(cut.blocks.length, 17)
})

test('cutText with a cap under one block gives one block', () => {
  const input = `ok\n${'x'.repeat(40 * KIB)}\n`
  assert.deepEqual(texts(cutText(input, 4 * KIB)), [input.slice(0, 4 * KIB)])
  assert.deepEqual(texts(cutText(input, BLOCK_LIMIT)), [input.slice(0, BLOCK_LIMIT)])
  assert.deepEqual(cutText(input, 0), { blocks: [], notShown: input.length })
})

test('cutText never splits a character at the cap', () => {
  const input = `a${ASTRAL.repeat(10)}`
  const cut = cutText(input, 4)
  assertSound(input, cut)
  assert.deepEqual(texts(cut), [`a${ASTRAL}`])
  assert.equal(cut.notShown, 18)
})

test('a cap that is not a whole number of zero or more is refused', () => {
  for (const cap of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => cutText('text', cap), isRangeError)
    assert.throws(() => cutMarkdown('text', cap), isRangeError)
  }
})

test('a block is as large as Orca lets one text be, counted the way Orca counts it', async () => {
  // Three bytes of UTF-8 and one unit each, then two units each: Orca counts units.
  const input = `${'中'.repeat(BLOCK_LIMIT)}${ASTRAL.repeat(BLOCK_LIMIT)}`
  const cut = cutText(input, 256 * KIB)
  assertSound(input, cut)
  assert.deepEqual(
    texts(cut).map((block) => block.length),
    [BLOCK_LIMIT, BLOCK_LIMIT, BLOCK_LIMIT]
  )
  for (const block of texts(cut)) {
    const drawn = await mount(() => <Code block>{block}</Code>)
    assert.deepEqual(drawn.errors, [])
    await drawn.unmount()
  }

  // One unit more is refused, so the limit is not looser than Orca's.
  const over = await mount(() => <Text>{`${texts(cut)[0]}a`}</Text>)
  assert.deepEqual(
    over.errors.map((issue) => issue.kind),
    ['refused']
  )
  await over.unmount()
})

// ------------------------------------------------------------------------------ Markdown

test('cutMarkdown keeps a text that fits one block whole', () => {
  assert.deepEqual(cutMarkdown('', 256 * KIB), { blocks: [], notShown: 0 })
  const short = '# Title\n\nText.\n\n```ts\ncode\n```\n'
  assert.deepEqual(cutMarkdown(short, 256 * KIB), {
    blocks: [{ text: short, addedBefore: 0, addedAfter: 0 }],
    notShown: 0
  })
})

test('cutMarkdown cuts at the last blank line that fits a block', () => {
  const input = paragraphs(40 * KIB)
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, 0)
  assert.equal(cut.blocks.length, 3)
  for (const block of cut.blocks.slice(0, -1)) {
    assert.ok(block.text.endsWith('\n\n'), 'a block ends at a blank line')
    assert.ok(block.text.length + 361 > BLOCK_LIMIT, 'a block holds every paragraph that fits')
  }
  assert.deepEqual(cut.blocks.map((block) => block.addedBefore + block.addedAfter), [0, 0, 0])
})

test('a cut that would fall inside a code fence is made at the blank line before it', () => {
  // The fence holds blank lines of its own: they are not places to cut.
  const fence = `\`\`\`ts\n${lines(10, 80, 'code')}\n${lines(10, 80, 'code')}\`\`\`\n`
  const before = paragraphs(BLOCK_LIMIT - 1000)
  const input = `${before}${fence}\n${paragraphs(2000, 'after')}`
  assert.ok(before.length < BLOCK_LIMIT && before.length + fence.length > BLOCK_LIMIT)
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.deepEqual(own(cut), [before, input.slice(before.length)])
  assert.deepEqual(cut.blocks.map((block) => block.addedBefore + block.addedAfter), [0, 0])
})

test('a code fence longer than a block is closed at the cut and opened again with its opening line', () => {
  const opening = '```ts title="setup.ts"\n'
  // Blank lines inside the fence, and a tilde fence inside it, are code.
  const code = Array.from({ length: 120 }, (_, part) => `${lines(4, 80, `code${part}`)}\n~~~\n`).join('')
  const input = `Before the fence.\n\n${opening}${code}\`\`\`\n\nAfter the fence.\n`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, 0)
  assert.equal(cut.blocks.length, 4)
  assert.equal(cut.blocks[0]?.text, 'Before the fence.\n\n')
  const pieces = cut.blocks.slice(1)
  for (const [index, block] of pieces.entries()) {
    const first = index === 0
    const last = index === pieces.length - 1
    assert.ok(block.text.startsWith(opening), 'each piece starts with the opening line')
    assert.equal(block.addedBefore, first ? 0 : opening.length)
    assert.equal(block.addedAfter, last ? 0 : 4)
    assert.ok(last || block.text.endsWith('\n```\n'), 'each piece but the last ends with a closing line')
    assert.ok(fencesBalanced(block.text), 'each piece is a whole fence')
    assert.ok(last || block.text.length + 80 > BLOCK_LIMIT, 'a piece holds every line that fits')
  }
  assert.ok(pieces.at(-1)?.text.endsWith('```\n\nAfter the fence.\n'))
})

test('a longer or indented fence is closed with its own marks', () => {
  const opening = '   ````md\n'
  const closing = '   ````\n'
  // A line of three backticks does not close a fence of four.
  const code = Array.from({ length: 250 }, (_, part) => `   line ${part} `.padEnd(79, 'x') + '\n   ```\n').join('')
  const input = `1. A step\n${opening}${code}${closing}2. The next step\n`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  // The fence is longer than a block, so it starts one of its own before it is cut.
  assert.equal(cut.blocks[0]?.text, '1. A step\n')
  const pieces = cut.blocks.slice(1)
  assert.ok(pieces.length > 1)
  for (const [index, block] of pieces.entries()) {
    const last = index === pieces.length - 1
    assert.equal(block.addedBefore, index === 0 ? 0 : opening.length)
    assert.ok(block.text.startsWith(opening))
    assert.ok(last || block.text.endsWith('\n   ````\n'))
    assert.equal(block.addedAfter, last ? 0 : 8)
  }
})

test('a line of inline code that starts with three backticks opens no fence', () => {
  const input = `\`\`\`inline\`\`\` code starts this paragraph.\n\n${paragraphs(40 * KIB)}`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 3)
  assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
})

/** An opening line longer than the quarter of a block that is said again. */
const LONG_OPENING = `\`\`\`${'x'.repeat(5000)}\n`

test('a fence with an opening line too long to say again still ends at its closing line', () => {
  // Read as an opening line, the closing line would put every paragraph after it in a fence.
  const input = `${LONG_OPENING}${lines(5, 80, 'code')}\`\`\`\n\n${paragraphs(40 * KIB)}`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 3)
  for (const block of cut.blocks.slice(0, -1)) assert.ok(block.text.endsWith('\n\n'), 'a block ends at a blank line')
  assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
})

test('a fence with an opening line too long to say again is opened again with its marks alone', () => {
  const input = `${LONG_OPENING}${lines(300, 80, 'code')}\`\`\`\n`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 2)
  assert.ok(cut.blocks[0]?.text.endsWith('x\n```\n'))
  assert.ok(cut.blocks[1]?.text.startsWith('```\ncode '))
  assert.deepEqual(
    cut.blocks.map((block) => [block.addedBefore, block.addedAfter]),
    [
      [0, 4],
      [4, 0]
    ]
  )
})

test('a fence with marks too long to say again is cut between its lines with nothing added', () => {
  const marks = '`'.repeat(5000)
  // A line of three backticks inside it is code, and opens nothing.
  const input = `${marks}\n\`\`\`\n${lines(300, 80, 'code')}${marks}\n\n${paragraphs(20 * KIB)}`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.ok(cut.blocks.length > 2)
  assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
  assert.ok(cut.blocks.at(-2)?.text.endsWith('\n\n'), 'after the fence a block ends at a blank line')

  // Nor is anything added where a line of it is cut.
  const long = `${marks}\n${'y'.repeat(40 * KIB)}\n${marks}\n`
  const inside = cutMarkdown(long, 256 * KIB)
  assertSound(long, inside)
  assert.equal(texts(inside).join(''), long)
})

/** A list item with nested lines and no blank line, `short` short of a full block. */
function nestedToTheEnd(short: 56 | 376): string {
  return `1. Step\n${lines(short === 56 ? 204 : 200, 80, '   nested')}`
}

test('a fence that fits one block is moved to the next whole when no blank line comes before it', () => {
  const fence = `   \`\`\`ts\n${lines(6, 80, '   code')}   \`\`\`\n`
  // The first block is full after the opening line, then in the middle of the code.
  for (const short of [56, 376] as const) {
    const before = nestedToTheEnd(short)
    assert.equal(before.length, BLOCK_LIMIT - short)
    const cut = cutMarkdown(`${before}${fence}`, 256 * KIB)
    assert.deepEqual(texts(cut), [before, fence])
    assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
  }
})

test('a fence is not cut right before its closing line', () => {
  // The code fills the block to the room kept for a closing line, and the fence's own closing
  // line is longer than that.
  const code = lines(89, 184, 'code')
  const input = `\`\`\`\n${code}\`\`\`\`\`\nAfter.\n`
  assert.equal(4 + code.length + 4, BLOCK_LIMIT)
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 2)
  assert.ok(cut.blocks[0]?.text.endsWith('x\n```\n'))
  assert.ok(cut.blocks[1]?.text.startsWith('```\ncode 88 '))
  assert.ok(cut.blocks[1]?.text.endsWith('x\n`````\nAfter.\n'))
})

test('a single line longer than the cap inside a fence is left open at the cap', () => {
  const input = `\`\`\`json\n${'x'.repeat(40 * KIB)}\n\`\`\`\n`
  const cut = cutMarkdown(input, 20 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, input.length - 20 * KIB)
  assert.deepEqual(
    cut.blocks.map((block) => [block.addedBefore, block.addedAfter]),
    [
      [0, 5],
      [8, 0]
    ]
  )
  assert.ok(cut.blocks[1]?.text.endsWith('xxx'))
})

test('a fence of tildes is closed with tildes', () => {
  const input = `~~~\n${lines(300, 80, 'code')}~~~\n`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 2)
  assert.ok(cut.blocks[0]?.text.endsWith('x\n~~~\n'))
  assert.ok(cut.blocks[1]?.text.startsWith('~~~\ncode '))
})

const TABLE_HEAD = '| File | Change | Risk |\n| --- | :-: | ---: |\n'

function rows(count: number): string {
  return Array.from({ length: count }, (_, row) => `| \`setup-${row}.ts\` | ${'pass the handle down '.repeat(3)}| low |\n`).join('')
}

test('a cut that would fall inside a table is made at the blank line before it', () => {
  const table = `${TABLE_HEAD}${rows(30)}`
  const before = paragraphs(BLOCK_LIMIT - 1000)
  const input = `${before}${table}\n${paragraphs(2000, 'after')}`
  assert.ok(before.length < BLOCK_LIMIT && before.length + table.length > BLOCK_LIMIT)
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.deepEqual(own(cut), [before, input.slice(before.length)])
  assert.deepEqual(cut.blocks.map((block) => block.addedBefore + block.addedAfter), [0, 0])
})

test('a table longer than a block has its header rows repeated in the next block', () => {
  const body = rows(600)
  const input = `Before the table.\n\n${TABLE_HEAD}${body}\nAfter the table.\n`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, 0)
  assert.equal(cut.blocks[0]?.text, 'Before the table.\n\n')
  const pieces = cut.blocks.slice(1)
  assert.equal(pieces.length, 4)
  for (const [index, block] of pieces.entries()) {
    const last = index === pieces.length - 1
    assert.ok(block.text.startsWith(`${TABLE_HEAD}| \`setup-`), 'each piece starts with the header rows and a row')
    assert.equal(block.addedBefore, index === 0 ? 0 : TABLE_HEAD.length)
    assert.equal(block.addedAfter, 0)
    assert.ok(last || block.text.endsWith('| low |\n'), 'a piece ends with a whole row')
    assert.ok(last || block.text.length + 90 > BLOCK_LIMIT, 'a piece holds every row that fits')
  }
  assert.ok(pieces.at(-1)?.text.endsWith('| low |\n\nAfter the table.\n'))
})

test('a delimiter row that starts like a list item is still a header row', () => {
  const head = 'File | Risk\n- | -\n'
  const input = `${head}${lines(300, 80, 'setup.ts | low')}`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 2)
  assert.ok(cut.blocks[1]?.text.startsWith(`${head}setup.ts | low `))
  assert.equal(cut.blocks[1]?.addedBefore, head.length)
})

test('lines that only look like a table are not given header rows', () => {
  for (const start of [
    // No delimiter row under the first line.
    '',
    // A delimiter row with fewer cells than the row above it.
    'a | b | c\n| --- | --- |\n',
    // A thematic break under a line with a pipe in it.
    'a | b\n---\n'
  ]) {
    const input = `${start}${lines(300, 80, 'a | b')}`
    const cut = cutMarkdown(input, 256 * KIB)
    assertSound(input, cut)
    assert.ok(cut.blocks.length > 1)
    assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
  }
})

test('a table ends at a heading or a fence with no blank line before it', () => {
  const table = `${TABLE_HEAD}${rows(3)}`
  const heading = cutMarkdown(`${table}## Heading\n${lines(300, 80, 'text')}`, 256 * KIB)
  assert.ok(heading.blocks.length > 1)
  assert.ok(heading.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))

  // The lines of the fence are code, not rows: the fence is what is opened again.
  const fence = cutMarkdown(`${table}\`\`\`\n${lines(300, 80, 'code')}\`\`\`\n`, 256 * KIB)
  assert.equal(fence.blocks[0]?.text, table)
  assert.ok(fence.blocks.length > 2)
  for (const block of fence.blocks.slice(2)) {
    assert.ok(block.text.startsWith('```\ncode '))
    assert.equal(block.addedBefore, 4)
  }
})

test('a list item right under a table is not a row of it', () => {
  const table = `${TABLE_HEAD}${rows(3)}`
  for (const item of ['- item', '* item', '+ item', '12. item', '3) item']) {
    const input = `${table}${lines(300, 80, item)}`
    const cut = cutMarkdown(input, 256 * KIB)
    assertSound(input, cut)
    assert.ok(cut.blocks.length > 1)
    assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0), item)
  }
})

test('a table with header rows too long to say again is still cut between its rows as a table', () => {
  const table = `| ${'File '.repeat(1000)}| Change | Risk |\n| --- | :-: | ---: |\n${rows(300)}`
  const input = `Before the table.\n${table}`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  // Like any table longer than a block, it starts a block of its own before it is cut.
  assert.equal(cut.blocks[0]?.text, 'Before the table.\n')
  assert.ok(cut.blocks.length > 2)
  for (const block of cut.blocks.slice(2)) assert.ok(block.text.startsWith('| `setup-'))
  assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
})

test('a table that fits one block is moved to the next whole when no blank line comes before it', () => {
  const table = `   | File | Change | Risk |\n   | --- | :-: | ---: |\n${rows(5)}`
  // The first block is full after the header rows, then in the middle of the rows.
  for (const short of [56, 376] as const) {
    const before = nestedToTheEnd(short)
    const cut = cutMarkdown(`${before}${table}`, 256 * KIB)
    assert.deepEqual(texts(cut), [before, table])
    assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
  }
})

function nestedList(items: number, from = 1): string {
  return Array.from(
    { length: items },
    (_, item) => `${item + from}. Step ${item + from} of the work\n   - touches \`setup-${item}.ts\`\n   - check: pnpm test\n`
  ).join('')
}

test('a cut that would fall inside a nested list is made at the blank line before it', () => {
  const list = nestedList(40)
  const before = paragraphs(BLOCK_LIMIT - 1000)
  const input = `${before}${list}\n${paragraphs(2000, 'after')}`
  assert.ok(before.length < BLOCK_LIMIT && before.length + list.length > BLOCK_LIMIT)
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.deepEqual(own(cut), [before, input.slice(before.length)])
})

test('a blank line before a nested line is passed over for one before a line with no indent', () => {
  // A loose list: every item is followed by a blank line and an indented paragraph.
  const loose = Array.from({ length: 200 }, (_, item) => `${item + 1}. Step ${item + 1}\n\n   ${'More about the step. '.repeat(4)}\n\n`).join('')
  const cut = cutMarkdown(loose, 256 * KIB)
  assertSound(loose, cut)
  assert.ok(cut.blocks.length > 1)
  for (const block of cut.blocks) assert.match(block.text, /^\d+\. Step/)
})

test('a nested list longer than a block with no blank line is cut before an item with no indent', () => {
  const input = `Before the list.\n${nestedList(400)}`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.ok(cut.blocks.length > 1)
  for (const block of cut.blocks.slice(1)) assert.match(block.text, /^\d+\. Step/)
  assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
})

test('cutMarkdown cuts a single line longer than a block where the block ends, between characters', () => {
  // The line starts in the first block and fills it. The pair lies across that block's last unit.
  const input = `Before.\n\n${ASTRAL.repeat(BLOCK_LIMIT)}\n\nAfter.\n`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, 0)
  assert.deepEqual(
    texts(cut).map((block) => block.length),
    [BLOCK_LIMIT - 1, BLOCK_LIMIT, 19]
  )
  assert.ok(cut.blocks.every((block) => block.addedBefore === 0 && block.addedAfter === 0))
})

test('a single line longer than a block inside a fence is closed and opened again around the cut', () => {
  const long = 'x'.repeat(40 * KIB)
  const input = `\`\`\`json\n${long}\n\`\`\`\n`
  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 3)
  for (const [index, block] of cut.blocks.entries()) {
    const last = index === 2
    assert.ok(block.text.startsWith('```json\nx'))
    assert.ok(block.text.endsWith('\n```\n'))
    assert.equal(block.addedBefore, index === 0 ? 0 : 8)
    assert.equal(block.addedAfter, last ? 0 : 5)
  }
})

test('cutMarkdown stops at the last line break under the cap and counts the rest', () => {
  const input = paragraphs(100 * KIB)
  const cut = cutMarkdown(input, 64 * KIB)
  assertSound(input, cut)
  const shown = own(cut).join('')
  assert.ok(shown.length <= 64 * KIB && shown.length + 90 > 64 * KIB, 'every line under the cap is shown')
  assert.ok(shown.endsWith('x\n'), 'the last line shown is whole')
  assert.equal(cut.notShown, input.length - shown.length)
  assert.equal(cut.blocks.length, 5)
})

test('cutMarkdown with a cap under the first line cuts that line at the cap', () => {
  const input = `${'word '.repeat(4000)}\n\nMore.\n`
  const cut = cutMarkdown(input, 4 * KIB)
  assertSound(input, cut)
  assert.deepEqual(texts(cut), [input.slice(0, 4 * KIB)])
  assert.deepEqual(cutMarkdown(input, 0), { blocks: [], notShown: input.length })
})

test('a line longer than a block is shown up to the cap, however little of it is left', () => {
  // After the first block, what is left of the line would fit a block but not the cap.
  const input = `${'x'.repeat(20 * KIB)}\nmore\n`
  const cut = cutMarkdown(input, 18 * KIB)
  assertSound(input, cut)
  assert.deepEqual(own(cut), [input.slice(0, BLOCK_LIMIT), input.slice(BLOCK_LIMIT, 18 * KIB)])
  assert.equal(cut.notShown, input.length - 18 * KIB)

  const fenced = `\`\`\`json\n${'x'.repeat(20 * KIB)}\n\`\`\`\n`
  const inFence = cutMarkdown(fenced, 18 * KIB)
  assertSound(fenced, inFence)
  assert.equal(own(inFence).join(''), fenced.slice(0, 18 * KIB))
  assert.deepEqual(
    inFence.blocks.map((block) => [block.addedBefore, block.addedAfter]),
    [
      [0, 5],
      [8, 0]
    ]
  )
})

test('a fence the cap ends is left open and gets no closing line', () => {
  const input = `\`\`\`ts\n${lines(300, 80, 'code')}\`\`\`\n`
  const cut = cutMarkdown(input, 4 * KIB)
  assertSound(input, cut)
  assert.equal(cut.blocks.length, 1)
  assert.equal(cut.blocks[0]?.addedAfter, 0)
  assert.ok(cut.blocks[0]?.text.endsWith('x\n'))

  // The first block is full inside the fence, and the next line of code is over the cap.
  const atTheLimit = cutMarkdown(input, BLOCK_LIMIT + 6)
  assertSound(input, atTheLimit)
  assert.deepEqual(texts(atTheLimit), [input.slice(0, 6 + 204 * 80)])
})

/** How much of the input a Markdown cut has to show, by the rule of the cap. */
function assertShownToTheCap(input: string, cut: Cut, cap: number): void {
  const shown = input.length - cut.notShown
  assert.equal(cut.blocks.at(-1)?.addedAfter ?? 0, 0, 'nothing is added after the last block')
  if (input.length <= cap) {
    assert.equal(cut.notShown, 0)
    return
  }
  assert.ok(shown <= cap, 'no more than the cap is shown')
  if (cap === 0) return
  // The line the cap falls in. Every line before it is shown.
  const lineStart = input.lastIndexOf('\n', cap - 1) + 1
  const lineBreak = input.indexOf('\n', lineStart)
  const lineSize = (lineBreak === -1 ? input.length : lineBreak + 1) - lineStart
  assert.ok(shown >= lineStart, `${shown} shown, and whole lines up to ${lineStart} fit under the cap`)
  // The first line, and a line no block can hold, are shown up to the cap, to within a character.
  if (lineStart === 0 || lineSize > BLOCK_LIMIT) assert.ok(shown >= cap - 1, `${shown} shown under a cap of ${cap}`)
}

test('the long Markdown file of the run detail prototype is cut at blank lines with nothing added', () => {
  // fixtures/markdown/prototype-plan.md.txt is what `planMarkdown()` returns in
  // prototypes/run-detail/plugin/src/fixtures.ts on the prototype/run-detail branch, byte for
  // byte. It has a fence, a table and a nested list, each lying across a multiple of 16 KiB.
  // README.md says why its name ends in .txt.
  const input = readRepoText('fixtures/markdown/prototype-plan.md.txt')
  assert.ok(input.length > 4 * BLOCK_LIMIT)
  for (const multiple of [1, 2, 3]) {
    const construct = ['```ts', '| File |', '1. '][multiple - 1] as string
    const start = input.indexOf(`\n\n${construct}`) + 2
    const end = input.indexOf('\n\n', start)
    assert.ok(start < multiple * BLOCK_LIMIT && end > multiple * BLOCK_LIMIT, `${construct} lies across a cut`)
  }

  const cut = cutMarkdown(input, 256 * KIB)
  assertSound(input, cut)
  assert.equal(cut.notShown, 0)
  assert.equal(texts(cut).join(''), input)
  assert.equal(cut.blocks.length, 5)
  for (const [index, block] of texts(cut).entries()) {
    assert.ok(index === cut.blocks.length - 1 || block.endsWith('\n\n'), 'a block ends at a blank line')
    assert.ok(fencesBalanced(block), 'no block ends inside the fence')
  }
  const holding = (marker: RegExp): number => texts(cut).filter((block) => marker.test(block)).length
  assert.equal(holding(/^\| /m), 1, 'the table is in one block')
  assert.equal(holding(/^\d+\. /m), 1, 'the nested list is in one block')
  assert.equal(holding(/^ {2}await tx\.run/m), 1, 'the fence is in one block')
})

test('every cut of generated Markdown is sound, at any cap', () => {
  let seed = 20_261_118
  const random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) | 0
    return (seed >>> 0) / 4_294_967_296
  }
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
  const size = (): number => Math.floor(random() * random() * 30 * KIB)
  const parts: (() => string)[] = [
    () => paragraphs(size() / 4),
    () => `\`\`\`${pick(['', 'ts', 'json'])}\n${lines(Math.ceil(size() / 80), 80, 'code')}${pick(['```\n', '```\n\n', ''])}`,
    () => `~~~~\n${lines(Math.ceil(size() / 200), 50, pick(['code', '```']))}\n${pick(['~~~~\n\n', '~~~\n'])}`,
    () => `${TABLE_HEAD}${rows(Math.ceil(size() / 90))}${pick(['\n', '', '# Heading\n'])}`,
    () => `${nestedList(Math.ceil(size() / 70))}${pick(['\n', ''])}`,
    () => `${pick(['a', ASTRAL, '| ', '   '])}${ASTRAL.repeat(size())}${pick(['\n', '\n\n', '\r\n'])}`,
    () => `${'-'.repeat(size())}|${' '.repeat(size())}x\n`,
    () => lines(Math.ceil(size() / 60), 60, pick(['> quote', '   indented', '\t```', '|', '- item'])).replaceAll('\n', pick(['\n', '\r\n'])),
    () => `${pick([LONG_OPENING, `${'~'.repeat(5000)}\n`])}${lines(Math.ceil(size() / 80), 80, 'code')}${pick(['```\n', '\n', ''])}`,
    () => `| ${'File '.repeat(1000)}| Change |\n| --- | --- |\n${rows(Math.ceil(size() / 90))}`
  ]
  for (let round = 0; round < 150; round++) {
    let input = ''
    for (let part = Math.ceil(random() * 8); part > 0; part--) input += pick(parts)()
    for (const cap of [256 * KIB, 64 * KIB, BLOCK_LIMIT, Math.floor(random() * 40 * KIB)]) {
      const markdown = cutMarkdown(input, cap)
      assertSound(input, markdown)
      assertShownToTheCap(input, markdown, cap)
      const plain = cutText(input, cap)
      assertSound(input, plain)
      assert.equal(plain.notShown, Math.max(0, input.length - cap) + (splits(input, cap) ? 1 : 0))
    }
  }
})
