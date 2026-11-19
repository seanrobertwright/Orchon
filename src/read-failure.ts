// What a view says when one read from Archon fails while Orchon is connected. The texts are
// copied from the error table of the decision on what the plugin shows when Archon is missing
// (#22, part 8), apart from the one line marked below. The runs table says them all from here;
// the System group says them from here too, except for a call that never reached Archon.
import type { ClientFailure } from './client'
import { FLOOR_RELEASE, NEWEST_TESTED_RELEASE } from './connection-words'

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
    // Not in that table: a refused call moves the connection to Searching (#44), and this line
    // is what the view says until then.
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
