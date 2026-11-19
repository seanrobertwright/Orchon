// The line under the section bar while live updates are off: Archon answers, its dashboard
// stream does not, and the views refetch on the short timer. Nothing is disabled.
import { Text, type OrcaNode } from 'orca'
import type { Connected } from './connection-view'

export const LIVE_OFF_TEXT = 'Live updates are off. Refreshing every 5 seconds.'

/** The line while the stream is down, or null while it is live. */
export function liveOffLine(state: Connected): OrcaNode | null {
  return state.live ? null : (
    <Text muted size="sm">
      {LIVE_OFF_TEXT}
    </Text>
  )
}
