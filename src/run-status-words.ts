// How a run's status is shown: always a glyph beside a word, never by colour alone. The glyphs
// are the one set of the panel shell in #33; a badge draws its own dot, so it carries the word
// only. The panel loads this file, so it imports nothing but types.
import type { Tone } from 'orca'
import type { RunStatus, StatusFilter } from './runs-view'

export const STATUS_GLYPH: Record<RunStatus, string> = {
  running: '●',
  paused: '‖',
  pending: '○',
  completed: '✓',
  failed: '✕',
  cancelled: '⊘'
}

/** The word for each status. Archon's `pending` is Queued. */
export const STATUS_WORD: Record<RunStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  pending: 'Queued',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

/** The tone of a status badge. The word beside it says the same thing. */
export const STATUS_TONE: Record<RunStatus, Tone> = {
  running: 'accent',
  paused: 'warning',
  pending: 'neutral',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral'
}

/** The status select's options, in the order of the filter row. */
export const FILTER_ORDER: readonly StatusFilter[] = ['all', 'running', 'paused', 'pending', 'failed', 'completed', 'cancelled']

export const filterWord = (filter: StatusFilter): string => (filter === 'all' ? 'All' : STATUS_WORD[filter])

/** A status as a glyph and a word, such as "✓ Completed". */
export const statusText = (status: RunStatus): string => `${STATUS_GLYPH[status]} ${STATUS_WORD[status]}`
