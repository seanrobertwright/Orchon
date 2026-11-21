// Reads a fact list (src/fact-list.tsx) back from a mounted panel, for the panel's tests. Each
// row comes back as a person reads it: the label, the value as text, its tone, and whether it
// is shown as code. It is development tooling: Orca never loads it.
import type { TestElement, TestPanel } from 'orca/testing'

export type ReadFact = { label: string; value: string; tone?: string; code?: true }

const within = (parent: TestElement, child: TestElement): boolean => child.path.startsWith(`${parent.path}/`)

/** The rows of the fact list named `label`, in order, or null when no such list is drawn. */
export function readFacts(view: TestPanel, label: string): ReadFact[] | null {
  const list = view.find({ type: 'List', label })
  if (list === null) return null
  const texts = [...view.findAll({ type: 'Text' }), ...view.findAll({ type: 'Code' })]
  return view
    .findAll({ type: 'ListItem' })
    .filter((item) => within(list, item))
    .map((item): ReadFact => {
      const inside = texts.filter((element) => within(item, element))
      const name = inside.find((element) => element.type === 'Text' && element.props.muted === true)
      const value = inside.find((element) => element !== name)
      if (name === undefined || value === undefined) throw new Error(`a row of the ${label} list has no label or no value`)
      const tone = value.props.tone
      return {
        label: name.text,
        value: value.text,
        ...(typeof tone === 'string' ? { tone } : {}),
        ...(value.type === 'Code' ? { code: true as const } : {})
      }
    })
}

/** The rows of the fact list named `label`, as "label: value"; it fails when the list is not drawn. */
export function factLines(view: TestPanel, label: string): string[] {
  const facts = readFacts(view, label)
  if (facts === null) throw new Error(`no ${label} list`)
  return facts.map((fact) => `${fact.label}: ${fact.value}`)
}
