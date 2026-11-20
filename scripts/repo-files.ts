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
export function readRepoText(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8')
}

/** Every file of the repository, sorted by path, leaving out the skipped names. */
export function listRepoFiles(): RepoFile[] {
  const files: RepoFile[] = []
  const visit = (folder: string): void => {
    for (const name of readdirSync(join(repoRoot, folder))) {
      if (SKIPPED_NAMES.includes(name)) continue
      const path = folder === '' ? name : `${folder}/${name}`
      const stat = lstatSync(join(repoRoot, path))
      if (stat.isDirectory()) visit(path)
      else files.push({ path, bytes: stat.size })
    }
  }
  visit('')
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The file extensions of code, without the dot. scripts/source-extensions.json is the one list:
 * the lint config reads the same file, so the gates cannot disagree about what counts as code.
 */
export interface SourceExtensions {
  /** What the type-check reads. */
  typescript: readonly string[]
  javascript: readonly string[]
  /** What Orca transpiles when it loads the plugin; each such file has a size limit. */
  transpiled: readonly string[]
}

function extensionList(value: unknown, key: string): string[] {
  const list: unknown = typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`scripts/source-extensions.json: "${key}" is not a list of extensions`)
  }
  return list.map((entry: unknown) => {
    if (typeof entry !== 'string' || !/^[a-z]+$/.test(entry)) {
      throw new Error(`scripts/source-extensions.json: "${key}" holds something that is not an extension`)
    }
    return entry
  })
}

function readSourceExtensions(): SourceExtensions {
  const parsed: unknown = JSON.parse(readRepoText('scripts/source-extensions.json'))
  return {
    typescript: extensionList(parsed, 'typescript'),
    javascript: extensionList(parsed, 'javascript'),
    transpiled: extensionList(parsed, 'transpiled')
  }
}

export const SOURCE_EXTENSIONS: SourceExtensions = readSourceExtensions()

/** Every extension of code: TypeScript and JavaScript. */
export const CODE_EXTENSIONS: readonly string[] = [
  ...SOURCE_EXTENSIONS.typescript,
  ...SOURCE_EXTENSIONS.javascript
]

/** Whether `path` ends in a dot and one of `extensions`. */
export function hasExtension(path: string, extensions: readonly string[]): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && extensions.includes(path.slice(dot + 1))
}

/**
 * The lines under one markdown heading, up to the next heading of the same or a higher level.
 * `heading` is the whole heading line, such as `## 0.1.0`; a line that adds words after it
 * (`## 0.1.0 (unreleased)`) also matches. Lines end in `\n` or `\r\n`. Null when there is no
 * such heading.
 */
export function markdownSection(text: string, heading: string): string[] | null {
  const level = /^#+/.exec(heading)?.[0].length ?? 0
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => {
    const hashes = /^(#+) /.exec(line)?.[1]?.length
    return hashes !== undefined && hashes <= level
  })
  return end === -1 ? rest : rest.slice(0, end)
}
