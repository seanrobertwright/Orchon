// The recorder's command line, parsed before anything is started.

/** The port a developer's own Archon listens on by default. The recorder never binds or calls it. */
export const DEVELOPER_PORT = 3090

/** The port the release is bound to when none is named. */
export const DEFAULT_PORT = 39417

export const USAGE = [
  'Usage: node scripts/record-fixtures.ts <release> --binary <path> [--port <port>] [--out <folder>]',
  '',
  '  <release>   the Archon release to record, as three numbers: 0.12.1',
  "  --binary    the release's own `archon` binary, downloaded from its GitHub release",
  `  --port      a free loopback port from 1024 to 65535, not ${DEVELOPER_PORT} (default ${DEFAULT_PORT})`,
  '  --out       where the fixtures are written (default fixtures/<release>)'
].join('\n')

export interface RecorderArguments {
  release: string
  binary: string
  port: number
  /** Null for the default folder, `fixtures/<release>` in this repository. */
  out: string | null
}

const FLAGS = ['--binary', '--port', '--out'] as const
type Flag = (typeof FLAGS)[number]

const isFlag = (value: string): value is Flag => (FLAGS as readonly string[]).includes(value)

/** A whole number written in digits only, or null. `Number()` alone would accept `1e3` and ` 5 `. */
function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1024 && port <= 65535 ? port : null
}

/** The arguments, or one sentence saying what is wrong with them. */
export function parseArguments(args: readonly string[]): RecorderArguments | { error: string } {
  const values = new Map<Flag, string>()
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (!arg.startsWith('--')) {
      positional.push(arg)
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
  return { release, binary, port, out: values.get('--out') ?? null }
}
