// The disk module: the only file Orca loads that imports `node:fs`. Everything it does starts
// by resolving the path, `..` and links included, and refusing one that lands outside the roots
// it was opened with. It reads, and it writes only through the calls below that say so: those
// also refuse a root that is itself a link, so a write cannot be led out of the folder it names.
import { lstat, mkdir, open, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** `missing` covers a path that is not there and one that is a file. */
export type FolderState = 'exists' | 'missing' | 'refused'

export type TextFile =
  | { kind: 'text'; text: string }
  /** Not there, not a file, or not readable. */
  | { kind: 'missing' }
  | { kind: 'too-large' }
  /** The path resolves outside the allowed roots. Nothing was read. */
  | { kind: 'refused' }

/** What a write did. `refused`: the path resolves outside the allowed roots, and nothing was done. */
export type WriteOutcome = 'ok' | 'refused' | 'failed'

/** One entry of a folder. A link is not a file, whatever it leads to. */
export type DiskEntry = { name: string; modifiedMs: number; file: boolean }

export type Disk = {
  /** Whether `path` is a folder. */
  folderState(path: string): Promise<FolderState>
  /** The file as UTF-8 text. A file longer than `maxBytes` is not read. */
  readText(path: string, maxBytes: number): Promise<TextFile>
  /** Writes: makes the folder unless it is there. A link, or a file, in its place fails. */
  makeFolder(path: string): Promise<WriteOutcome>
  /** Writes: the file's whole content, as UTF-8. Its folder must exist. */
  writeText(path: string, text: string): Promise<WriteOutcome>
  /** The entries of a folder, or null when it is not one or cannot be read. */
  listFolder(path: string): Promise<DiskEntry[] | null>
  /** Writes: deletes one file. A folder is never deleted. */
  remove(path: string): Promise<WriteOutcome>
}

/** Whether a failed file call means the path is not there. */
function isMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

/**
 * Where a full path really leads, with every link followed. The part that does not exist yet
 * has no links to follow, so it is kept as written under its deepest existing folder.
 */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!isMissing(error)) throw error
    const parent = dirname(path)
    return parent === path ? path : join(await realPathOf(parent), basename(path))
  }
}

function isInside(root: string, target: string): boolean {
  const steps = relative(root, target)
  return steps === '' || (steps !== '..' && !steps.startsWith(`..${sep}`) && !isAbsolute(steps))
}

/**
 * Opens the disk for the given roots, each a full path. Every later call resolves its path and
 * the roots afresh, so a root may be created, or become a link, after the disk was opened.
 */
export function openDisk(roots: readonly string[]): Disk {
  /** The real path when it is inside a root, or null when it is refused. */
  async function allowed(path: string): Promise<string | null> {
    if (!isAbsolute(path)) return null
    try {
      const target = await realPathOf(resolve(path))
      for (const root of roots) {
        if (isAbsolute(root) && isInside(await realPathOf(resolve(root)), target)) return target
      }
      return null
    } catch {
      // A path that cannot be resolved cannot be shown to be inside a root.
      return null
    }
  }

  /** Whether a root is a link, which no write goes through. A root that is not there is not one. */
  async function anyRootIsLink(): Promise<boolean> {
    for (const root of roots) {
      try {
        if ((await lstat(root)).isSymbolicLink()) return true
      } catch (error) {
        if (!isMissing(error)) return true
      }
    }
    return false
  }

  /** The real path to write to, or null when it is refused. */
  async function writable(path: string): Promise<string | null> {
    if (await anyRootIsLink()) return null
    return allowed(path)
  }

  return {
    async makeFolder(path) {
      const target = await writable(path)
      if (target === null) return (await allowed(path)) === null ? 'refused' : 'failed'
      try {
        const facts = await lstat(target)
        return facts.isDirectory() ? 'ok' : 'failed'
      } catch (error) {
        if (!isMissing(error)) return 'failed'
      }
      try {
        await mkdir(target)
        return 'ok'
      } catch {
        return 'failed'
      }
    },

    async writeText(path, text) {
      const target = await writable(path)
      if (target === null) return 'refused'
      try {
        await writeFile(target, text, 'utf8')
        return 'ok'
      } catch {
        return 'failed'
      }
    },

    async listFolder(path) {
      const target = await allowed(path)
      if (target === null) return null
      try {
        const names = await readdir(target)
        const entries: DiskEntry[] = []
        for (const name of names) {
          try {
            const facts = await lstat(join(target, name))
            entries.push({ name, modifiedMs: facts.mtimeMs, file: facts.isFile() })
          } catch {
            // An entry that went away while it was listed is not listed.
          }
        }
        return entries
      } catch {
        return null
      }
    },

    async remove(path) {
      const target = await writable(path)
      if (target === null) return 'refused'
      try {
        if (!(await lstat(target)).isFile()) return 'failed'
        await unlink(target)
        return 'ok'
      } catch {
        return 'failed'
      }
    },

    async folderState(path) {
      const target = await allowed(path)
      if (target === null) return 'refused'
      try {
        return (await stat(target)).isDirectory() ? 'exists' : 'missing'
      } catch {
        return 'missing'
      }
    },

    async readText(path, maxBytes) {
      const target = await allowed(path)
      if (target === null) return { kind: 'refused' }
      let file
      try {
        file = await open(target, 'r')
      } catch {
        return { kind: 'missing' }
      }
      try {
        const facts = await file.stat()
        if (!facts.isFile()) return { kind: 'missing' }
        if (facts.size > maxBytes) return { kind: 'too-large' }
        // One byte past the cap shows a file that grew after it was measured.
        const { bytesRead, buffer } = await file.read(Buffer.alloc(maxBytes + 1), 0, maxBytes + 1, 0)
        if (bytesRead > maxBytes) return { kind: 'too-large' }
        return { kind: 'text', text: buffer.toString('utf8', 0, bytesRead) }
      } catch {
        return { kind: 'missing' }
      } finally {
        await file.close()
      }
    }
  }
}
