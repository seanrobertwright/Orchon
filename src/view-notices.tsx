// What every view of the panel draws while Archon or the plugin's own worker is away: the
// Searching banner over data, and the Worker unreachable line. The rules behind them are in
// `view-fetch.ts`; the words are copied from the decision on what the plugin shows when Archon
// is missing (#22, parts 9 and 10).
import { Button, Callout, env, Row, Stack, Text, type OrcaNode } from 'orca'
import type { Timers } from './client'
import { formatClock } from './dates'
import { offersTryAgain, troubleText, type WorkerTrouble } from './view-fetch'

/** The frame's own timers, for the fetch rules. Every one is cleared when its view stops. */
export const frameTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * The Searching banner over data, with the wall-clock time Archon stopped answering. A time that
 * does not format drops out and the sentence stays.
 */
export function searchingBanner(since: number): OrcaNode {
  const at = formatClock(since, env.locale)
  const stopped = at === '' ? 'Archon stopped answering.' : `Archon stopped answering at ${at}.`
  return (
    <Callout tone="warning">
      <Text>{`${stopped} Reconnecting… Changes are turned off until it answers.`}</Text>
    </Callout>
  )
}

/** One warning line: its sentences, and "Try again" when it offers one. */
export function warningLine(sentences: string, tryAgain: (() => void) | null): OrcaNode {
  return (
    <Callout tone="warning">
      <Stack gap="xs">
        <Text>{sentences}</Text>
        {tryAgain === null ? null : (
          <Row>
            <Button size="sm" variant="outline" onPress={tryAgain}>
              Try again
            </Button>
          </Row>
        )}
      </Stack>
    </Callout>
  )
}

/** The Worker unreachable line. Under consent there is nothing to try again. */
export function troubleLine(trouble: WorkerTrouble, tryAgain: () => void): OrcaNode {
  return warningLine(troubleText(trouble), offersTryAgain(trouble) ? tryAgain : null)
}
