// Reads the repository's own files for the gates and for the tests that inspect the source.
// It is development tooling: Orca never loads it, so it is outside the worker's disk module rule.
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Names no gate looks inside, wherever they appear: Git's own data, installed packages, Orca's
 * generated files and the implement flow's runtime state.
 */
export const SKIPPED_NAMES: readonly string[] = ['.git', '.lril', '.orca', 'node_modules']

/** The repository root, with a trailing separator. */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export interface RepoFile {
  /** Path from the repository root, with forward slashes. */
  path: string
  bytes: number
}

/** Whether a path from the repository root lies inside a skipped folder. */
export function isSkippedPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => SKIPPED_NAMES.includes(part))
}

/** The text of one file, named by its path from the repository root. */
export function readRepoText(path: string, root: string = repoRoot): string {
  return readFileSync(join(root, path), 'utf8')
}

/** Every file under `root`, sorted by path, leaving out the skipped names. */
export function listRepoFiles(root: string = repoRoot): RepoFile[] {
  const files: RepoFile[] = []
  const visit = (folder: string): void => {
    for (const name of readdirSync(join(root, folder))) {
      if (SKIPPED_NAMES.includes(name)) continue
      const path = folder === '' ? name : `${folder}/${name}`
      const stat = lstatSync(join(root, path))
      if (stat.isDirectory()) visit(path)
      else files.push({ path, bytes: stat.size })
    }
  }
  visit('')
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
