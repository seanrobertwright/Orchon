// A read-only list of facts, label and value. It stands in for Orca's KeyValue, whose two fixed
// columns leave a value one or two characters a line in a narrow panel. Here each row is a
// wrapping row: in a wide panel the value sits beside its label, and when the two do not fit
// side by side the value moves under its label, as the Settings forms stack theirs. The panel
// cannot read its own width, so the wrap is what decides.
import { Box, Code, List, ListItem, Text, type KeyValueItem, type OrcaNode } from 'orca'

/** One fact. The same shape as Orca's KeyValue items, so a caller changes only the component. */
export type FactItem = KeyValueItem

/** The label column's width in pixels, and the least room a value takes beside it. */
const LABEL_WIDTH = 136
const VALUE_MIN_WIDTH = 140

function valueText(value: FactItem['value']): string {
  return value === null ? '' : String(value)
}

function factValue(item: FactItem): OrcaNode {
  const text = valueText(item.value)
  if (item.code === true) return <Code>{text}</Code>
  return item.tone === undefined ? <Text>{text}</Text> : <Text tone={item.tone}>{text}</Text>
}

/** The facts as one labelled list, a row per fact, in the order given. */
export function factList(label: string, items: readonly FactItem[]): OrcaNode {
  return (
    <List label={label}>
      {items.map((item) => (
        <ListItem key={item.label}>
          <Box direction="row" wrap gap="xs" align="start">
            <Box width={LABEL_WIDTH} shrink={false}>
              <Text muted>{item.label}</Text>
            </Box>
            {/* A fixed starting width, not the text's own, so a long value wraps beside its label
                rather than dropping under it while the two still fit side by side. */}
            <Box grow width={VALUE_MIN_WIDTH} minWidth={VALUE_MIN_WIDTH}>
              {factValue(item)}
            </Box>
          </Box>
        </ListItem>
      ))}
    </List>
  )
}
