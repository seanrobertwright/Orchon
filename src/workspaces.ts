// Pure logic about Orca's workspaces and projects (#6, #25): the local-and-writable test, and
// the path and Git remote normalising the project matcher compares with. No host, no network.

/** The long-path prefix of a UNC path. Windows reads it only with backslashes. */
const LONG_UNC_PREFIX = '\\\\?\\UNC\\'

const WSL_SHARE = /^\/\/(wsl\.localhost|wsl\$)\//i

/**
 * The test of #25. A row is local and writable when its host id is exactly `local` and, for a
 * worker on Windows, its path is not a WSL share path: a leading `\\?\UNC\` stands for the `\\`
 * of the UNC path it prefixes, every `\` becomes `/`, and case is ignored.
 */
export function localAndWritable(row: { hostId: string | null; path: string }, platform: string): boolean {
  if (row.hostId !== 'local') return false
  if (platform !== 'win32') return true
  const path = row.path.startsWith(LONG_UNC_PREFIX) ? `\\\\${row.path.slice(LONG_UNC_PREFIX.length)}` : row.path
  return !WSL_SHARE.test(path.replaceAll('\\', '/'))
}

const isWindowsSpelling = (path: string): boolean => /^[A-Za-z]:(?:\/|$)/.test(path) || path.startsWith('//')

/**
 * A path as the matcher compares it (#6, part 2): every `\` becomes `/`, trailing separators go
 * except a root's own, and a Windows path (a drive letter or a UNC share) is folded to lower
 * case, drive letter included, because Windows compares paths without case. Null when empty.
 */
export function normalisePath(path: string): string | null {
  let forward = path.trim().replaceAll('\\', '/')
  if (forward === '') return null
  while (forward.length > 1 && forward.endsWith('/') && !/^[A-Za-z]:\/$/.test(forward)) forward = forward.slice(0, -1)
  return isWindowsSpelling(forward) ? forward.toLowerCase() : forward
}

/** Whether two paths name the same folder once normalised. */
export function samePath(first: string, second: string): boolean {
  const one = normalisePath(first)
  return one !== null && one === normalisePath(second)
}

/** Whether `child` is the folder `parent` or inside it, once both are normalised. */
export function isSameOrInside(child: string, parent: string): boolean {
  const inner = normalisePath(child)
  const outer = normalisePath(parent)
  if (inner === null || outer === null) return false
  if (inner === outer) return true
  return inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

/** A value of a Git config line: an optional quoted part, then a `;` or `#` comment. */
function configValue(raw: string): string {
  const text = raw.trim()
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text)
  if (quoted !== null) return (quoted[1] ?? '').replace(/\\(.)/g, '$1')
  return text.replace(/\s[;#].*$/, '').trim()
}

/**
 * The `url` of `[remote "origin"]` in a Git config file's text, parsed by hand: no process is
 * started (#32). Null when the file has no origin, or an origin with no url.
 */
export function originUrl(config: string): string | null {
  let inOrigin = false
  for (const line of config.split(/\r?\n/)) {
    const text = line.trim()
    if (text.startsWith('[')) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]/i.test(text)
      continue
    }
    if (!inOrigin) continue
    const entry = /^url\s*=(.*)$/i.exec(text)
    if (entry === null) continue
    const value = configValue(entry[1] ?? '')
    return value === '' ? null : value
  }
  return null
}

const URL_REMOTE_SCHEMES = ['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']
/** `user@host:owner/repo`, Git's short SSH form. */
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/

/**
 * A Git remote as the matcher compares it (#6, part 2): host and path only, in lower case, with
 * no user, port, trailing `/` or `.git`, so the SSH and HTTPS forms of one repository are equal.
 * Null for anything that is not a remote URL.
 */
export function normaliseRemote(remote: string): string | null {
  const text = remote.trim()
  if (text === '' || /\s/.test(text)) return null
  let host: string
  let path: string
  const scp = SCP_REMOTE.exec(text)
  if (scp !== null && !text.includes('://')) {
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  } else {
    if (!URL.canParse(text)) return null
    const url = new URL(text)
    if (!URL_REMOTE_SCHEMES.includes(url.protocol)) return null
    host = url.hostname
    path = url.pathname
  }
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  if (host === '' || trimmed === '') return null
  return `${host}/${trimmed}`.toLowerCase()
}
