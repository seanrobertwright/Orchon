// What a gate needs beyond Node: the development dependencies and Orca's generated types.
// This is the one file that may import `node:module`: the lint config bans it everywhere else.
import { createRequire } from 'node:module'

/** A gate could not start because something it needs is not installed. */
export class MissingTooling extends Error {
  override name = 'MissingTooling'
}

/** Whether loading a package failed because it is not installed. */
function isModuleNotFound(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND'
}

const loadFromNodeModules = createRequire(import.meta.url)

/**
 * A development dependency, loaded through Node's own resolver: `orca plugin test` resolves the
 * imports of this folder itself and refuses a package imported by name. Throws `MissingTooling`
 * when the package is not installed.
 */
export function loadPackage(name: 'eslint' | 'typescript'): unknown {
  try {
    return loadFromNodeModules(name)
  } catch (error) {
    if (isModuleNotFound(error)) throw new MissingTooling(`${name} is not installed. Run: npm ci`)
    throw error
  }
}

/**
 * Runs a gate from a test. When its tooling is missing it answers null, so a fresh checkout can
 * still run the other tests; on CI nothing is skipped and the error stands.
 */
export async function withTooling<T>(gate: () => T | Promise<T>): Promise<T | null> {
  try {
    return await gate()
  } catch (error) {
    if (error instanceof MissingTooling && process.env.CI === undefined) return null
    throw error
  }
}

export const INSTALL_HINT = 'Tooling is not installed. Run: npm ci && orca plugin types .'
