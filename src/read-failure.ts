// What a view says when one read from Archon fails while Orchon is connected. The texts are
// copied from the error table of the decision on what the plugin shows when Archon is missing
// (#22, part 8), and every view that reads from Archon says them from here.
import type { ClientFailure } from './client'
import { FLOOR_RELEASE } from './connection-words'

/** The newest Archon release with recorded fixtures. It is said to the person, never compared. */
export const NEWEST_TESTED_RELEASE = '0.14.0'

/** One sentence for a read that gave no answer. */
export function readFailureText(failure: ClientFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return `Archon did not answer within ${String(failure.timeoutMs / 1000)} seconds.`
    case 'too-large':
      return "Archon's answer was too large to read."
    case 'status':
      return `Archon answered with an error (${String(failure.status)}).`
    case 'not-json':
      return 'This Archon does not have this feature.'
    case 'refused':
    case 'not-loopback':
    case 'cancelled':
      return 'Orchon could not reach Archon.'
  }
}

/** One sentence for an answer that does not validate, naming the server's version and the tested range. */
export function unreadableAnswerText(version: string | null): string {
  const reports = version === null ? 'This server does not report its version' : `This server reports Archon ${version}`
  return `Orchon could not read Archon's answer. ${reports}; Orchon is tested with ${FLOOR_RELEASE} to ${NEWEST_TESTED_RELEASE}.`
}
