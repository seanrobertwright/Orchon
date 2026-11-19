// Waiting for a started release to answer its first health check. A release downloads its server
// and web UI on its first boot, so the wait is long, and it ends at once when the recording is
// interrupted.
import { readFileSync } from 'node:fs'
import type { Answer, LoopbackClient } from './http.ts'
import { untilInterrupted } from './interrupt.ts'

/** How long a release may take to answer its first health check: it downloads its server first. */
export const BOOT_TIMEOUT_MS = 300_000

export interface BootWait {
  client: LoopbackClient
  release: { hasExited(): boolean; logFile: string }
  /** Aborted when the recording is interrupted. The wait rejects with its reason. */
  signal: AbortSignal
  timeoutMs?: number
  pollMs?: number
}

function lastLines(file: string, count: number): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-count).join('\n')
  } catch {
    return ''
  }
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** The body of the first `GET /api/health` that answers 200. */
export async function waitUntilHealthy({ client, release, signal, timeoutMs = BOOT_TIMEOUT_MS, pollMs = 500 }: BootWait): Promise<unknown> {
  const until = performance.now() + timeoutMs
  // One promise for the whole wait, so each check adds no listener of its own to the signal.
  const interrupted = untilInterrupted(signal)
  interrupted.catch(() => undefined)
  while (performance.now() < until) {
    signal.throwIfAborted()
    let answer: Answer | null = null
    try {
      // A request that hangs is given up at once when the recording is interrupted.
      answer = await Promise.race([client.request('GET', '/api/health'), interrupted])
    } catch {
      // Not listening yet, or interrupted: the check below tells which.
    }
    signal.throwIfAborted()
    if (answer?.status === 200) return answer.body
    if (release.hasExited()) {
      throw new Error(`The release ended before it answered.\n${lastLines(release.logFile, 30)}`)
    }
    await pause(Math.min(pollMs, Math.max(0, until - performance.now())), signal)
  }
  throw new Error(`The release did not answer within ${timeoutMs / 1000} seconds.\n${lastLines(release.logFile, 30)}`)
}
