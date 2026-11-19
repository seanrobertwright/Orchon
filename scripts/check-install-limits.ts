// Orca's listing limits for an installed plugin. The plugin sits at the repository root, so
// tests, docs and source all count.
//
//   node scripts/check-install-limits.ts
import { hasExtension, listRepoFiles, SOURCE_EXTENSIONS } from './repo-files.ts'

const MIB = 1024 * 1024

export const INSTALL_LIMITS = {
  files: 2000,
  totalBytes: 50 * MIB,
  /** For one file Orca transpiles when it loads the plugin. */
  transpiledFileBytes: MIB
} as const

const count = (value: number): string => value.toLocaleString('en-US')
const mib = (bytes: number): string => `${count(bytes / MIB)} MiB`

/** One sentence for each total the files exceed and for each oversized file Orca transpiles; empty when they fit. */
export function checkInstallLimits(files: readonly { path: string; bytes: number }[]): string[] {
  const { files: fileLimit, totalBytes, transpiledFileBytes } = INSTALL_LIMITS
  const problems: string[] = []
  if (files.length > fileLimit) {
    problems.push(`${count(files.length)} files: the limit is ${count(fileLimit)}.`)
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  if (total > totalBytes) {
    problems.push(`${count(total)} bytes in total: the limit is ${count(totalBytes)} (${mib(totalBytes)}).`)
  }
  for (const file of files) {
    if (hasExtension(file.path, SOURCE_EXTENSIONS.transpiled) && file.bytes > transpiledFileBytes) {
      problems.push(
        `${file.path} is ${count(file.bytes)} bytes: a file Orca transpiles may be at most ${count(transpiledFileBytes)} (${mib(transpiledFileBytes)}).`
      )
    }
  }
  return problems
}

function main(): number {
  const files = listRepoFiles()
  const problems = checkInstallLimits(files)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) return 1
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  console.log(`${count(files.length)} files, ${count(total)} bytes: within Orca's install limits.`)
  return 0
}

if (import.meta.main) process.exitCode = main()
