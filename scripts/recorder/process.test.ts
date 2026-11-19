// The process gateway: a program is started only inside a throwaway home this run made, and it
// sees that home and nothing of the developer's own setup.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test as nodeTest } from 'node:test'
import { afterEach, assert, describe, test } from 'orca/testing'
import { createThrowawayHome, NotOwnHome, type ThrowawayHome } from './home.ts'
import { runToEnd, startRelease } from './process.ts'
import { isA, scratchFolders } from './testing.ts'

const scratch = scratchFolders()

/** What the tests put into this process's environment, taken out again after each test. */
const PLANTED = ['ARCHON_HOME', 'DATABASE_URL', 'ORCHON_TEST_KEY']
const before = new Map(PLANTED.map((name) => [name, process.env[name]]))
afterEach(() => {
  for (const [name, value] of before) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/** A stand-in for the developer's own Archon home, and a throwaway home beside it. */
function homes(): { developer: string; home: ThrowawayHome } {
  const temp = scratch()
  const developer = join(temp, '.archon')
  mkdirSync(developer)
  writeFileSync(join(developer, 'config.yaml'), 'assistants: {}\n')
  return { developer, home: createThrowawayHome({ tempFolder: temp, developerHomes: [developer] }) }
}

/** A file path that marks whether a program ran: the program writes it. */
const printEnvironment = 'process.stdout.write(JSON.stringify(process.env))'

/**
 * A program that starts a second Node process, writes both process ids to `file` and then
 * waits a minute. It stands for a release, or its setup command, that starts a child of its own.
 */
const parentOfSleeper = (file: string): string => `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], { stdio: 'ignore' })
require('node:fs').writeFileSync(${JSON.stringify(file)}, process.pid + ' ' + child.pid)
setTimeout(() => undefined, 60000)
`

const readPids = (file: string): number[] => readFileSync(file, 'utf8').trim().split(' ').map((pid) => Number.parseInt(pid, 10))

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function waitForPids(file: string): Promise<number[]> {
  for (let tries = 0; tries < 200 && !existsSync(file); tries += 1) await sleep(25)
  await sleep(50)
  return readPids(file)
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits a moment for each process to be gone, and fails for one that is still there. */
async function allGone(pids: readonly number[]): Promise<void> {
  assert.ok(pids.length > 0 && pids.every((pid) => Number.isInteger(pid) && pid > 0), `no process ids: ${pids.join(' ')}`)
  for (let tries = 0; tries < 100 && pids.some(isRunning); tries += 1) await sleep(50)
  assert.deepEqual(pids.filter(isRunning), [], 'a process is still running')
}

describe("the recorder's process gateway", () => {
  test('refuses to run anything against a home this run did not make', async () => {
    const { developer, home } = homes()
    const marker = join(scratch(), 'ran.txt')
    const writeMarker = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
    for (const foreign of [
      { ...home, archonHome: developer },
      { ...home, root: developer, archonHome: join(developer, 'archon-home') },
      { ...home, token: 'another-run' }
    ]) {
      await assert.rejects(runToEnd(foreign, process.execPath, ['-e', writeMarker]), isA(NotOwnHome))
      assert.throws(() => startRelease(foreign, process.execPath, 41000), isA(NotOwnHome))
    }
    assert.equal(existsSync(marker), false)
    assert.equal(readFileSync(join(developer, 'config.yaml'), 'utf8'), 'assistants: {}\n')
  })

  test('gives a program the throwaway home and none of the settings of the shell it was run from', async () => {
    const { developer, home } = homes()
    process.env.ARCHON_HOME = developer
    process.env.DATABASE_URL = 'postgres://example.invalid/archon'
    process.env.ORCHON_TEST_KEY = 'key'
    const done = await runToEnd(home, process.execPath, ['-e', printEnvironment])
    assert.equal(done.status, 0)
    const env = JSON.parse(done.stdout) as Record<string, string>
    assert.equal(env.ARCHON_HOME, home.archonHome)
    assert.equal(env.DATABASE_URL, undefined)
    assert.equal(env.ORCHON_TEST_KEY, undefined)
    assert.equal(env.ARCHON_TELEMETRY_DISABLED, '1')
  })

  test('runs a program inside the throwaway folder unless told where', async () => {
    const { home } = homes()
    const printFolder = 'process.stdout.write(process.cwd())'
    assert.equal((await runToEnd(home, process.execPath, ['-e', printFolder])).stdout, home.root)
    assert.equal((await runToEnd(home, process.execPath, ['-e', printFolder], { cwd: home.archonHome })).stdout, home.archonHome)
  })

  test('answers the exit code and the output of a program that fails, and null for one that does not start', async () => {
    const { home } = homes()
    const failed = await runToEnd(home, process.execPath, ['-e', 'console.error("no"); process.exit(3)'])
    assert.equal(failed.status, 3)
    assert.match(failed.stderr, /no/)
    assert.equal((await runToEnd(home, join(home.root, 'no-such-program'), [])).status, null)
  })

  test('starts a release with `serve` and its port, logs its output inside the home, and knows when it has ended', async () => {
    const { home } = homes()
    // Node stands in for the release: `node serve --port 41000` fails at once, as no such file exists.
    const release = startRelease(home, process.execPath, 41000)
    assert.ok(release.pid > 0)
    assert.equal(release.logFile, join(home.root, 'release.log'))
    for (let tries = 0; tries < 200 && !release.hasExited(); tries += 1) await new Promise((done) => setTimeout(done, 25))
    assert.equal(release.hasExited(), true)
    await release.stop()
    assert.match(readFileSync(release.logFile, 'utf8'), /serve/)
  })

  test('stops a release that is still running', async () => {
    const { home } = homes()
    // A program that would run for a minute: a script named `serve` in the throwaway folder.
    writeFileSync(join(home.root, 'serve'), 'setTimeout(() => undefined, 60_000)\n')
    const release = startRelease(home, process.execPath, 41000)
    await new Promise((done) => setTimeout(done, 300))
    assert.equal(release.hasExited(), false)
    await release.stop()
    assert.equal(release.hasExited(), true)
  })

  test('stops a program it runs to its end, and every process that program started, when the recording is interrupted', async () => {
    const { home } = homes()
    const pids = join(home.root, 'pids.txt')
    const controller = new AbortController()
    const started = performance.now()
    setTimeout(() => controller.abort(), 500)
    const done = await runToEnd(home, process.execPath, ['-e', parentOfSleeper(pids)], { signal: controller.signal, timeoutMs: 60_000 })
    assert.equal(done.status, null)
    assert.ok(performance.now() - started < 15_000, 'the program was not stopped')
    await allGone(readPids(pids))
  })

  test('does not start a program once the recording is interrupted', async () => {
    const { home } = homes()
    const marker = join(home.root, 'ran.txt')
    const done = await runToEnd(home, process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], {
      signal: AbortSignal.abort()
    })
    assert.equal(done.status, null)
    assert.equal(existsSync(marker), false)
  })

  test('stops a program that outlives its time limit', async () => {
    const { home } = homes()
    const started = performance.now()
    const done = await runToEnd(home, process.execPath, ['-e', 'setTimeout(() => undefined, 60_000)'], { timeoutMs: 300 })
    assert.equal(done.status, null)
    assert.ok(performance.now() - started < 15_000)
  })

  test('stops the processes a release started along with it', async () => {
    const { home } = homes()
    const pids = join(home.root, 'pids.txt')
    writeFileSync(join(home.root, 'serve'), parentOfSleeper(pids))
    const release = startRelease(home, process.execPath, 41000)
    const children = await waitForPids(pids)
    await release.stop()
    assert.equal(release.hasExited(), true)
    await allGone(children)
  })

  // Windows has no SIGTERM to ignore: taskkill /F ends the tree at once.
  const onWindows = process.platform === 'win32' ? 'Windows has no SIGTERM to ignore' : false
  nodeTest('kills a release that ignores the request to stop, after a bounded wait', { skip: onWindows }, async () => {
    const { home } = homes()
    const pids = join(home.root, 'pids.txt')
    writeFileSync(
      join(home.root, 'serve'),
      `process.on('SIGTERM', () => undefined)
require('node:fs').writeFileSync(${JSON.stringify(pids)}, String(process.pid))
setInterval(() => undefined, 1000)
`
    )
    const release = startRelease(home, process.execPath, 41000, { graceMs: 300 })
    await waitForPids(pids)
    const started = performance.now()
    await release.stop()
    assert.equal(release.hasExited(), true)
    assert.ok(performance.now() - started < 5000, 'the release was not killed after the wait')
  })
})
