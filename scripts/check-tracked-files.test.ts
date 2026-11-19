// The pre-commit check's rules, driven through the functions its command line uses.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { checkFiles, findBannedText, parseArguments, pathsToCheck } from './check-tracked-files.ts'

// This file is tracked, so it is checked too: every banned string is put together at run time.
const handle = ['sea', 'nr'].join('')
const replacement = String.fromCharCode(0xfffd)
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const rules = (text: string): string[] => findBannedText('notes.md', bytes(text)).map((f) => f.rule)

describe('the tracked-files check', () => {
  test('passes ordinary text', () => {
    assert.deepEqual(findBannedText('README.md', bytes('# Orchon\n\nPlain text.\n')), [])
  })

  test('fails on U+FFFD and names the line', () => {
    assert.deepEqual(findBannedText('a.md', bytes(`one\ntwo ${replacement}\n`)), [
      { path: 'a.md', line: 2, rule: 'U+FFFD replacement character' }
    ])
  })

  test('fails on text that is not valid UTF-8', () => {
    const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    assert.deepEqual(findBannedText('a.txt', latin1), [
      { path: 'a.txt', line: 1, rule: 'text that is not valid UTF-8' }
    ])
  })

  test('does not read a binary file as text', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xef, 0xbf, 0xbd, 0xe9])
    assert.deepEqual(findBannedText('icon.png', png), [])
  })

  test('fails on the personal handle in any letter case', () => {
    assert.deepEqual(rules(`by ${handle}\n`), ['personal handle'])
    assert.deepEqual(rules(`by ${handle.toUpperCase()}\n`), ['personal handle'])
  })

  test('fails on a home path in each spelling', () => {
    assert.deepEqual(rules(`C:\\Users\\${handle}\\notes`), ['home path'])
    assert.deepEqual(rules(`C:\\\\Users\\\\${handle}\\\\notes`), ['home path'])
    assert.deepEqual(rules(`C:/Users/${handle}/notes`), ['home path'])
    assert.deepEqual(rules(`/c/Users/${handle}/notes`), ['home path'])
    assert.deepEqual(rules(`/home/${handle}/notes`), ['home path'])
  })

  test('fails on the email address', () => {
    assert.deepEqual(rules(`mail ${handle}example@example.com now`), ['email address'])
  })

  test('reports each line once, with its number', () => {
    const text = `clean\n${handle} and ${handle}\nclean\n/c/Users/${handle}\n`
    assert.deepEqual(findBannedText('a.md', bytes(text)), [
      { path: 'a.md', line: 2, rule: 'personal handle' },
      { path: 'a.md', line: 4, rule: 'home path' }
    ])
  })

  test('finds the handle inside a binary file', () => {
    const binary = Uint8Array.from([0x00, 0x01, ...bytes(handle), 0x00])
    assert.deepEqual(findBannedText('blob.bin', binary), [
      { path: 'blob.bin', line: 1, rule: 'personal handle' }
    ])
  })

  test('never repeats the banned text in a finding', () => {
    const findings = findBannedText('a.md', bytes(`${handle}@example.com ${replacement}`))
    assert.ok(findings.length > 0)
    assert.ok(!JSON.stringify(findings).toLowerCase().includes(handle))
  })

  test('reads a NUL-separated list and skips the folders no gate reads', () => {
    const list = ['README.md', '.lril/state.json', 'src/worker.ts', 'node_modules/a/b.js', ''].join('\0')
    assert.deepEqual(pathsToCheck(list), ['README.md', 'src/worker.ts'])
  })

  test('reads the working tree unless it is given the folder the staged files were written to', () => {
    assert.deepEqual(parseArguments([]), { root: null })
    assert.deepEqual(parseArguments(['--root', 'staged']), { root: 'staged' })
  })

  test('refuses arguments it does not know', () => {
    for (const bad of [['--root'], ['--root', ''], ['--root', 'a', 'b'], ['--staged'], ['staged']]) {
      const parsed = parseArguments(bad)
      assert.ok('error' in parsed, `accepted: ${bad.join(' ')}`)
    }
  })

  test('checks the files of the folder it is given, and passes a listed file that is not there', () => {
    const staged = mkdtempSync(join(tmpdir(), 'orchon-staged-'))
    try {
      mkdirSync(join(staged, 'docs'))
      writeFileSync(join(staged, 'docs', 'notes.md'), `clean\nby ${handle}\n`)
      writeFileSync(join(staged, 'clean.md'), 'clean\n')
      assert.deepEqual(checkFiles(['clean.md', 'docs/notes.md', 'deleted.md'], staged), [
        { path: 'docs/notes.md', line: 2, rule: 'personal handle' }
      ])
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
  })
})
