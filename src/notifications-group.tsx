// The Notifications group of the Settings section: read-only. It shows the setting's value with
// the label Orca's Settings shows, says where to change it, and has "Send test notification".
// The setting is the worker's to read; this group asks it when it is opened and hears every change.
import { atom, Button, Callout, Collapsible, plugin, read, set, Stack, Text, type OrcaNode, type PanelContext } from 'orca'
import { DEFAULT_LEVEL } from './notifications'
import { LEVEL_LABELS, type NotificationsTestAnswer, type NotificationsView } from './notifications-view'

/** The setting as the worker last answered it. Null until it answers. */
const notifications = atom<NotificationsView | null>(null)

/** The last test: on its way, or what became of it. Null before the first press. */
type TestState = NotificationsTestAnswer | { kind: 'sending' } | null

const tested = atom<TestState>(null)

/** Hears every change of the setting. It sends no request: the group asks when it is opened. */
export function startNotificationsGroup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('notifications.changed', (view) => set(notifications, view)))
}

/** Asks the worker for the setting. A refused request changes nothing. */
function readNotifications(open: boolean): void {
  if (!open) return
  plugin.request('notifications.read').then(
    (view) => set(notifications, view),
    () => {}
  )
}

/** One press sends one test; the button is off while it is on its way. */
function sendTest(): void {
  if (read(tested)?.kind === 'sending') return
  set(tested, { kind: 'sending' })
  plugin.request('notifications.test').then(
    (answer) => set(tested, answer),
    () => set(tested, { kind: 'failed' })
  )
}

function testOutcome(outcome: TestState): OrcaNode {
  if (outcome === null || outcome.kind === 'sending') return null
  if (outcome.kind === 'delivered') return <Text>Orca delivered the test notification.</Text>
  if (outcome.kind === 'failed') return <Text>Orchon could not send the test notification.</Text>
  return (
    <Callout tone="warning" title="Notifications are blocked">
      The system is blocking Orca's notifications. Allow notifications for Orca in the system's settings.
    </Callout>
  )
}

export function notificationsGroup(): OrcaNode {
  const view = read(notifications)
  const outcome = read(tested)
  const label = view === null ? undefined : LEVEL_LABELS[view.level]
  return (
    <Collapsible title="Notifications" description={label} onChange={readNotifications}>
      <Stack gap="sm">
        {view === null ? <Text muted>Orchon is reading this setting.</Text> : <Text>{`Sends: ${LEVEL_LABELS[view.level]}.`}</Text>}
        {view !== null && !view.recognised ? (
          <Text>{`The stored value is not one Orchon knows, so it uses "${LEVEL_LABELS[DEFAULT_LEVEL]}".`}</Text>
        ) : null}
        <Text>Change it under Orchon in Orca's Settings.</Text>
        <Button variant="outline" disabled={outcome?.kind === 'sending'} onPress={sendTest}>
          Send test notification
        </Button>
        {testOutcome(outcome)}
      </Stack>
    </Collapsible>
  )
}
