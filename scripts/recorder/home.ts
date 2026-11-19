// The throwaway Archon home. The recorder boots a release only against a home it made in this
// run: a new folder under the temp folder that holds a marker with a token only this process
// knows. The developer's own Archon home is compared by path and never opened.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { field } from '../shape.ts'

/** The marker's file name, at the root of a throwaway home. */
export const HOME_MARKER = 'orchon-recorder.json'

const ROOT_PREFIX = 'orchon-recorder-'

/** The recorder was pointed at a home it did not create. */
export class NotOwnHome extends Error {
  override name = 'NotOwnHome'
}

export interface ThrowawayHome {
  /** The folder this run made. Everything the recorder writes outside the fixtures is inside it. */
  root: string
  /** `ARCHON_HOME` for the release: `archon-home` inside the root. */
  archonHome: string
  /** The folder the throwaway project is made in: `project` inside the root. */
  projectFolder: string
  /** What the marker holds. A home whose marker holds another token belongs to another run. */
  token: string
  /** The developer's own Archon homes, which nothing here may equal, hold or lie inside. */
  developerHomes: readonly string[]
}

export interface HomeOptions {
  /** Where the home is made. The operating system's temp folder when left out. */
  tempFolder?: string
  /** The developer's own Archon homes. Read from the environment when left out. */
  developerHomes?: readonly string[]
}

/**
 * The developer's own Archon homes: the default `~/.archon` and whatever `ARCHON_HOME` names.
 * Only the paths are worked out. Nothing is read from them.
 */
export function developerArchonHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = [join(homedir(), '.archon')]
  const named = env.ARCHON_HOME
  if (named !== undefined && named !== '') {
    homes.push(named.startsWith('~') ? join(homedir(), named.slice(1)) : resolve(named))
  }
  return homes
}

/** Whether `inner` is `outer` or lies inside it. Windows paths compare without regard to case. */
export function isSameOrInside(inner: string, outer: string): boolean {
  const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
  const between = relative(fold(resolve(outer)), fold(resolve(inner)))
  return between === '' || (!between.startsWith('..') && !isAbsolute(between))
}

/** Fails when `path` is a developer home, holds one or lies inside one. Compares paths only. */
function refuseDeveloperHome(path: string, developerHomes: readonly string[]): void {
  for (const home of developerHomes) {
    if (isSameOrInside(path, home) || isSameOrInside(home, path)) {
      throw new NotOwnHome('That folder is, holds or lies inside your own Archon home. The recorder never touches it.')
    }
  }
}

/** Makes a new throwaway home. It is the only way to get one that `assertOwnHome` accepts. */
export function createThrowawayHome(options: HomeOptions = {}): ThrowawayHome {
  const developerHomes = options.developerHomes ?? developerArchonHomes()
  const tempFolder = resolve(options.tempFolder ?? tmpdir())
  // Checked before anything is made, so a temp folder inside the developer's home is left alone.
  if (developerHomes.some((home) => isSameOrInside(tempFolder, home))) {
    throw new NotOwnHome('The temp folder lies inside your own Archon home. The recorder never writes there.')
  }
  const root = mkdtempSync(join(realpathSync(tempFolder), ROOT_PREFIX))
  const home: ThrowawayHome = {
    root,
    archonHome: join(root, 'archon-home'),
    projectFolder: join(root, 'project'),
    token: randomUUID(),
    developerHomes
  }
  mkdirSync(home.archonHome)
  writeFileSync(join(root, HOME_MARKER), `${JSON.stringify({ madeBy: 'orchon record-fixtures', token: home.token })}\n`)
  return home
}

function markerToken(root: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(root, HOME_MARKER), 'utf8'))
  } catch {
    return null
  }
  const token = field(parsed, 'token')
  return typeof token === 'string' ? token : null
}

/**
 * Fails unless `home` is a throwaway home this run made: its Archon home is the one inside its
 * own root, neither is the developer's, and the marker on disk holds this run's token.
 */
export function assertOwnHome(home: ThrowawayHome): void {
  // Paths first: a developer home is refused before any file in it could be opened.
  refuseDeveloperHome(home.archonHome, home.developerHomes)
  refuseDeveloperHome(home.root, home.developerHomes)
  if (resolve(home.archonHome) !== join(resolve(home.root), 'archon-home')) {
    throw new NotOwnHome('The Archon home is not the one inside the throwaway folder.')
  }
  if (!existsSync(home.archonHome)) throw new NotOwnHome('The throwaway Archon home does not exist.')
  if (home.token === '' || markerToken(home.root) !== home.token) {
    throw new NotOwnHome('The folder has no marker from this run. The recorder did not create it.')
  }
}

/** Deletes a throwaway home and everything in it. A folder that is not one is left alone. */
export function removeThrowawayHome(home: ThrowawayHome): void {
  assertOwnHome(home)
  // Windows frees a stopped server's files a moment after its process ends.
  rmSync(home.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
