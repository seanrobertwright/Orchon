// The disk module: the only file Orca loads that imports `node:fs`. Everything it does starts
// by resolving the path, `..` and links included, and refusing one that lands outside the roots
// it was opened with. In this version it only reads.
import { open, realpath, stat } from 'node:fs/promises'
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

export type Disk = {
  /** Whether `path` is a folder. */
  folderState(path: string): Promise<FolderState>
  /** The file as UTF-8 text. A file longer than `maxBytes` is not read. */
  readText(path: string, maxBytes: number): Promise<TextFile>
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

  return {
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
