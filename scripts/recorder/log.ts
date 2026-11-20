// The log beside a release's fixtures: what was recorded, when, from which binary, and what
// could not be recorded. It is written by the recorder and never by hand.
import type { Crossing } from './ceiling.ts'
import type { LoginMode } from './environment.ts'
import { PLACEHOLDERS } from './scrub.ts'
import { SYNTHETIC_METRIC_PREFIX, SYNTHETIC_METRICS, SYNTHETIC_PACK } from './workflows.ts'

/**
 * Whether the metrics scenario ran the recorder's synthetic metrics pack before it read the
 * reports, or why it did not, in which case they were read over an empty store.
 */
export type SyntheticLog = { ran: true } | { ran: false; why: string }

/** What a spend-mode recording adds to its log. */
export interface SpendLog {
  scenario: string
  tokenCeiling: number
  wallClockMs: number
  /** The tokens Archon reported, each report counted once. */
  tokensSeen: number
  /** The ceiling that was crossed, or null. */
  crossed: Crossing | null
  /** Whether the release was given the Claude login. */
  login: LoginMode
  /** Present only for the metrics scenario. */
  synthetic?: SyntheticLog
}

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
  /** Present only for a spend-mode recording. */
  spend?: SpendLog
}

const number = (value: number): string => value.toLocaleString('en-US')

/** The lines a spend-mode recording adds below the binary and the platform. */
function spendLines(spend: SpendLog): string[] {
  return [
    `- Recorded in spend mode: the ${code(spend.scenario)} scenario alone`,
    `- Ceilings: ${number(spend.tokenCeiling)} tokens and ${number(spend.wallClockMs / 60_000)} minutes`,
    `- Tokens Archon reported: ${number(spend.tokensSeen)}`,
    `- Ceiling crossed: ${
      spend.crossed === null ? 'none' : `${spend.crossed.by}, ${number(spend.crossed.seen)} against ${number(spend.crossed.ceiling)}; the run was cancelled`
    }`,
    `- Claude login: ${spend.login === 'passed' ? 'passed to the throwaway release by folder and name only, never read or copied' : 'hidden from the release'}`,
    ...(spend.synthetic === undefined ? [] : [syntheticLine(spend.synthetic)])
  ]
}

/** Whether the metrics scenario's records are made up, and when they are not, why. */
function syntheticLine(synthetic: SyntheticLog): string {
  if (!synthetic.ran) {
    return `- Synthetic data: none. The recorder's synthetic pack did not run (${cell(synthetic.why)}), so the reports were read over an empty store.`
  }
  return `- Synthetic data: every metric record here, and the overview cards of ${code(SYNTHETIC_PACK)}, were made up by the recorder's own pack (workflow ${code(
    SYNTHETIC_METRICS.name
  )}, one shell step, fixed numbers, names starting ${code(SYNTHETIC_METRIC_PREFIX)}). They measure nothing.`
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
    ...(log.spend === undefined ? [] : spendLines(log.spend)),
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
