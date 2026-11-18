// The one sidebar panel. Orca draws it with its own components: no DOM, and state lives in atoms.
import { atom, EmptyState, plugin, read, set, Tab, Tabs, type PanelContext } from 'orca'
import { DEFAULT_SECTION, parseSection, SECTIONS } from './sections'

/**
 * The section showing, kept per workspace because Orca unmounts a hidden panel. It is stored as
 * whatever was written, so it is parsed on every read.
 */
const section = atom<unknown>('section', DEFAULT_SECTION, { persist: 'workspace' })

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('show-runs', () => set(section, 'runs')))
}

export default function Panel() {
  return (
    <Tabs
      label="Orchon sections"
      value={parseSection(read(section))}
      onChange={(value) => set(section, parseSection(value))}
    >
      {SECTIONS.map(({ id, label }) => (
        <Tab key={id} value={id} label={label}>
          <EmptyState title={label} description="This section is not built yet." />
        </Tab>
      ))}
    </Tabs>
  )
}
