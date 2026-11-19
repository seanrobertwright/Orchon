// The log beside a release's fixtures: what was recorded, when, from which binary, and what
// could not be recorded. It is written by the recorder and never by hand.
import { PLACEHOLDERS } from './scrub.ts'

export interface RecordedLog {
  release: string
  /** An ISO 8601 time in UTC. */
  recordedAt: string
  binary: {
    /** The file's name only: its folder is the developer's. */
    name: string
    bytes: number
    sha256: string
    /** What the binary printed for `--version`. */
    reports: string
  }
  /** The operating system and processor the release ran on. */
  platform: string
  /** The version the running server reported in its health answer, when it reported one. */
  serverVersion: string | null
  files: readonly { path: string; holds: string }[]
  gaps: readonly { what: string; why: string }[]
}

/** One table cell: a single line with nothing that would end the cell. */
const cell = (text: string): string => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()

/** Text inside a code span. A backtick would end the span. */
const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``

/** The Markdown of `RECORDED.md`. */
export function recordedLog(log: RecordedLog): string {
  const files = [...log.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const lines = [
    `# Archon ${log.release}: recorded fixtures`,
    '',
    'Written by `scripts/record-fixtures.ts`. Do not edit these files by hand: record them again.',
    '',
    `- Recorded at: ${log.recordedAt}`,
    `- Release: ${log.release}`,
    `- Binary: ${code(log.binary.name)}, ${log.binary.bytes.toLocaleString('en-US')} bytes, SHA-256 ${code(log.binary.sha256)}`,
    `- The binary reports: ${code(cell(log.binary.reports))}`,
    `- The running server reported version: ${log.serverVersion === null ? 'none' : code(log.serverVersion)}`,
    `- Recorded on: ${log.platform}`,
    '- Archon home: a throwaway folder the recorder made and deleted afterwards',
    '',
    '## What was recorded',
    ''
  ]
  if (files.length === 0) lines.push('Nothing.')
  else {
    lines.push('| File | What it holds |', '| --- | --- |')
    for (const file of files) lines.push(`| ${code(file.path)} | ${cell(file.holds)} |`)
  }
  lines.push('', '## What could not be recorded', '')
  if (log.gaps.length === 0) lines.push('Nothing was left out.')
  else for (const gap of log.gaps) lines.push(`- ${cell(gap.what)}: ${cell(gap.why)}`)
  lines.push('', '## What was scrubbed', '', 'Each of these stands for a value of the machine that recorded:', '')
  for (const { as, stands } of Object.values(PLACEHOLDERS)) lines.push(`- ${code(as)}: ${stands}`)
  return `${lines.join('\n')}\n`
}
