// The fixture recorder. A developer runs it by hand, once per supported Archon release:
//
//   node scripts/record-fixtures.ts <release> --binary <path> [--port <port>] [--out <folder>]
//
// It boots the release's own binary against a throwaway Archon home it makes in the temp
// folder, records what the API answers, stops the release, deletes the home, scrubs what it
// recorded and writes the fixtures with a log. It never reads or writes the developer's own
// Archon home and never calls the developer's own Archon. Orca never loads this file.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArguments, USAGE } from './recorder/arguments.ts'
import { nowIso } from './recorder/clock.ts'
import { createThrowawayHome, removeThrowawayHome } from './recorder/home.ts'
import { createLoopbackClient, type LoopbackClient } from './recorder/http.ts'
import { recordedLog } from './recorder/log.ts'
import { writeFixtures } from './recorder/output.ts'
import { runToEnd, startRelease, type RunningRelease } from './recorder/process.ts'
import { createThrowawayProject } from './recorder/project.ts'
import { recordRelease } from './recorder/scenarios.ts'
import { createScrubber, machineRules } from './recorder/scrub.ts'
import { createSession, scrubFiles } from './recorder/session.ts'
import { repoRoot } from './repo-files.ts'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** How long a release may take to answer its first health check: it downloads its server first. */
const BOOT_TIMEOUT_MS = 300_000

/**
 * The provider installed into the throwaway home with the release's own `provider add`. No
 * workflow the recorder launches uses it. Archon uses it for one thing: the title it writes
 * with its small model for each launch that saves a message.
 */
const PROVIDER = 'claude'

async function healthOf(client: LoopbackClient): Promise<unknown> {
  try {
    const answer = await client.request('GET', '/api/health')
    return answer.status === 200 ? answer.body : null
  } catch {
    return null
  }
}

async function answersAtAll(client: LoopbackClient): Promise<boolean> {
  try {
    await client.request('GET', '/api/health')
    return true
  } catch {
    return false
  }
}

function lastLines(file: string, count: number): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-count).join('\n')
  } catch {
    return ''
  }
}

async function waitUntilHealthy(client: LoopbackClient, release: RunningRelease): Promise<unknown> {
  const until = performance.now() + BOOT_TIMEOUT_MS
  while (performance.now() < until) {
    const health = await healthOf(client)
    if (health !== null) return health
    if (release.hasExited()) {
      throw new Error(`The release ended before it answered.\n${lastLines(release.logFile, 30)}`)
    }
    await sleep(500)
  }
  throw new Error(`The release did not answer within ${BOOT_TIMEOUT_MS / 1000} seconds.\n${lastLines(release.logFile, 30)}`)
}

/** The store id a health answer reports, when the release reports one. */
function storeIdOf(health: unknown): string | null {
  if (typeof health !== 'object' || health === null || !Object.hasOwn(health, 'storeId')) return null
  const storeId: unknown = (health as Record<string, unknown>).storeId
  return typeof storeId === 'string' && storeId !== '' ? storeId : null
}

/** The version a health answer reports. */
function versionOf(health: unknown): string | null {
  if (typeof health !== 'object' || health === null || !Object.hasOwn(health, 'version')) return null
  const version: unknown = (health as Record<string, unknown>).version
  return typeof version === 'string' ? version : null
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2))
  if ('error' in args) {
    console.error(`${args.error}\n\n${USAGE}`)
    return 2
  }
  const binary = resolve(args.binary)
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    console.error('--binary does not name a file.')
    return 2
  }
  const outFolder = args.out === null ? join(repoRoot, 'fixtures', args.release) : resolve(args.out)
  const client = createLoopbackClient(args.port)
  if (await answersAtAll(client)) {
    console.error(`Something already answers on port ${args.port}. The recorder did not start it: name another --port.`)
    return 2
  }

  const recordedAt = nowIso()
  const binaryBytes = readFileSync(binary)
  const home = createThrowawayHome()
  console.log('Made a throwaway Archon home in the temp folder.')
  let release: RunningRelease | undefined
  let failure: string | null = null
  let reportedVersion = ''
  let serverVersion: string | null = null
  const session = createSession(args.release, client)
  // Every folder and name of this machine that a fixture must not hold.
  const scrubber = createScrubber(
    machineRules({
      projectFolder: home.projectFolder,
      archonHome: home.archonHome,
      recorderFolder: home.root,
      tempFolder: tmpdir(),
      homeFolder: homedir(),
      binary,
      user: userInfo().username,
      host: hostname()
    })
  )
  // Whatever goes wrong, the release is stopped and its home deleted: Ctrl+C ends the recording
  // early, and a rejection nobody awaited is kept as the failure instead of ending the process.
  const interrupted = new Promise<never>((_, reject) => {
    process.once('SIGINT', () => reject(new Error('Interrupted before the recording was complete.')))
  })
  process.on('unhandledRejection', (reason) => {
    failure ??= reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  })
  try {
    const version = runToEnd(home, binary, ['--version'])
    reportedVersion = version.stdout.trim()
    if (version.status !== 0 || !reportedVersion.includes(args.release)) {
      throw new Error(`The binary does not report release ${args.release}. It printed: ${reportedVersion || version.stderr.trim()}`)
    }
    // A fresh home has no provider, and a release with none refuses to create a conversation.
    const provider = runToEnd(home, binary, ['provider', 'add', PROVIDER], { timeoutMs: BOOT_TIMEOUT_MS })
    if (provider.status === 0) console.log(`Installed the ${PROVIDER} provider into the throwaway home.`)
    else session.missing(`the ${PROVIDER} provider`, `\`provider add ${PROVIDER}\` failed: ${(provider.stderr || provider.stdout).trim()}`)
    const projectFolder = createThrowawayProject(home)
    release = startRelease(home, binary, args.port)
    console.log(`Started the release on port ${args.port}. Waiting for it to answer.`)
    const health = await waitUntilHealthy(client, release)
    serverVersion = versionOf(health)
    const storeId = storeIdOf(health)
    if (storeId !== null) scrubber.learnStoreId(storeId)
    await Promise.race([recordRelease(session, { projectFolder, archonHome: home.archonHome }), interrupted])
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
  } finally {
    await release?.stop()
    // The release must be gone before its home is: nothing may be left running.
    for (let tries = 0; tries < 40 && (await answersAtAll(client)); tries += 1) await sleep(250)
    if (await answersAtAll(client)) console.error(`Port ${args.port} still answers after the release was stopped.`)
    try {
      removeThrowawayHome(home)
      console.log('Stopped the release and deleted the throwaway home.')
    } catch (error) {
      console.error(`The throwaway home could not be deleted. Delete it by hand: ${home.root}
${String(error)}`)
    }
  }

  if (failure !== null) session.missing('everything after the failure', scrubber.scrub(failure.split('\n')[0] ?? failure))
  const { files, refused } = scrubFiles(session.files, scrubber)
  for (const file of refused) {
    session.missing(file.path, `it still held ${file.holds.join(', ')} after scrubbing, so it was not written`)
  }
  const log = recordedLog({
    release: args.release,
    recordedAt,
    binary: {
      name: basename(binary),
      bytes: binaryBytes.byteLength,
      sha256: createHash('sha256').update(binaryBytes).digest('hex'),
      reports: scrubber.scrub(reportedVersion)
    },
    platform: `${process.platform} ${process.arch}`,
    serverVersion,
    files,
    gaps: session.gaps.map((gap) => ({ what: gap.what, why: scrubber.scrub(gap.why) }))
  })
  writeFixtures(outFolder, files, log)
  console.log(`${files.length} fixtures and RECORDED.md written.`)
  if (failure !== null) console.error(scrubber.scrub(failure))
  return failure !== null || refused.length > 0 ? 1 : 0
}

if (import.meta.main) process.exitCode = await main()
