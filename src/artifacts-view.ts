// A run's artifacts as a frame gets them: the requests a panel sends and the trimmed view models
// the worker answers. A folder or a filter answers at most `ARTIFACT_ROWS_CAP` rows; a file
// answers its facts and, when it is text within the cap, its contents cut into blocks. It is
// types and constants only.
import type { ConnectionAnswer } from './connection-view'

/** The most rows one folder or one filter answers, with a count of the rest. */
export const ARTIFACT_ROWS_CAP = 200

/** The largest file shown, in bytes: 256 KiB. A file listed as larger is never fetched. */
export const ARTIFACT_TEXT_CAP_BYTES = 256 * 1024

/** The most characters a path or a folder a frame sends may have. */
export const ARTIFACT_PATH_CAP = 4_096

/** The most characters of a name filter. */
export const ARTIFACT_FILTER_CAP = 200

/**
 * What a panel sends for the list: the run, and `open` when Artifacts has just been chosen, which
 * reads the run's list from Archon again. With `filter`, the matching paths; otherwise the
 * entries of `folder`, the top level when it is left out.
 */
export type ArtifactsRequest = { runId: string; open?: boolean; folder?: string; filter?: string }

/** What a panel sends for one file: the run and a path its list returned. */
export type ArtifactRequest = { runId: string; path: string }

/** One file of the run, as its list gives it. */
export type ArtifactFile = {
  /** The path inside the run's artifacts, with `/` between folders. */
  path: string
  /** The last part of the path. */
  name: string
  /** In bytes. */
  size: number
  /** Milliseconds since the epoch, or null when Archon's time does not parse. */
  modifiedAt: number | null
}

/** One folder of the run: its path, its last part and how many files it holds at any depth. */
export type ArtifactFolder = { path: string; name: string; files: number }

export type ArtifactEntry = ({ kind: 'folder' } & ArtifactFolder) | ({ kind: 'file' } & ArtifactFile)

/** The run's file count from its list, and how many of the list's entries could not be read. */
export type ArtifactCounts = { total: number; unreadable: number }

export type ArtifactsView =
  /** Orchon is not connected, so Archon was not asked. */
  | { kind: 'not-connected' }
  /**
   * One folder's entries, folders first and then files, each by name: at most
   * `ARTIFACT_ROWS_CAP`, and how many more it holds. `folder` is empty for the top level.
   */
  | ({ kind: 'folder'; folder: string; entries: ArtifactEntry[]; notShown: number } & ArtifactCounts)
  /** The files whose path holds the filter, by path: at most `ARTIFACT_ROWS_CAP`, and how many match. */
  | ({ kind: 'matches'; filter: string; files: ArtifactFile[]; matches: number; notShown: number } & ArtifactCounts)
  /** Archon has no run with this id. */
  | { kind: 'gone' }
  /** The read failed. The message is one sentence for the person. */
  | { kind: 'failed'; message: string }

export type ArtifactsAnswer = ConnectionAnswer & { artifacts: ArtifactsView }

/** What is shown of a file's contents. */
export type ArtifactContent =
  /** Text within the cap, in blocks Orca can draw: Markdown for `.md` and `.mdx`, plain text otherwise. */
  | { kind: 'markdown' | 'text'; blocks: string[] }
  /** Listed as larger than the cap, or grew past it while it was read. */
  | { kind: 'too-large' }
  /** Holds a NUL byte or is not valid UTF-8. */
  | { kind: 'not-text' }

export type ArtifactView =
  | { kind: 'not-connected' }
  | { kind: 'ready'; file: ArtifactFile; content: ArtifactContent }
  /** The run's list does not hold this path, so it was not fetched. */
  | { kind: 'not-listed' }
  /** The run, or the file, is no longer there. */
  | { kind: 'gone' }
  | { kind: 'failed'; message: string }

export type ArtifactAnswer = ConnectionAnswer & { artifact: ArtifactView }
