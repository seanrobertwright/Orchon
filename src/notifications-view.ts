// The Notifications group as a frame gets it: the setting's value, whether the stored value was
// one Orchon knows, and the answer to "Send test notification". The words of each value are the
// manifest's labels.
import type { NotificationLevel } from './notifications'

/** The setting as the worker last read it. An unknown stored value reads as the default. */
export type NotificationsView = { level: NotificationLevel; recognised: boolean }

/**
 * What became of a test notification: Orca delivered it, Orca answered that it was not
 * delivered (the system is blocking Orca's notifications), or the call failed.
 */
export type NotificationsTestAnswer = { kind: 'delivered' } | { kind: 'blocked' } | { kind: 'failed' }

/** Each value's label, as the manifest's `enumLabels` gives them in Orca's Settings. */
export const LEVEL_LABELS: Record<NotificationLevel, string> = {
  off: 'Off',
  'needs-you': 'Runs that need you',
  'needs-you-and-ended': 'Runs that need you and runs that end'
}
