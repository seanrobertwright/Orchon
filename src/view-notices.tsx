// What every view of the panel draws while Archon or the plugin's own worker is away: the
// Searching banner over data, the Worker unreachable line, and, in `dataViewBody`, which of them
// a view of Archon's data shows in each state. The rules behind them are in `view-fetch.ts`; the
// words are copied from the decision on what the plugin shows when Archon is missing (#22, parts
// 9 and 10).
import { Button, Callout, env, Row, Stack, Text, type OrcaNode } from 'orca'
import type { Connected, ConnectionView } from './connection-view'
import { formatClock } from './dates'
import { canWrite, type WorkerTrouble } from './view-fetch'
import { offersTryAgain, troubleText } from './worker-words'

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

/** A line over a body. With no line the body is drawn as it is. */
export function underLine(line: OrcaNode, body: OrcaNode): OrcaNode {
  if (line === null) return body
  return (
    <Stack gap="sm">
      {line}
      {body}
    </Stack>
  )
}

/** A view of Archon's data, as every such view of the panel is drawn through an outage. */
export type DataView = {
  /** Whether it holds an answer to show, which Searching keeps under its banner. */
  hasData(): boolean
  /** The view for a Connected state. `writable` is false when its controls that write are off. */
  draw(state: Connected, writable: boolean): OrcaNode
}

/** What `dataViewBody` is given about the panel besides the view. */
export type DataViewContext = {
  state: ConnectionView | null
  /** The last Connected state, whatever the state is now. */
  kept: Connected | null
  /** The state screen for `state`, or null while Connected. */
  screen: OrcaNode
  /** Worker unreachable for the connection reads, or null while the worker answers them. */
  trouble: WorkerTrouble | null
  tryAgain(): void
}

/**
 * A data view's body in every state. While Connected the view draws itself and says any trouble
 * with its own reads, so the connection reads' line is not said twice. Searching with data keeps
 * what it loaded under the banner, read-only. With no state known the Worker unreachable line
 * takes the place of the body, and otherwise it sits over the state screen.
 */
export function dataViewBody(view: DataView, context: DataViewContext): OrcaNode {
  const { state, kept, screen, trouble } = context
  if (state?.kind === 'connected') return view.draw(state, canWrite(state.kind, trouble))
  const line = trouble === null ? null : troubleLine(trouble, context.tryAgain)
  if (state === null && line !== null) return line
  if (state?.kind === 'searching' && kept !== null && view.hasData()) {
    return underLine(
      line,
      <Stack gap="sm">
        {searchingBanner(state.since)}
        {view.draw(kept, canWrite(state.kind, trouble))}
      </Stack>
    )
  }
  return underLine(line, screen)
}
