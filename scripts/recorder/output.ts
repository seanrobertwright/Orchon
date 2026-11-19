// Writes a release's fixtures and their log. A folder is replaced only when it is empty, absent
// or holds an earlier recording, so the recorder cannot wipe a folder that is something else.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const LOG_FILE = 'RECORDED.md'

/** The recorder was told to write into a folder that holds something other than a recording. */
export class NotARecordingFolder extends Error {
  override name = 'NotARecordingFolder'
}

/** Replaces `folder` with `files` and the log. Each path is relative, with forward slashes. */
export function writeFixtures(folder: string, files: readonly { path: string; text: string }[], log: string): void {
  if (existsSync(folder)) {
    const entries = readdirSync(folder)
    if (entries.length > 0 && !entries.includes(LOG_FILE)) {
      throw new NotARecordingFolder(`${folder} holds files and no ${LOG_FILE}. The recorder will not replace it.`)
    }
    rmSync(folder, { recursive: true, force: true })
  }
  mkdirSync(folder, { recursive: true })
  for (const file of files) {
    const target = join(folder, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.text)
  }
  writeFileSync(join(folder, LOG_FILE), log)
}
