// The words a view says when its requests to the plugin's own worker fail (Worker unreachable
// and consent), and when Orchon is not connected to Archon. They are copied from the decision on what the plugin shows when Archon is missing
// (#22, part 9), so they are kept in one file. The panel loads this file, so it imports nothing
// but types.
import type { WorkerTrouble } from './view-fetch'

/** After this many failed tries in a row the view says how to turn the plugin off and on. */
export const TRIES_BEFORE_TURN_OFF_AND_ON = 3

export const UNREACHABLE_TEXT = "Orchon's background process is not answering."
export const TURN_OFF_AND_ON_TEXT = "Turn the Orchon plugin off and on again in Orca's Settings."
export const CONSENT_TEXT = "Orchon is turned off or needs approval in Orca's Settings."
export const NOT_CONNECTED_TEXT = 'Orchon is not connected to Archon.'

/** What the view says about its worker, in sentences. */
export function troubleText(trouble: WorkerTrouble): string {
  if (trouble.kind === 'consent') return CONSENT_TEXT
  return trouble.inARow >= TRIES_BEFORE_TURN_OFF_AND_ON ? `${UNREACHABLE_TEXT} ${TURN_OFF_AND_ON_TEXT}` : UNREACHABLE_TEXT
}

/** Whether the view offers "Try again": never when Orca asks for consent. */
export const offersTryAgain = (trouble: WorkerTrouble): boolean => trouble.kind !== 'consent'
