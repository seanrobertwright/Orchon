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
 * The release's whole environment: the operating system's own names from `parent`, the throwaway
 * Archon home, and telemetry turned off. Names compare without regard to case, as Windows does.
 */
export function releaseEnvironment(parent: Readonly<Record<string, string | undefined>>, archonHome: string): Record<string, string> {
  const passed = new Set(PASSED_NAMES.map((name) => name.toLowerCase()))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && passed.has(name.toLowerCase())) env[name] = value
  }
  env.ARCHON_HOME = archonHome
  env.ARCHON_TELEMETRY_DISABLED = '1'
  env.DO_NOT_TRACK = '1'
  return env
}
