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
  /** The exit code, or null when the program did not start or was stopped by a signal. */
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Runs a program to its end inside a throwaway home, with the release's environment. Used for
 * the release's own `--version` and `provider add`, and for `git` in the throwaway project.
 */
export function runToEnd(
  home: ThrowawayHome,
  program: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Finished {
  assertOwnHome(home)
  const result = spawnSync(program, [...args], {
    cwd: options.cwd ?? home.root,
    env: releaseEnvironment(process.env, home.archonHome),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    windowsHide: true
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export interface RunningRelease {
  pid: number
  /** Where the release's own output is written, inside the throwaway home. */
  logFile: string
  /** Whether the release has ended, by itself or because it was stopped. */
  hasExited(): boolean
  /** Stops the release and every process it started, and waits until it has ended. */
  stop(): Promise<void>
}

/** Ends a process and its children. `archon serve` runs the server as a child of its own. */
function stopTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    // The release was started as the leader of its own group, so this reaches its children.
    process.kill(-pid, 'SIGTERM')
  } catch {
    // It has already ended.
  }
}

/**
 * Starts `<binary> serve --port <port>` against a throwaway home. It refuses a home this run did
 * not create, and the release gets no environment but the one `releaseEnvironment` builds.
 */
export function startRelease(home: ThrowawayHome, binary: string, port: number): RunningRelease {
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
      if (!exited) stopTree(pid)
      await ended
    }
  }
}
