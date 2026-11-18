// The pre-commit check. It fails when a tracked file holds U+FFFD or text that is not valid
// UTF-8, or the owner's personal handle, home path or email address.
//
//   git ls-files -z | node scripts/check-tracked-files.ts
//
// It reads the NUL-separated list of tracked files on standard input and starts no process.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSkippedPath, repoRoot } from './repo-files.ts'

export interface Finding {
  path: string
  /** Counted from 1. */
  line: number
  /** What was found. It never repeats the text itself, so a log holds nothing personal. */
  rule: string
}

// The handle is put together here so that this file passes its own check. It is letters only, so
// it needs no escaping inside a pattern.
const HANDLE = ['sea', 'nr'].join('')
const handlePattern = new RegExp(HANDLE, 'i')
const homePathPattern = new RegExp(`(?:users|home)[\\\\/]+${HANDLE}`, 'i')
const emailPattern = new RegExp(`${HANDLE}[\\w.+-]*@`, 'i')

const REPLACEMENT = String.fromCharCode(0xfffd)

/** Git's own test for a binary file: a NUL byte near the start. */
function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0)
}

function lineNumbersHolding(text: string, needle: string): number[] {
  const numbers: number[] = []
  text.split('\n').forEach((line, index) => {
    if (line.includes(needle)) numbers.push(index + 1)
  })
  return numbers
}

function encodingFindings(path: string, bytes: Uint8Array): Finding[] {
  if (isBinary(bytes)) return []
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // The lenient decoder puts U+FFFD where the bytes are wrong, which gives the line.
    const lenient = new TextDecoder('utf-8').decode(bytes)
    const line = lineNumbersHolding(lenient, REPLACEMENT)[0] ?? 1
    return [{ path, line, rule: 'text that is not valid UTF-8' }]
  }
  return lineNumbersHolding(text, REPLACEMENT).map((line) => ({
    path,
    line,
    rule: 'U+FFFD replacement character'
  }))
}

function personalFindings(path: string, bytes: Uint8Array): Finding[] {
  // Latin-1 maps every byte to one character, so this also reads a binary file.
  const findings: Finding[] = []
  new TextDecoder('latin1')
    .decode(bytes)
    .split('\n')
    .forEach((line, index) => {
      if (!handlePattern.test(line)) return
      const rule = homePathPattern.test(line)
        ? 'home path'
        : emailPattern.test(line)
          ? 'email address'
          : 'personal handle'
      findings.push({ path, line: index + 1, rule })
    })
  return findings
}

/** Every banned thing in one file's bytes, in line order. */
export function findBannedText(path: string, bytes: Uint8Array): Finding[] {
  return [...encodingFindings(path, bytes), ...personalFindings(path, bytes)].sort(
    (a, b) => a.line - b.line
  )
}

/** The paths of a NUL-separated list, leaving out the folders no gate reads. */
export function pathsToCheck(nulSeparated: string): string[] {
  return nulSeparated.split('\0').filter((path) => path !== '' && !isSkippedPath(path))
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

/** The bytes of a tracked file, or null when it is deleted in the working tree or is not a file. */
function readTracked(path: string): Uint8Array | null {
  try {
    return readFileSync(join(repoRoot, path))
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'EISDIR') return null
    throw error
  }
}

async function main(): Promise<number> {
  const paths = process.stdin.isTTY ? [] : pathsToCheck(await readStandardInput())
  if (paths.length === 0) {
    console.error(
      'No file list on standard input. Run: git ls-files -z | node scripts/check-tracked-files.ts'
    )
    return 2
  }
  const findings = paths.flatMap((path) => {
    const bytes = readTracked(path)
    return bytes === null ? [] : findBannedText(path, bytes)
  })
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.rule}`)
  }
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s) in tracked files. Remove them before committing.`)
    return 1
  }
  console.log(`${paths.length} tracked files checked.`)
  return 0
}

if (import.meta.main) process.exitCode = await main()
