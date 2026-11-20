// The fixture recorder. A developer runs it by hand, once per supported Archon release:
//
//   node scripts/record-fixtures.ts <release> --binary <path> [--port <port>] [--out <folder>]
//
// or, in spend mode, one scenario alone that only a live model can give:
//
//   node scripts/record-fixtures.ts <release> --binary <path> --scenario <name> [--allow-token-spend --token-ceiling <tokens>]
//
// It boots the release's own binary against a throwaway Archon home it makes in the temp
// folder, records what the API answers, stops the release, deletes the home, scrubs what it
// recorded and writes the fixtures with a log. It never reads or writes the developer's own
// Archon home and never calls the developer's own Archon. Orca never loads this file. The
// release is given the developer's Claude login only in spend mode, for a scenario that calls a
// model, and only as the folder and binary names that point at it.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArguments, USAGE } from './recorder/arguments.ts'
import { BOOT_TIMEOUT_MS, waitUntilHealthy } from './recorder/boot.ts'
import { nowIso } from './recorder/clock.ts'
import { claudeLoginFolder, type LoginMode } from './recorder/environment.ts'
import { createThrowawayHome, removeThrowawayHome, writeSpendConfig } from './recorder/home.ts'
import { createLoopbackClient, type LoopbackClient } from './recorder/http.ts'
import { untilInterrupted, watchInterrupts } from './recorder/interrupt.ts'
import { findLeaks, type LeakRules } from './recorder/leaks.ts'
import { recordedLog, type SpendLog } from './recorder/log.ts'
import { SPEND_FOLDER, writeRecording } from './recorder/output.ts'
import { runToEnd, startRelease, type RunningRelease } from './recorder/process.ts'
import { createThrowawayProject } from './recorder/project.ts'
import { recordRelease } from './recorder/scenarios.ts'
import { createScrubber, machineRules, type Machine } from './recorder/scrub.ts'
import { createSession, scrubFiles } from './recorder/session.ts'
import { SPEND_SCENARIOS, spendsTokens } from './recorder/spend.ts'
import { recordSpendScenario, StopTheRelease } from './recorder/spend-scenarios.ts'
import { sleep } from './recorder/wait.ts'
import { repoRoot } from './repo-files.ts'
import { field, isRefusal, text } from './shape.ts'

/**
 * The provider installed into the throwaway home with the release's own `provider add`. A
 * release with none refuses to create a conversation. Without spend mode the release cannot
 * reach the Claude login, so the title Archon would write with its small model for each launch
 * falls back to the launch message. In spend mode it runs the agent step and the chat turn.
 */
const PROVIDER = 'claude'

async function answersAtAll(client: LoopbackClient): Promise<boolean> {
  try {
    await client.request('GET', '/api/health')
    return true
  } catch {
    return false
  }
}

/** The store id a health answer reports, when the release reports one. */
const storeIdOf = (health: unknown): string | null => text(field(health, 'storeId')) ?? null

/** The version a health answer reports. */
function versionOf(health: unknown): string | null {
  const version = field(health, 'version')
  return typeof version === 'string' ? version : null
}

/**
 * One recording, from the checks of the command line to the fixtures on disk. `signal` aborts at
 * the first Ctrl+C: every wait then ends, and the release is stopped and its home deleted.
 */
async function record(signal: AbortSignal): Promise<number> {
  const args = parseArguments(process.argv.slice(2))
  if (isRefusal(args)) {
    console.error(`${args.error}\n\n${USAGE}`)
    return 2
  }
  const binary = resolve(args.binary)
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    console.error('--binary does not name a file.')
    return 2
  }
  const scenario = args.scenario
  const passLogin = scenario !== null && spendsTokens(scenario.name)
  const login: LoginMode = passLogin ? 'passed' : 'hidden'
  const releaseFolder = join(repoRoot, 'fixtures', args.release)
  const outFolder = args.out !== null ? resolve(args.out) : scenario === null ? releaseFolder : join(releaseFolder, SPEND_FOLDER, scenario.name)
  const client = createLoopbackClient(args.port)
  if (await answersAtAll(client)) {
    console.error(`Something already answers on port ${args.port}. The recorder did not start it: name another --port.`)
    return 2
  }
  if (signal.aborted) return 130

  if (scenario !== null) {
    const { wallClockMs } = SPEND_SCENARIOS[scenario.name]
    console.log(
      passLogin
        ? `Spend mode: the ${scenario.name} scenario alone, cancelled past ${scenario.tokenCeiling} tokens or ${wallClockMs / 60_000} minutes. The release is given your Claude login by folder only. Ctrl+C stops it at any time.`
        : `The ${scenario.name} scenario alone. It spends no tokens, and the release is not given your Claude login.`
    )
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
  let spend: SpendLog | undefined
  // Every folder and name of this machine that a fixture must not hold, by path and name only:
  // nothing in them is read. The scrubber replaces them, and the leak check looks for them after.
  const machine: Machine = {
    projectFolder: home.projectFolder,
    archonHome: home.archonHome,
    recorderFolder: home.root,
    tempFolder: tmpdir(),
    homeFolder: homedir(),
    claudeConfig: claudeLoginFolder(process.env, homedir()),
    binary,
    user: userInfo().username,
    host: hostname()
  }
  const leaks: LeakRules = machine
  const scrubber = createScrubber(machineRules(machine))
  // Whatever goes wrong, the release is stopped and its home deleted. A rejection nobody awaited
  // is kept as the failure instead of ending the process.
  process.on('unhandledRejection', (reason) => {
    failure ??= reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  })
  try {
    const version = await runToEnd(home, binary, ['--version'], { signal })
    signal.throwIfAborted()
    reportedVersion = version.stdout.trim()
    if (version.status !== 0 || !reportedVersion.includes(args.release)) {
      throw new Error(`The binary does not report release ${args.release}. It printed: ${reportedVersion || version.stderr.trim()}`)
    }
    // A fresh home has no provider, and a release with none refuses to create a conversation.
    const provider = await runToEnd(home, binary, ['provider', 'add', PROVIDER], { timeoutMs: BOOT_TIMEOUT_MS, signal })
    signal.throwIfAborted()
    if (provider.status === 0) console.log(`Installed the ${PROVIDER} provider into the throwaway home.`)
    else session.missing(`the ${PROVIDER} provider`, `\`provider add ${PROVIDER}\` failed: ${(provider.stderr || provider.stdout).trim()}`)
    // The throwaway home's own config pins the small tier and the chat to Haiku. The developer's is never read.
    if (passLogin) writeSpendConfig(home)
    const projectFolder = await createThrowawayProject(home, signal, {
      agentStep: scenario?.name === 'agent-step',
      syntheticMetrics: scenario?.name === 'metrics'
    })
    signal.throwIfAborted()
    release = startRelease(home, binary, args.port, { login })
    console.log(`Started the release on port ${args.port}. Waiting for it to answer.`)
    const health = await waitUntilHealthy({ client, release, signal })
    serverVersion = versionOf(health)
    const storeId = storeIdOf(health)
    if (storeId !== null) scrubber.learnStoreId(storeId)
    if (scenario === null) {
      await Promise.race([recordRelease(session, { projectFolder, archonHome: home.archonHome }), untilInterrupted(signal)])
    } else {
      const { wallClockMs } = SPEND_SCENARIOS[scenario.name]
      spend = { scenario: scenario.name, tokenCeiling: scenario.tokenCeiling, wallClockMs, tokensSeen: 0, crossed: null, login }
      const outcome = await Promise.race([
        recordSpendScenario(session, scenario.name, { projectFolder, tokenCeiling: scenario.tokenCeiling }),
        untilInterrupted(signal)
      ])
      spend = { ...spend, ...outcome }
      console.log(`Archon reported ${outcome.tokensSeen} tokens.${outcome.crossed === null ? '' : ` The ${outcome.crossed.by} ceiling was crossed and the run was cancelled.`}`)
    }
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
    if (error instanceof StopTheRelease && spend !== undefined) spend = { ...spend, ...error.outcome }
  } finally {
    // The release must be gone before its home is: nothing may be left running.
    if (release !== undefined && !(await release.stop())) {
      console.error(`The release (process ${release.pid}) had not ended after it was killed.`)
    }
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
  const { files, refused } = scrubFiles(session.files, scrubber, leaks)
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
    gaps: session.gaps.map((gap) => ({ what: gap.what, why: scrubber.scrub(gap.why) })),
    ...(spend === undefined ? {} : { spend })
  })
  // The log is checked as the fixtures are. One that still leaks is neither written nor printed.
  const logLeaks = findLeaks(log, leaks)
  // A failed or interrupted run, or one that held a fixture back, replaces nothing.
  const complete = failure === null && refused.length === 0 && logLeaks.length === 0 && !signal.aborted
  if (writeRecording(outFolder, { files, log, complete }) === 'written') {
    console.log(`${files.length} fixtures and RECORDED.md written.`)
  } else {
    const shown = logLeaks.length === 0 ? `Its log:\n\n${log}` : `Its log still held ${logLeaks.join(', ')}, so it is not shown.`
    console.error(`The recording is not complete, so nothing was written and ${outFolder} is as it was. ${shown}`)
  }
  if (failure !== null) console.error(scrubber.scrub(failure))
  if (signal.aborted) return 130
  return complete ? 0 : 1
}

async function main(): Promise<number> {
  // Listening starts before anything is made, and stops only after the cleanup: until then a
  // second Ctrl+C is held, so it cannot end the recorder with the release still running.
  const watch = watchInterrupts(process, (line) => console.error(line))
  try {
    return await record(watch.signal)
  } finally {
    watch.dispose()
  }
}

if (import.meta.main) {
  const code = await main()
  // After an interruption the scenario that was running is abandoned, and its waits would keep
  // the process alive against a release that is gone. The cleanup is done, so the recorder ends.
  if (code === 130) process.exit(code)
  process.exitCode = code
}
