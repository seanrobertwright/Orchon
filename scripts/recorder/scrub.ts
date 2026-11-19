// Takes machine paths, account names and store ids out of what was recorded, before any of it
// is written, and strings shaped like a key or a token. A fixture is refused when something it
// was told to remove is still there.
import { holdsToken, scrubTokens, TOKEN } from './tokens.ts'

export interface ScrubRules {
  /** Folders of this machine and what each is written as, such as `<project-path>`. */
  paths: readonly { path: string; as: string }[]
  /** Account and machine names and what each is written as, such as `<user>`. */
  names: readonly { name: string; as: string }[]
}

/**
 * Every placeholder a fixture can hold, with what it stands for. The scrubber writes them and
 * the log beside the fixtures lists them, from this one table.
 */
export const PLACEHOLDERS = {
  projectFolder: { as: '<project-path>', stands: 'the throwaway project folder' },
  archonHome: { as: '<archon-home>', stands: 'the throwaway Archon home' },
  recorderFolder: { as: '<recorder-folder>', stands: 'the folder that held both' },
  tempFolder: { as: '<temp>', stands: "the machine's temp folder" },
  homeFolder: { as: '<home>', stands: "the developer's home folder" },
  claudeConfig: { as: '<claude-config>', stands: "the developer's Claude config folder, which holds the Claude login" },
  binary: { as: '<binary>', stands: "the release binary's path" },
  user: { as: '<user>', stands: "the developer's account name" },
  host: { as: '<host>', stands: "the machine's name" },
  storeId: { as: '<store-id>', stands: "the install's store id" },
  token: { as: TOKEN, stands: 'a string shaped like a key or a token' }
} as const

export const STORE_ID = PLACEHOLDERS.storeId.as

/** The folders and names of the machine that records. Each is replaced by its placeholder. */
export interface Machine {
  projectFolder: string
  archonHome: string
  recorderFolder: string
  tempFolder: string
  homeFolder: string
  /** `CLAUDE_CONFIG_DIR`, or `.claude` in the home folder: the path only, never what it holds. */
  claudeConfig: string
  binary: string
  user: string
  host: string
}

/** The rules that take one machine's folders and names out of a recording. */
export function machineRules(machine: Machine): ScrubRules {
  const folders = ['projectFolder', 'archonHome', 'recorderFolder', 'tempFolder', 'homeFolder', 'claudeConfig', 'binary'] as const
  const names = ['user', 'host'] as const
  return {
    paths: folders.map((key) => ({ path: machine[key], as: PLACEHOLDERS[key].as })),
    names: names.map((key) => ({ name: machine[key], as: PLACEHOLDERS[key].as }))
  }
}

/** Keys whose value is the install's store id, however the release spells them. */
const STORE_ID_KEYS: readonly string[] = ['storeId', 'store_id']

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One separator as it can be written: `/`, `\`, `\\` inside JSON inside a string, or URL-encoded. */
const SEPARATOR = '(?:[\\\\/]|%5C|%2F)+'

/** One folder name as it can be written: as it is, or URL-encoded. */
const segmentPattern = (segment: string): string => escapeRegExp(encodeURIComponent(segment)).replace(/%20/g, '(?:%20| )')

/**
 * Matches a folder however it is written: either slash direction, backslashes doubled by JSON,
 * URL-encoded in a query, any letter case, and a drive as `C:`, `C%3A` or Git Bash's `/c`. A
 * path that starts at the root is matched with its leading slash, and a match ends where the
 * folder's name ends, so `/tmp` is not found inside `/tmpfile`.
 */
export function pathPattern(path: string): RegExp {
  const [first = '', ...rest] = path.split(/[\\/]+/).filter((segment) => segment !== '')
  const drive = /^([A-Za-z]):$/.exec(first)
  const head =
    drive?.[1] !== undefined
      ? `(?:${drive[1]}(?::|%3A)|/${drive[1]})`
      : `${/^[\\/]/.test(path) ? SEPARATOR : ''}${segmentPattern(first)}`
  return new RegExp(`${[head, ...rest.map(segmentPattern)].join(SEPARATOR)}(?![A-Za-z0-9_-])`, 'gi')
}

/** Matches a name that stands by itself, not as part of a longer word. */
export function namePattern(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, 'gi')
}

export interface Scrubber {
  /** Adds a store id seen in an answer, so that it is also removed where it is not under its key. */
  learnStoreId(storeId: string): void
  /** A copy of `value` with every path, name and store id replaced. */
  scrub<T>(value: T): T
  /** What `text` still holds that should have been removed: the placeholder of each rule that matches. */
  leftovers(text: string): string[]
}

export function createScrubber(rules: ScrubRules): Scrubber {
  // The longest folder first, so a project inside the temp folder is named as the project.
  const replacements: { pattern: RegExp; as: string }[] = [...rules.paths]
    .filter((rule) => rule.path !== '')
    .sort((a, b) => b.path.length - a.path.length)
    .map((rule) => ({ pattern: pathPattern(rule.path), as: rule.as }))
  // The longest name first too, so a machine named after its user is named as the machine.
  for (const rule of [...rules.names].sort((a, b) => b.name.length - a.name.length)) {
    if (rule.name !== '') replacements.push({ pattern: namePattern(rule.name), as: rule.as })
  }

  const scrubText = (text: string): string =>
    scrubTokens(replacements.reduce((scrubbed, { pattern, as }) => scrubbed.replace(pattern, () => as), text))

  const scrubValue = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      return key !== undefined && STORE_ID_KEYS.includes(key) ? STORE_ID : scrubText(value)
    }
    if (Array.isArray(value)) return value.map((item) => scrubValue(item))
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [scrubText(name), scrubValue(item, name)]))
    }
    return value
  }

  return {
    learnStoreId(storeId) {
      if (storeId !== '') replacements.push({ pattern: new RegExp(escapeRegExp(storeId), 'gi'), as: STORE_ID })
    },
    scrub: <T>(value: T): T => scrubValue(value) as T,
    leftovers(text) {
      const left = replacements.filter(({ pattern }) => new RegExp(pattern.source, pattern.flags).test(text)).map(({ as }) => as)
      return holdsToken(text) ? [...left, TOKEN] : left
    }
  }
}
