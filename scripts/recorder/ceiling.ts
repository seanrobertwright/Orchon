// The ceilings of a spend-mode run. A subscription login has no spending cap of its own, so the
// recorder watches what Archon reports and cancels the run itself: when the tokens reported cross
// the run's token ceiling, when its wall-clock ceiling passes, or when an agent step makes more
// tool calls than it may.
import { field, text } from '../shape.ts'
import type { Tape } from './recording.ts'

/** Which ceiling was crossed, what was seen and what the ceiling was. */
export interface Crossing {
  by: 'tokens' | 'time' | 'tool-calls'
  seen: number
  ceiling: number
}

export interface CeilingGuard {
  /** Reads an answer or a stream frame for the token usage and the tool calls it reports. */
  observe(value: unknown): void
  /** The tokens reported so far, each report counted once. */
  tokens(): number
  /** The tool calls reported so far. */
  toolCalls(): number
  /** The first ceiling that is crossed now, or null. */
  check(): Crossing | null
}

export interface Ceilings {
  tokenCeiling: number
  wallClockMs: number
  /** Left out when the scenario's run makes no tool calls of its own that are counted. */
  maxToolCalls?: number
  now: () => number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/**
 * The tokens one object reports, or null when it is not a report. Archon reports a node's spend
 * as `tokens: { source: 'provider', value: { input, output, cacheRead, cacheWrite } }`; a usage in
 * the provider's own shape has `input_tokens` and `output_tokens`. Cached tokens are counted too.
 */
function reported(value: Record<string, unknown>): { key: string; tokens: number } | null {
  const tokens = value.tokens
  if (isRecord(tokens) && tokens.source === 'provider' && isRecord(tokens.value)) {
    const usage = tokens.value
    return {
      key: `spend:${JSON.stringify(usage)}`,
      tokens: count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite)
    }
  }
  if (typeof value.input_tokens === 'number' && typeof value.output_tokens === 'number') {
    return {
      key: `usage:${JSON.stringify(value)}`,
      tokens:
        count(value.input_tokens) + count(value.output_tokens) + count(value.cache_read_input_tokens) + count(value.cache_creation_input_tokens)
    }
  }
  return null
}

export function createCeilingGuard(ceilings: Ceilings): CeilingGuard {
  const began = ceilings.now()
  // Each report is counted once, however often it is read. Two different reports are both
  // counted, so the count errs high and the run is cancelled early rather than late.
  const reports = new Map<string, number>()
  const toolCalls = new Set<string>()
  const tokens = (): number => [...reports.values()].reduce((sum, value) => sum + value, 0)

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      // A stream frame that was not JSON, or JSON inside a string: read it too.
      if (/^\s*[{[]/.test(value)) {
        try {
          walk(JSON.parse(value) as unknown)
        } catch {
          // Plain text.
        }
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!isRecord(value)) return
    const report = reported(value)
    if (report !== null) reports.set(report.key, report.tokens)
    const callId = text(value.toolCallId)
    if (value.type === 'tool_call' && callId !== undefined) toolCalls.add(callId)
    for (const item of Object.values(value)) walk(item)
  }

  return {
    observe: walk,
    tokens,
    toolCalls: () => toolCalls.size,
    check() {
      const seen = tokens()
      if (seen > ceilings.tokenCeiling) return { by: 'tokens', seen, ceiling: ceilings.tokenCeiling }
      if (ceilings.maxToolCalls !== undefined && toolCalls.size > ceilings.maxToolCalls) {
        return { by: 'tool-calls', seen: toolCalls.size, ceiling: ceilings.maxToolCalls }
      }
      const elapsed = ceilings.now() - began
      if (elapsed > ceilings.wallClockMs) return { by: 'time', seen: Math.round(elapsed), ceiling: ceilings.wallClockMs }
      return null
    }
  }
}

const TERMINAL: readonly string[] = ['completed', 'failed', 'cancelled']

export type WatchOutcome =
  | { ended: 'finished'; status: string }
  | { ended: 'cancelled'; crossed: Crossing; status: string }
  /** The cancel was sent and the run had not ended within the grace: the release must be stopped. */
  | { ended: 'cancel-failed'; crossed: Crossing }

export interface WatchOptions {
  sleep: (ms: number) => Promise<void>
  pollMs: number
  /** How long a cancelled run is given to end before the recorder stops the release. */
  cancelGraceMs: number
}

/**
 * Watches one run until it ends, reading its detail and its step's provider events at every
 * poll. When a ceiling is crossed the run is cancelled through `POST .../cancel`, and the log
 * says which ceiling, what was seen and what the cancel answered.
 */
export async function watchRun(tape: Tape, runId: string, step: string, guard: CeilingGuard, options: WatchOptions): Promise<WatchOutcome> {
  const run = `/api/workflows/runs/${encodeURIComponent(runId)}`
  let lastTokens = -1
  let lastCalls = -1
  const read = async (): Promise<string | undefined> => {
    const detail = await tape.peek('GET', run)
    guard.observe(detail.body)
    const events = await tape.peek('GET', `${run}/provider-events?step=${encodeURIComponent(step)}`)
    guard.observe(events.body)
    if (guard.tokens() !== lastTokens || guard.toolCalls() !== lastCalls) {
      lastTokens = guard.tokens()
      lastCalls = guard.toolCalls()
      tape.note('spend-seen', { tokens: lastTokens, toolCalls: lastCalls })
    }
    return text(field(detail.body, 'run', 'status'))
  }
  for (;;) {
    const status = await read()
    if (status !== undefined && TERMINAL.includes(status)) return { ended: 'finished', status }
    const crossed = guard.check()
    if (crossed !== null) {
      tape.note('ceiling-crossed', { ...crossed })
      await tape.call('POST', `${run}/cancel`)
      const until = tape.at() + options.cancelGraceMs
      while (tape.at() <= until) {
        const after = await read()
        if (after !== undefined && TERMINAL.includes(after)) return { ended: 'cancelled', crossed, status: after }
        await options.sleep(options.pollMs)
      }
      tape.note('cancel-did-not-end-the-run', { waitedMs: options.cancelGraceMs })
      return { ended: 'cancel-failed', crossed }
    }
    await options.sleep(options.pollMs)
  }
}
