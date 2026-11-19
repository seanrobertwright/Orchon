// The Access group of the Settings section: the plugin's own short account of what it does on
// this computer, as plain text. It has no control and no link. The statements are those of the
// decision on what the plugin asks the user to approve; the README's section "What Orchon does
// on your machine" is the long version.
import { Collapsible, Stack, Text, type OrcaNode } from 'orca'

/** The statements, in order, one sentence or two each. */
export const ACCESS_STATEMENTS: readonly string[] = [
  'Orchon talks only to the Archon server on this computer. It sends nothing anywhere else and collects no usage data.',
  'Its worker runs for as long as the plugin is enabled, to keep runs and the status bar current.',
  'It changes Archon only when you press a control, with one exception: it deletes a conversation it created itself when Archon refuses the launch.',
  'Each launch makes Archon write a conversation title with its small model. That is one small model call per launch, and Orchon cannot turn it off.',
  'On disk it writes only to a .orchon folder in the workspace you are in, which Git ignores.',
  "Notifications hold the workflow name, its state and the project name. Orca also sends them to paired phones. They are changed under Orchon in Orca's Settings.",
  'It never reads or stores provider keys, and never starts another program.'
]

export function accessGroup(): OrcaNode {
  return (
    <Collapsible title="Access" defaultOpen>
      <Stack gap="sm">
        {ACCESS_STATEMENTS.map((statement) => (
          <Text key={statement}>{statement}</Text>
        ))}
      </Stack>
    </Collapsible>
  )
}
