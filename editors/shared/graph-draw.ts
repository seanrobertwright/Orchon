// The graph drawn as the plugin's own SVG, shared by the run graph and the builder (#11): a frame
// per loop group, an edge per routed edge with an arrowhead, dashed into a conditional step, and
// a box per step with its name and its state as a glyph and a word. Outside text is set through
// `textContent` only. Colours are classes; editor.css maps them to the theme, and run-graph.css
// holds the plugin's own run-state colours.
import type { Layout } from './graph-layout.ts'

const SVG = 'http://www.w3.org/2000/svg'

/** The most characters of a name a box shows; the whole name is in its label and title. */
export const NAME_CAP = 24

/** What a box shows for one step. */
export type DrawStep = {
  name: string
  kind: string | null
  /** A word for the state's class, such as `completed`: the colour comes from it. */
  state: string
  /** The state as a glyph and a word, such as "✓ Completed". */
  stateText: string
  /** A line under the state, or null. */
  note: string | null
}

export type DrawOptions = {
  /** The drawing's accessible name. */
  label: string
  /** Makes the drawing's ids unique in its document. */
  idPrefix: string
}

const cut = (text: string): string => (text.length > NAME_CAP ? `${text.slice(0, NAME_CAP - 1)}…` : text)

/** Draws the laid-out graph. Steps the map does not describe are drawn by their id alone. */
export function drawGraph(doc: Document, laid: Layout, steps: ReadonlyMap<string, DrawStep>, options: DrawOptions): SVGSVGElement {
  const make = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
    const element = doc.createElementNS(SVG, tag)
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
    return element
  }
  const text = (content: string, attributes: Record<string, string | number>): SVGTextElement => {
    const element = make('text', attributes)
    element.textContent = content
    return element
  }

  const svg = make('svg', {
    viewBox: `0 0 ${String(laid.width)} ${String(laid.height)}`,
    width: laid.width,
    height: laid.height,
    role: 'group',
    'aria-label': options.label,
    class: 'graph'
  })
  const arrow = `${options.idPrefix}-arrow`
  const defs = svg.appendChild(make('defs'))
  const marker = defs.appendChild(make('marker', { id: arrow, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }))
  marker.appendChild(make('path', { d: 'M0 0 L10 5 L0 10 Z', class: 'arrowhead' }))

  for (const group of laid.groups) {
    const frame = svg.appendChild(make('g', { class: 'group' }))
    frame.appendChild(make('rect', { x: group.x, y: group.y, width: group.width, height: group.height, rx: 8 }))
    frame.appendChild(text(cut(steps.get(group.id)?.name ?? group.id), { x: group.x + 10, y: group.y + 15, class: 'group-name' }))
  }

  for (const edge of laid.edges) {
    const d = edge.points.map((point, at) => `${at === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`).join(' ')
    svg.appendChild(make('path', { d, class: edge.dashed ? 'edge dashed' : 'edge', 'marker-end': `url(#${arrow})` }))
  }

  for (const box of laid.steps) {
    const step = steps.get(box.id) ?? { name: box.id, kind: null, state: 'not-reached', stateText: '', note: null }
    const label = [step.name, step.kind, step.stateText].filter((part) => part !== null && part !== '').join(', ')
    const group = svg.appendChild(make('g', { class: `step state-${step.state}`, role: 'img', 'aria-label': label, transform: `translate(${String(box.x)} ${String(box.y)})` }))
    const title = group.appendChild(make('title'))
    title.textContent = step.name
    group.appendChild(make('rect', { width: box.width, height: box.height, rx: 6, class: 'box' }))
    group.appendChild(make('rect', { width: 4, height: box.height, rx: 2, class: 'bar' }))
    group.appendChild(text(cut(step.name), { x: 12, y: 19, class: 'name' }))
    group.appendChild(text(step.stateText, { x: 12, y: 37, class: 'state' }))
    if (step.note !== null) group.appendChild(text(step.note, { x: 12, y: box.height - 8, class: 'note' }))
  }
  return svg
}
