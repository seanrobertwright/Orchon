// The run graph tab (#11, #17, #24): a wide editor tab on a `.orchonrun` pointer file. It reads
// the run's id from the file, asks the worker for the run on its workflow as it is now, and draws
// a header, the banners and the graph in its own HTML. It is read-only: it never edits its file
// and holds no control that writes. Every piece of outside text is set through `textContent`.
import { createCanvas, type Canvas, type ObserveSize } from '../shared/canvas.ts'
import { elementMaker } from '../shared/dom.ts'
import { drawGraph, type DrawStep } from '../shared/graph-draw.ts'
import { layoutGraph, layoutInOrder, type Direction, type Layout } from '../shared/graph-layout.ts'
import { isRecord } from '../shared/records.ts'
import type { GraphAnswer, GraphEdge, GraphHeader, GraphStep, GraphView, TabConnection, TabScreen } from './graph-view.ts'
import { createRefetch, type TabTimers } from './refetch.ts'
import { createSummaryCard, parseSummary, type CardStep } from './summary-card.ts'

/** The least time between two reads nobody asked for, as run detail's. */
export const GAP_MS = 1_000
/** How often the tab reads again by itself, and how often while live updates are off. */
export const SAFETY_MS = 30_000
export const LIVE_OFF_MS = 5_000
/** The longest run id a pointer file may name, as the worker allows. */
const RUN_ID_CAP = 200

export const ARROWS_LINE = 'Arrows come from the workflow as it is now.'
export const UNREADABLE_FILE = 'Orchon could not read this file: it does not name a run.'
const WORKER_UNANSWERED = "Orchon's worker did not answer."
const MISMATCH: Record<'changed' | 'deleted', string> = {
  changed: 'The workflow has changed since this run.',
  deleted: 'The workflow has been deleted since this run.'
}
const IN_RUN_ORDER = "The run's own steps are drawn in run order, with no arrows."

export type TabPorts = {
  doc: Document
  /** The element the tab draws into. */
  app: HTMLElement
  /** The pointer file's text, or null when the tab has none. */
  readPointer(): Promise<string | null>
  /** A request to the plugin's worker. */
  request(name: string, input?: unknown): Promise<unknown>
  /** What the worker posts. */
  on(event: string, handler: (payload: unknown) => void): { dispose(): void }
  /** Orca's UI language. */
  locale: string
  timers: TabTimers
  /** Opens a link in the system browser, when the frame can. */
  openExternal?(url: string): Promise<unknown>
  /** Reports the graph area's size and its changes, so the graph is fitted to it. */
  observeSize?: ObserveSize
}

export type Tab = { stop(): void }

/** The pointer file's text from Orca's document API, or null when there is none. */
export async function readPointer(): Promise<string | null> {
  try {
    const api = typeof orca === 'undefined' ? undefined : orca.document
    if (api === undefined) return null
    const document = await api.get()
    return document.content.kind === 'text' ? document.content.text : null
  } catch {
    return null
  }
}

/** The run id a pointer file names, or null: `{ "orchon": "run-graph", "runId": ... }` and nothing else. */
export function parsePointer(text: string | null): string | null {
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || !Object.hasOwn(value, 'runId') || value.orchon !== 'run-graph') return null
  const runId = value.runId
  return typeof runId === 'string' && runId !== '' && runId.length <= RUN_ID_CAP ? runId : null
}

/** Whether an answer came back in the shape the tab draws. The worker is trusted, but a frame checks what it reads. */
function isAnswer(value: unknown): value is GraphAnswer {
  return isRecord(value) && isRecord(value.connection) && isRecord(value.graph) && typeof value.graph.kind === 'string' && typeof value.connection.kind === 'string'
}

type Ready = Extract<GraphView, { kind: 'ready' }>
/** The steps and edges drawn, and how many steps each collapsed loop group holds. */
type DrawnPart = { steps: GraphStep[]; edges: GraphEdge[]; holds: Map<string, number> }
type Area = { canvas: Canvas; loops: HTMLButtonElement; drawn: string; boxes: Map<string, Element> }

/** A graph view that carries something to show, which Searching and a failed read keep. */
type Shown = Extract<GraphView, { header: GraphHeader }> | Extract<GraphView, { kind: 'gone' }>

let drawings = 0

/** The drawn steps of a graph drawing, in the order drawn. */
function stepBoxes(root: Element): Element[] {
  const found: Element[] = []
  const visit = (element: Element): void => {
    if (element.getAttribute('data-step') !== null) found.push(element)
    for (const child of Array.from(element.children)) visit(child)
  }
  visit(root)
  return found
}

export function startTab(ports: TabPorts): Tab {
  const { doc } = ports
  const el = elementMaker(doc)
  /** A sentence in which each word between backticks is code. */
  const withCode = (sentence: string): HTMLParagraphElement => {
    const line = el('p')
    sentence.split('`').forEach((part, index) => {
      if (part === '') return
      line.appendChild(index % 2 === 1 ? el('code', part) : el('span', part))
    })
    return line
  }

  const top = el('header', undefined, 'tab-header')
  const banners = el('div', undefined, 'banners')
  banners.setAttribute('role', 'status')
  banners.setAttribute('aria-live', 'polite')
  const content = el('main', undefined, 'content')
  content.appendChild(el('p', 'Loading the run graph…', 'muted'))
  ports.app.replaceChildren(top, banners, content)

  let runId: string | null = null
  let shown: Shown | null = null
  let live = true
  /** Rises with each read; only the newest read's answer is drawn. */
  let counter = 0
  /** The layout of the graph last drawn, kept while the graph's shape does not change. */
  let laidOut: { key: string; layout: Layout } | undefined
  const prefix = `run-graph-${String((drawings += 1))}`
  /** The canvas, made with the first graph and kept while the tab is open, with what it shows. */
  let area: Area | undefined
  let direction: Direction = 'TB'
  /** Whether loop groups are drawn with their steps; they start collapsed. */
  let expanded = false
  const subscriptions: { dispose(): void }[] = []

  function drawHeader(header: GraphHeader | null): void {
    if (header === null) {
      top.replaceChildren()
      return
    }
    const meta = [`Run ${header.shortId}`, header.state, header.started === '' ? null : `Started ${header.started}`].filter((part) => part !== null).join(' · ')
    const refresh = button('Refresh', () => fetcher.restart())
    top.replaceChildren(el('h1', header.workflow), el('p', meta, 'meta'), ...(header.finished ? [el('p', ARROWS_LINE, 'muted')] : []), refresh)
  }

  function button(text: string, onClick: () => void): HTMLButtonElement {
    const made = el('button', text)
    made.setAttribute('type', 'button')
    made.addEventListener('click', onClick)
    return made
  }

  function drawScreen(screen: TabScreen): void {
    drawHeader(null)
    banners.replaceChildren()
    const parts: HTMLElement[] = [el('h2', screen.title), ...screen.lines.map(withCode)]
    if (screen.command !== null) {
      const command = el('pre', undefined, 'command')
      command.appendChild(el('code', screen.command))
      parts.push(command)
    }
    parts.push(...screen.after.map(withCode))
    const actions = el('p', undefined, 'actions')
    if (screen.tryAgain) {
      actions.appendChild(
        button('Try again', () => {
          void ports
            .request('connection.retry')
            .catch(() => null)
            .then(() => fetcher.restart())
        })
      )
    }
    if (screen.install !== null && /^https:\/\//.test(screen.install)) {
      const url = screen.install
      const link = el('a', 'Install Archon')
      link.setAttribute('href', url)
      link.addEventListener('click', (event) => {
        event.preventDefault()
        void ports.openExternal?.(url)
      })
      actions.appendChild(link)
    }
    if (actions.children.length > 0) parts.push(actions)
    const section = el('section', undefined, 'screen')
    for (const part of parts) section.appendChild(part)
    content.replaceChildren(section)
  }

  /** The steps and edges drawn: with loop groups collapsed, only the steps at the top, each group saying how many it holds. */
  function drawnPart(view: Ready): DrawnPart {
    const holds = new Map<string, number>()
    if (expanded) return { steps: view.steps, edges: view.edges, holds }
    const parent = new Map(view.steps.map((step) => [step.id, step.group]))
    for (const step of view.steps) {
      const seen = new Set<string>()
      for (let group = step.group; group !== null && !seen.has(group); group = parent.get(group) ?? null) {
        seen.add(group)
        holds.set(group, (holds.get(group) ?? 0) + 1)
      }
    }
    const steps = view.steps.filter((step) => step.group === null)
    const shown = new Set(steps.map((step) => step.id))
    return { steps, edges: view.edges.filter((edge) => shown.has(edge.from) && shown.has(edge.to)), holds }
  }

  /** The layout for a ready graph, made again only when its shape, the direction or the loop switch changed. */
  function layoutOf(view: Ready, part: DrawnPart): Layout {
    const key = JSON.stringify([view.mismatch, direction, part.steps.map((step) => [step.id, step.group, step.isGroup, step.conditional]), part.edges])
    if (laidOut?.key !== key) {
      const layout =
        view.mismatch === null
          ? layoutGraph(part.steps, part.edges, direction)
          : layoutInOrder(part.steps.map((step) => step.id), direction)
      laidOut = { key, layout }
    }
    return laidOut.layout
  }

  /** The canvas with the tab's own tools after its own: the direction and the loop switch. */
  function makeArea(label: string): Area {
    const canvas = createCanvas({
      doc,
      label,
      idPrefix: prefix,
      onStep: (id) => openCard(id),
      ...(ports.observeSize === undefined ? {} : { observeSize: ports.observeSize })
    })
    const set = el('fieldset', undefined, 'direction')
    set.appendChild(el('legend', 'Direction'))
    for (const [value, text] of [
      ['TB', 'Top to bottom'],
      ['LR', 'Left to right']
    ] as const) {
      const radio = el('input')
      radio.setAttribute('type', 'radio')
      radio.setAttribute('name', `${prefix}-direction`)
      radio.id = `${prefix}-direction-${value}`
      radio.value = value
      radio.checked = value === direction
      radio.addEventListener('change', () => {
        if (!radio.checked || direction === value) return
        direction = value
        redraw(true)
      })
      const label = el('label', text)
      label.setAttribute('for', radio.id)
      set.append(radio, label)
    }
    const loops = button('Show loop steps', () => {
      expanded = !expanded
      loops.setAttribute('aria-pressed', String(expanded))
      redraw(true)
    })
    loops.setAttribute('aria-pressed', 'false')
    loops.setAttribute('class', 'tool')
    canvas.tools.append(set, loops)
    return { canvas, loops, drawn: '', boxes: new Map() }
  }

  /** Each drawn step as the card shows it, by id, from the last graph drawn. */
  let cardSteps = new Map<string, CardStep>()
  /** The step whose card is open, or null. */
  let selected: string | null = null
  const card = createSummaryCard(doc, `${prefix}-card`, () => closeCard())

  /** Marks which step's card is open, on every drawn step. */
  function markSelected(): void {
    for (const [id, box] of area?.boxes ?? []) {
      box.setAttribute('aria-expanded', String(id === selected))
      box.setAttribute('aria-controls', card.root.id)
    }
  }

  /** Opens a step's card over the canvas, or shows another step on the open card. The focus stays where it is. */
  function openCard(id: string): void {
    const step = cardSteps.get(id)
    if (step === undefined || area === undefined) return
    selected = id
    card.show(step)
    if (card.root.parentElement !== area.canvas.root) area.canvas.root.appendChild(card.root)
    markSelected()
  }

  /** Closes the card. When the focus was in it, it goes back to the step the card was for, as it would otherwise be lost. */
  function closeCard(): void {
    if (selected === null) return
    const had = card.root.contains(doc.activeElement)
    const box = area?.boxes.get(selected)
    selected = null
    card.root.parentElement?.removeChild(card.root)
    markSelected()
    if (had && box !== undefined) (box as HTMLElement).focus()
  }

  ports.app.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || selected === null) return
    event.preventDefault()
    closeCard()
  })

  /** Draws the last ready graph again after a change of direction or of the loop switch, and fits it. */
  function redraw(fit: boolean): void {
    if (shown?.kind === 'ready') drawReady(shown, fit)
  }

  /** Draws a ready graph on the canvas. Nothing is laid out or drawn again while what it shows is unchanged. */
  function drawReady(view: Ready, fit = false): void {
    const label = `Steps of ${view.header.workflow}`
    area ??= makeArea(label)
    area.canvas.viewport.setAttribute('aria-label', label)
    area.loops.hidden = !view.steps.some((step) => step.isGroup && view.steps.some((inner) => inner.group === step.id))
    if (content.children[0] !== area.canvas.root) content.replaceChildren(area.canvas.root)
    const part = drawnPart(view)
    const steps = new Map<string, DrawStep>()
    cardSteps = new Map()
    for (const step of part.steps) {
      const holds = part.holds.get(step.id)
      const shared = { name: step.name, kind: step.kind, stateText: `${step.glyph} ${step.word}`, note: step.note, ...(holds === undefined ? {} : { holds }) }
      steps.set(step.id, { ...shared, state: step.state })
      cardSteps.set(step.id, { ...shared, summary: parseSummary(step.summary) })
    }
    const laid = layoutOf(view, part)
    const drawn = JSON.stringify([laidOut?.key, label, [...steps]])
    if (drawn !== area.drawn) {
      area.drawn = drawn
      // A step with the focus is drawn again with it, so a refetch does not take it away.
      const focused = [...area.boxes].find(([, box]) => box === doc.activeElement)?.[0]
      const svg = drawGraph(doc, laid, steps, { label, idPrefix: prefix })
      area.boxes = new Map(stepBoxes(svg).map((box) => [box.getAttribute('data-step') ?? '', box]))
      area.canvas.show(svg, laid, new Map(part.steps.map((step) => [step.id, step.state])), { fit })
      if (focused !== undefined) (area.boxes.get(focused) as HTMLElement | undefined)?.focus()
    }
    if (selected !== null) {
      if (cardSteps.has(selected)) openCard(selected)
      else closeCard()
    }
    markSelected()
  }

  /** Draws what the tab shows, with banners first: the Searching banner, a mismatch, a failed read. */
  function drawShown(view: Shown, lines: string[]): void {
    const banner = [...lines]
    if (view.kind === 'gone') {
      drawHeader(null)
      banners.replaceChildren(...banner.map((line) => el('p', line)))
      content.replaceChildren(el('p', 'This run no longer exists.'))
      return
    }
    drawHeader(view.header)
    if (view.kind === 'ready' && view.mismatch !== null) banner.push(`${MISMATCH[view.mismatch]} ${IN_RUN_ORDER}`)
    banners.replaceChildren(...banner.map((line) => el('p', line, 'banner')))
    if (view.kind === 'no-graph') {
      content.replaceChildren(el('p', view.message))
    } else if (view.kind === 'too-many') {
      content.replaceChildren(
        el(
          'p',
          `This run has ${String(view.count)} steps. One graph lays out at most ${String(view.cap)}, so this one is not drawn. Its steps are listed in run detail in the Orchon panel.`
        )
      )
    } else {
      drawReady(view)
    }
  }

  function apply(answer: GraphAnswer): void {
    const connection: TabConnection = answer.connection
    const { graph } = answer
    if (connection.kind === 'connected') live = connection.live
    if (connection.kind === 'screen') {
      shown = null
      drawScreen(connection.screen)
      return
    }
    if (connection.kind === 'searching') {
      if (shown !== null) drawShown(shown, [connection.banner])
      else {
        drawHeader(null)
        banners.replaceChildren()
        content.replaceChildren(el('p', connection.label, 'muted'))
      }
      return
    }
    // Archon was lost and found again while the worker read: what is shown stays until the next read.
    if (graph.kind === 'not-connected') return
    if (graph.kind === 'failed') {
      const { message } = graph
      // Over data the header's Refresh reads again; without data the message has its own button.
      if (shown !== null) {
        drawShown(shown, [message])
      } else {
        drawHeader(null)
        banners.replaceChildren()
        content.replaceChildren(el('p', message), button('Try again', () => fetcher.restart()))
      }
      return
    }
    shown = graph
    drawShown(graph, [])
  }

  const fetcher = createRefetch({
    gapMs: GAP_MS,
    safetyMs: () => (live ? SAFETY_MS : LIVE_OFF_MS),
    timers: ports.timers,
    async load() {
      if (runId === null) return
      counter += 1
      const mine = counter
      let answer: unknown
      try {
        answer = await ports.request('graph.read', { runId, locale: ports.locale })
      } catch {
        if (mine === counter) apply({ connection: { kind: 'connected', live }, graph: { kind: 'failed', message: WORKER_UNANSWERED } })
        return
      }
      if (mine === counter && isAnswer(answer)) apply(answer)
    }
  })

  subscriptions.push(
    ports.on('runs.changed', (payload) => {
      const runs = isRecord(payload) ? payload.runs : undefined
      if (runId !== null && (runs === 'many' || (Array.isArray(runs) && runs.includes(runId)))) fetcher.refresh()
    }),
    ports.on('connection.changed', () => fetcher.refresh())
  )

  let stopped = false
  void ports.readPointer().then((text) => {
    if (stopped) return
    runId = parsePointer(text)
    if (runId === null) content.replaceChildren(el('p', UNREADABLE_FILE))
    else fetcher.restart()
  })

  return {
    stop() {
      stopped = true
      fetcher.stop()
      area?.canvas.stop()
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
