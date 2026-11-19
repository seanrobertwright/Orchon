// The Connection group of the Settings section. It is read-only and shows in every connection
// state: the state, the connected address, both connection settings as typed, the reason a
// value was refused, and where to change them. The settings are changed in Orca's Settings.
import { Collapsible, KeyValue, Stack, Text, type KeyValueItem, type OrcaNode } from 'orca'
import type { Connected, ConnectionView, SettingKey } from './connection-view'
import { SEARCHING_LABEL, SETTING_LABELS, stateTitle } from './connection-words'
import { withCode } from './state-screen'

/** What an unset setting reads: automatic discovery, and Archon's default home folder. */
const UNSET: Record<SettingKey, string> = { baseUrl: 'Automatic', archonHome: '~/.archon' }
const SETTING_KEYS: readonly SettingKey[] = ['baseUrl', 'archonHome']

/** The connected address followed by where it came from. */
function connectedAddress(view: Connected): string {
  switch (view.source) {
    case 'setting':
      return `${view.baseUrl} (from the Base URL setting)`
    case 'server-json':
      return view.settings.homeFolder === null
        ? `${view.baseUrl} (from server.json)`
        : `${view.baseUrl} (from server.json in ${view.settings.homeFolder})`
    case 'default':
      return `${view.baseUrl} (the default address)`
  }
}

function rows(view: ConnectionView | null): KeyValueItem[] {
  if (view === null) return [{ label: 'State', value: SEARCHING_LABEL }]
  const refused = view.kind === 'bad-setting' ? view.refused.map((setting) => setting.key) : []
  return [
    { label: 'State', value: stateTitle(view) },
    { label: 'Connected address', value: view.kind === 'connected' ? connectedAddress(view) : 'Not connected' },
    ...SETTING_KEYS.map((key): KeyValueItem => {
      const typed = view.settings[key]
      const item: KeyValueItem = { label: SETTING_LABELS[key], value: typed === '' ? UNSET[key] : typed }
      // The colour is never the only sign: the reason is written out under the list.
      return refused.includes(key) ? { ...item, tone: 'danger' } : item
    })
  ]
}

export function connectionGroup(view: ConnectionView | null): OrcaNode {
  const refused = view?.kind === 'bad-setting' ? view.refused : []
  return (
    <Collapsible title="Connection" defaultOpen>
      <Stack gap="sm">
        <KeyValue label="Connection" items={rows(view)} />
        {refused.map((setting) => (
          <Text key={setting.key} tone="danger">
            {`${SETTING_LABELS[setting.key]}: `}
            {withCode(setting.reason)}
          </Text>
        ))}
        <Text muted>Change these in Orca's Settings, under Plugins, Orchon.</Text>
      </Stack>
    </Collapsible>
  )
}
