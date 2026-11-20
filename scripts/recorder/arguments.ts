// The recorder's command line, parsed before anything is started.
import { isRefusal, type Refusal } from '../shape.ts'
import { isSpendScenarioName, SPEND_SCENARIO_NAMES, SPEND_SCENARIOS, spendsTokens, type SpendScenarioName } from './spend.ts'

/** The port a developer's own Archon listens on by default. The recorder never binds or calls it. */
export const DEVELOPER_PORT = 3090

/** The port the release is bound to when none is named. */
export const DEFAULT_PORT = 39417

/** The one flag that takes no value. Without it, no scenario that calls a model runs. */
export const ALLOW_SPEND = '--allow-token-spend'

export const USAGE = [
  'Usage: node scripts/record-fixtures.ts <release> --binary <path> [--port <port>] [--out <folder>]',
  `       node scripts/record-fixtures.ts <release> --binary <path> --scenario <name> [${ALLOW_SPEND} --token-ceiling <tokens>]`,
  '',
  '  <release>   the Archon release to record, as three numbers: 0.12.1',
  "  --binary    the release's own `archon` binary, downloaded from its GitHub release",
  `  --port      a free loopback port from 1024 to 65535, not ${DEVELOPER_PORT} (default ${DEFAULT_PORT})`,
  '  --out       where the fixtures are written (default fixtures/<release>, or fixtures/<release>/spend/<name>)',
  '',
  'Spend mode records one scenario alone:',
  `  --scenario           one of ${SPEND_SCENARIO_NAMES.join(', ')}`,
  `  ${ALLOW_SPEND}  required by a scenario that calls a model: it spends your Claude allowance`,
  '  --token-ceiling      required with it: the most tokens the run may spend before it is cancelled',
  ...SPEND_SCENARIO_NAMES.map(
    (name) =>
      `    ${name}: a ceiling of at most ${SPEND_SCENARIOS[name].maxTokenCeiling} tokens, cancelled after ${SPEND_SCENARIOS[name].wallClockMs / 60_000} minutes`
  )
].join('\n')

export interface RecorderArguments {
  release: string
  binary: string
  port: number
  /** Null for the default folder: `fixtures/<release>`, or `fixtures/<release>/spend/<name>` for a scenario. */
  out: string | null
  /** The spend-mode scenario, or null for the recording that spends nothing. */
  scenario: { name: SpendScenarioName; tokenCeiling: number } | null
}

const FLAGS = ['--binary', '--port', '--out', '--scenario', '--token-ceiling'] as const
type Flag = (typeof FLAGS)[number]

const isFlag = (value: string): value is Flag => (FLAGS as readonly string[]).includes(value)

/** A whole number written in digits only, or null. `Number()` alone would accept `1e3` and ` 5 `. */
function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1024 && port <= 65535 ? port : null
}

/** The scenario and its ceiling, or one sentence saying why the run may not start. */
function parseScenario(
  release: string,
  name: string | undefined,
  ceilingText: string | undefined,
  allowSpend: boolean
): RecorderArguments['scenario'] | Refusal {
  if (name === undefined) {
    if (allowSpend || ceilingText !== undefined) {
      return { error: `${ALLOW_SPEND} and --token-ceiling go with --scenario, which names what to spend on.` }
    }
    return null
  }
  if (!isSpendScenarioName(name)) return { error: `--scenario is one of ${SPEND_SCENARIO_NAMES.join(', ')}.` }
  const scenario = SPEND_SCENARIOS[name]
  if (scenario.onlyRelease !== null && scenario.onlyRelease !== release) {
    return { error: `The ${name} scenario runs on ${scenario.onlyRelease} only: earlier releases answer its routes with their HTML page.` }
  }
  if (!spendsTokens(name)) {
    if (allowSpend || ceilingText !== undefined) {
      return { error: `The ${name} scenario spends no tokens: run it without ${ALLOW_SPEND} and --token-ceiling.` }
    }
    return { name, tokenCeiling: 0 }
  }
  if (!allowSpend) return { error: `No ${ALLOW_SPEND}, no spend: the ${name} scenario calls a model through your Claude login.` }
  if (ceilingText === undefined) {
    return { error: `Name the ${name} scenario's token ceiling with --token-ceiling, at most ${scenario.maxTokenCeiling}.` }
  }
  const ceiling = /^\d{1,7}$/.test(ceilingText) ? Number(ceilingText) : null
  if (ceiling === null || ceiling < 1 || ceiling > scenario.maxTokenCeiling) {
    return { error: `The token ceiling is a whole number of tokens from 1 to at most ${scenario.maxTokenCeiling}.` }
  }
  return { name, tokenCeiling: ceiling }
}

/** The arguments, or one sentence saying what is wrong with them. */
export function parseArguments(args: readonly string[]): RecorderArguments | Refusal {
  const values = new Map<Flag, string>()
  const positional: string[] = []
  let allowSpend = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    if (arg === ALLOW_SPEND) {
      if (allowSpend) return { error: `${arg} is given twice.` }
      allowSpend = true
      continue
    }
    if (!isFlag(arg)) return { error: `Unknown option ${arg}.` }
    if (values.has(arg)) return { error: `${arg} is given twice.` }
    const value = args[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) return { error: `${arg} needs a value.` }
    values.set(arg, value)
    index += 1
  }
  const [release, ...rest] = positional
  if (release === undefined) return { error: 'Name the release to record.' }
  if (rest.length > 0) return { error: 'Name one release.' }
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(release)) {
    return { error: 'The release is three numbers, such as 0.12.1.' }
  }
  const binary = values.get('--binary')
  if (binary === undefined) return { error: "--binary is required: the release's own archon binary." }
  const portText = values.get('--port')
  const port = portText === undefined ? DEFAULT_PORT : parsePort(portText)
  if (port === null) return { error: '--port is a whole number from 1024 to 65535.' }
  if (port === DEVELOPER_PORT) {
    return { error: `Port ${DEVELOPER_PORT} is where your own Archon listens. The recorder never uses it.` }
  }
  const scenario = parseScenario(release, values.get('--scenario'), values.get('--token-ceiling'), allowSpend)
  if (scenario !== null && isRefusal(scenario)) return scenario
  return { release, binary, port, out: values.get('--out') ?? null, scenario }
}
