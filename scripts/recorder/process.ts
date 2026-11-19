// The recorder's process gateway: the one file in this repository that starts a program. It
// starts the Archon release being recorded, against a throwaway home only, the release's own
// commands that set that home up, and the few `git` commands that make the throwaway project.
// The lint config names this file as the exception.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { releaseEnvironment } from './environment.ts'
import { assertOwnHome, type ThrowawayHome } from './home.ts'

export interface Finished {
  /** The exit code, or null when the program did not start, was stopped or ran out of time. */
  status: number | null
  stdout: string
  stderr: string
}

/** How long a program is given to end after it is asked to, before it is killed. */
export const STOP_GRACE_MS = 5000

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** Whether `ended` settles within `ms`. */
const endsWithin = (ended: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([ended.then(() => true), sleep(ms).then(() => false)])

/**
 * Ends a process and every process it started, and waits until it has ended. On Windows
 * `taskkill /T /F` ends the tree at once. Elsewhere the process leads its own group: the group is
 * sent SIGTERM, and SIGKILL when it has not ended after `graceMs`. The group is signalled even
 * when its leader has already ended, so a child the leader left behind goes too. Answers whether
 * the leader ended; it gives up after a second wait, so a stop never hangs the recorder.
 */
async function endTree(pid: number, ended: Promise<void>, graceMs: number): Promise<boolean> {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return endsWithin(ended, graceMs)
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      // The whole group has already ended.
    }
  }
  signalGroup('SIGTERM')
  const endedInTime = await endsWithin(ended, graceMs)
  // The leader may have ended and left a child in its group, so the group is killed either way.
  signalGroup('SIGKILL')
  return endedInTime || endsWithin(ended, graceMs)
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  /** Aborted when the recording is interrupted: the program is stopped, or never started. */
  signal?: AbortSignal
  graceMs?: number
}

/**
 * Runs a program to its end inside a throwaway home, with the release's environment. Used for
 * the release's own `--version` and `provider add`, and for `git` in the throwaway project. The
 * program and every process it starts are stopped when the time runs out or the signal aborts.
 */
export async function runToEnd(home: ThrowawayHome, program: string, args: readonly string[], options: RunOptions = {}): Promise<Finished> {
  assertOwnHome(home)
  if (options.signal?.aborted === true) return { status: null, stdout: '', stderr: 'Not started: the recording was interrupted.' }
  const child = spawn(program, [...args], {
    cwd: options.cwd ?? home.root,
    env: releaseEnvironment(process.env, home.archonHome),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  let status: number | null = null
  let stopped = false
  const ended = new Promise<void>((resolve) => {
    // Its output is complete at `close`. A process it left behind may hold the output open, so
    // the run also ends a moment after the program itself has.
    child.once('exit', (code) => {
      status = code
      setTimeout(resolve, 1000).unref()
    })
    child.once('close', () => resolve())
    child.once('error', (error) => {
      stderr += String(error)
      resolve()
    })
  })
  const stop = (): void => {
    if (stopped || child.pid === undefined) return
    stopped = true
    void endTree(child.pid, ended, options.graceMs ?? STOP_GRACE_MS)
  }
  const timer = setTimeout(stop, options.timeoutMs ?? 60_000)
  options.signal?.addEventListener('abort', stop, { once: true })
  try {
    await ended
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
  }
  return { status: stopped ? null : status, stdout, stderr }
}

export interface RunningRelease {
  pid: number
  /** Where the release's own output is written, inside the throwaway home. */
  logFile: string
  /** Whether the release has ended, by itself or because it was stopped. */
  hasExited(): boolean
  /**
   * Stops the release and every process it started, and waits until it has ended: SIGKILL
   * follows SIGTERM after a bounded wait. Answers false when it still had not ended.
   */
  stop(): Promise<boolean>
}

/**
 * Starts `<binary> serve --port <port>` against a throwaway home. It refuses a home this run did
 * not create, and the release gets no environment but the one `releaseEnvironment` builds.
 */
export function startRelease(home: ThrowawayHome, binary: string, port: number, options: { graceMs?: number } = {}): RunningRelease {
  assertOwnHome(home)
  const logFile = join(home.root, 'release.log')
  const output = openSync(logFile, 'a')
  const child = spawn(binary, ['serve', '--port', String(port)], {
    cwd: home.root,
    env: releaseEnvironment(process.env, home.archonHome),
    stdio: ['ignore', output, output],
    detached: process.platform !== 'win32',
    windowsHide: true
  })
  closeSync(output)
  let exited = false
  const ended = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve()
    })
    child.once('error', () => {
      exited = true
      resolve()
    })
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('The release did not start. Is --binary an Archon binary for this machine?')
  return {
    pid,
    logFile,
    hasExited: () => exited,
    async stop() {
      // The tree is ended even after the release itself has: a child it started may be left.
      return endTree(pid, ended, options.graceMs ?? STOP_GRACE_MS)
    }
  }
}
