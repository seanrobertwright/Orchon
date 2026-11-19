// The panel's sections, in the order of the section bar.
export const SECTIONS = [
  { id: 'runs', label: 'Runs' },
  { id: 'launch', label: 'Launch' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'chat', label: 'Chat' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'settings', label: 'Settings' }
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

export const DEFAULT_SECTION: SectionId = 'runs'

/** The section a stored or pressed value names, or the default when it names none. */
export function parseSection(value: unknown): SectionId {
  const found = SECTIONS.find((section) => section.id === value)
  return found === undefined ? DEFAULT_SECTION : found.id
}
