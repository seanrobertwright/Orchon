// The environment the release is started with. It is built from a short list of names, so
// nothing the developer's shell holds (an Archon home, a database URL, a provider key) reaches it.

/** What a program needs from the operating system to start and to find other programs. */
const PASSED_NAMES: readonly string[] = [
  // Windows
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'TEMP',
  'TMP',
  // POSIX
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  // Both
  'PATH'
]

/**
 * How the release may reach the Claude login. Claude Code, which the claude provider starts,
 * reads its login from the folder `CLAUDE_CONFIG_DIR` names, and from `.claude` in the home
 * folder when none is named. `hidden` names an empty throwaway folder, so no login is found and
 * no model can be called. `passed`, for spend mode only, leaves the home folder to Claude and
 * passes on the two names that point at the developer's own setup: the config folder and the
 * binary. Neither is a secret, and no key or token is ever passed.
 */
export type ProviderLogin = { kind: 'hidden'; emptyConfigFolder: string } | { kind: 'passed' }

/** Names that point Claude at a login or a binary. Passed on in spend mode only. */
const LOGIN_NAMES: readonly string[] = ['CLAUDE_CONFIG_DIR', 'CLAUDE_BIN_PATH']

/**
 * The release's whole environment: the operating system's own names from `parent`, the throwaway
 * Archon home, telemetry turned off, and the Claude login hidden or passed as `login` says. Names
 * compare without regard to case, as Windows does.
 */
export function releaseEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  archonHome: string,
  login: ProviderLogin
): Record<string, string> {
  const passed = new Set([...PASSED_NAMES, ...(login.kind === 'passed' ? LOGIN_NAMES : [])].map((name) => name.toLowerCase()))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && passed.has(name.toLowerCase())) env[name] = value
  }
  env.ARCHON_HOME = archonHome
  env.ARCHON_TELEMETRY_DISABLED = '1'
  env.DO_NOT_TRACK = '1'
  if (login.kind === 'hidden') env.CLAUDE_CONFIG_DIR = login.emptyConfigFolder
  return env
}
