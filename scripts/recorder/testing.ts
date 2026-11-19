// Helpers the recorder's tests share.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'orca/testing'

/** A check for `assert.throws`: the error is of this kind. */
export const isA =
  (kind: abstract new (...args: never[]) => Error) =>
  (error: unknown): boolean =>
    error instanceof kind

/**
 * Temp folders for the tests of one file. Call it once at the top of the file; each call of the
 * function it answers makes a new folder, and every folder is removed when its test ends.
 */
export function scratchFolders(): () => string {
  const made: string[] = []
  afterEach(() => {
    for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  return () => {
    const folder = mkdtempSync(join(realpathSync(tmpdir()), 'orchon-recorder-test-'))
    made.push(folder)
    return folder
  }
}
