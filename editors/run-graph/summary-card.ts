// The run graph's summary card (#17): a selected step's facts and the first 4 KiB of its output,
// over the edge of the canvas. It holds one control, Close, and nothing that writes. Every piece
// of outside text is set through `textContent`. The worker's summary is parsed here, at the
// frame's boundary: a field of the wrong type is dropped and read as not reported.
import { elementMaker } from '../shared/dom.ts'
import { holdsPhrase } from '../shared/graph-draw.ts'
import { isRecord, own } from '../shared/records.ts'
import type { GraphOutputShown, GraphStepSummary } from './graph-view.ts'

export const PANEL_LINE = 'Tool calls and agent text are in the Orchon panel.'
const OUTPUT_LINES: Record<GraphOutputShown, string | null> = {
  whole: null,
  cut: 'Only the first 4 KiB of the output is shown here.',
  withheld: "This graph's output was too large to send in full, so this step's is not shown here."
}
const NO_OUTPUT = 'This step has no output.'
const NOT_REPORTED = 'Not reported'
const NO_COST = 'No cost reported'

/** What the card shows for one step. */
export type CardStep = {
  name: string
  kind: string | null
  /** The state as a glyph and a word, such as "✓ Completed". */
  stateText: string
  /** A line such as where a paused step is answered, or null. */
  note: string | null
  /** For a loop group drawn collapsed: how many steps it holds. */
  holds?: number
  summary: GraphStepSummary | null
}

const SHOWN: readonly GraphOutputShown[] = ['whole', 'cut', 'withheld']

/** The worker's summary of a step, or null when it sent none or it is not a summary. */
export function parseSummary(value: unknown): GraphStepSummary | null {
  if (!isRecord(value)) return null
  const text = (key: string): string | null => {
    const field = own(value, key)
    return typeof field === 'string' && field !== '' ? field : null
  }
  const output = own(value, 'output')
  const shown = own(value, 'outputShown')
  return {
    duration: text('duration'),
    cost: text('cost'),
    model: text('model'),
    skipReason: text('skipReason'),
    output: typeof output === 'string' ? output : '',
    outputShown: SHOWN.find((one) => one === shown) ?? 'whole'
  }
}

export type SummaryCard = {
  /** The card; the caller places it over the canvas and takes it away. */
  root: HTMLElement
  show(step: CardStep): void
}

export function createSummaryCard(doc: Document, id: string, onClose: () => void): SummaryCard {
  const el = elementMaker(doc)
  const root = el('aside', undefined, 'summary-card')
  root.id = id
  const title = el('h2')
  const close = el('button', 'Close', 'tool')
  close.setAttribute('type', 'button')
  close.addEventListener('click', onClose)
  const head = el('div', undefined, 'card-head')
  head.append(title, close)
  const body = el('div', undefined, 'card-body')
  root.append(head, body)

  return {
    root,
    show(step) {
      root.setAttribute('aria-label', `Summary of ${step.name}`)
      title.textContent = step.name
      const summary = step.summary
      const facts = el('dl')
      const fact = (term: string, value: string): void => {
        facts.append(el('dt', term), el('dd', value))
      }
      fact('Kind', step.kind ?? NOT_REPORTED)
      fact('State', step.stateText)
      fact('Duration', summary?.duration ?? NOT_REPORTED)
      fact('Cost', summary?.cost ?? NO_COST)
      fact('Model', summary?.model ?? NOT_REPORTED)
      if (summary?.skipReason != null) fact('Skipped because', summary.skipReason)
      const parts: HTMLElement[] = []
      if (step.note !== null) parts.push(el('p', step.note, 'card-note'))
      if (step.holds !== undefined) {
        parts.push(el('p', `${holdsPhrase(step.holds, 'upper')}. Show loop steps to draw ${step.holds === 1 ? 'it' : 'them'}.`))
      }
      parts.push(facts)
      // A worker older than the card sends no summary, and so no word on the output either way.
      if (summary !== null) {
        parts.push(el('h3', 'Output'))
        if (summary.output !== '') parts.push(el('pre', summary.output, 'card-output'))
        const outputLine = OUTPUT_LINES[summary.outputShown]
        if (outputLine !== null) parts.push(el('p', outputLine, 'muted'))
        else if (summary.output === '') parts.push(el('p', NO_OUTPUT, 'muted'))
      }
      parts.push(el('p', PANEL_LINE, 'muted'))
      body.replaceChildren(...parts)
    }
  }
}
