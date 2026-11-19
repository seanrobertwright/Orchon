// Writes a release's fixtures and their log. A folder is replaced only when it is empty, absent
// or holds an earlier recording, so the recorder cannot wipe a folder that is something else,
// and only by a complete recording, so a failed or interrupted run leaves the earlier one alone.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const LOG_FILE = 'RECORDED.md'

/** The recorder was told to write into a folder that holds something other than a recording. */
export class NotARecordingFolder extends Error {
  override name = 'NotARecordingFolder'
}

type File = { path: string; text: string }

function refuseOtherFolder(folder: string): void {
  if (!existsSync(folder)) return
  const entries = readdirSync(folder)
  if (entries.length > 0 && !entries.includes(LOG_FILE)) {
    throw new NotARecordingFolder(`${folder} holds files and no ${LOG_FILE}. The recorder will not replace it.`)
  }
}

function writeInto(folder: string, files: readonly File[], log: string): void {
  mkdirSync(folder, { recursive: true })
  for (const file of files) {
    const target = join(folder, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.text)
  }
  writeFileSync(join(folder, LOG_FILE), log)
}

/**
 * Replaces `folder` with `files` and the log. Each path is relative, with forward slashes. The
 * new recording is written beside the folder first, and the earlier one is moved aside and
 * deleted only once the new one is in place, so a write that fails part way leaves it whole.
 */
export function writeFixtures(folder: string, files: readonly File[], log: string): void {
  refuseOtherFolder(folder)
  const parent = dirname(folder)
  mkdirSync(parent, { recursive: true })
  const staging = join(parent, `.${basename(folder)}.writing-${process.pid}`)
  const earlier = join(parent, `.${basename(folder)}.earlier-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  try {
    writeInto(staging, files, log)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  const hadEarlier = existsSync(folder)
  if (hadEarlier) renameSync(folder, earlier)
  try {
    renameSync(staging, folder)
  } catch (error) {
    if (hadEarlier) renameSync(earlier, folder)
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  if (hadEarlier) rmSync(earlier, { recursive: true, force: true })
}

/** What one run of the recorder produced, written or kept back by `writeRecording`. */
export interface RecordingOutcome {
  files: readonly File[]
  log: string
  /** False when the run failed, was interrupted or held back a fixture that was not clean. */
  complete: boolean
}

/**
 * Writes a complete recording into `folder`. An incomplete one writes nothing: an earlier
 * recording there stays as it was, and no folder is made. The caller prints its log instead.
 */
export function writeRecording(folder: string, recording: RecordingOutcome): 'written' | 'kept' {
  if (!recording.complete) return 'kept'
  writeFixtures(folder, recording.files, recording.log)
  return 'written'
}
