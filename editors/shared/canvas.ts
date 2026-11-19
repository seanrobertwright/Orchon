// The canvas tools, shared by the run graph and the builder (#11): a viewport that shows part of
// a drawn graph, with pan by drag or the arrow keys, zoom by the wheel, the on-canvas buttons or
// the plus and minus keys, fit by a button or the zero key, and a minimap whose frame can be
// dragged to move the view. Until the person moves the view, the graph is fitted again each time
// the canvas changes size. Panning and zooming change the drawing's viewBox only: nothing is laid
// out or drawn again. The caller lays out and draws, and hands both over with `show`.
import { elementMaker } from './dom.ts'
import type { Layout } from './graph-layout.ts'

const SVG = 'http://www.w3.org/2000/svg'

/** How far one arrow key moves the view, in screen pixels. */
export const PAN_STEP = 48
/** How much one press of plus or minus, or one notch of the wheel, zooms. */
export const ZOOM_STEP = 1.25
export const MIN_SCALE = 0.1
export const MAX_SCALE = 3
/** The minimap's largest size, in screen pixels. */
const MINIMAP_WIDTH = 160
const MINIMAP_HEIGHT = 120
/** How far a pointer moves before a press becomes a drag, in screen pixels. */
const DRAG_START = 4
/** The canvas size assumed until the frame reports one. */
const FIRST_SIZE = { width: 800, height: 500 }

export const KEYS_HELP = 'Arrow keys pan, plus and minus zoom, and zero fits the graph.'

/** Reports an element's size now and on every change, until disposed. */
export type ObserveSize = (element: HTMLElement, told: (width: number, height: number) => void) => { dispose(): void }

/** What is shown: `x` and `y` are the graph point at the canvas's top-left corner. */
export type View = { x: number; y: number; scale: number }
type Size = { width: number; height: number }

const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

/** The view that shows the whole graph centred, never larger than its own size. */
export function fitView(graph: Size, canvas: Size): View {
  const scale = clampScale(Math.min(1, canvas.width / Math.max(1, graph.width), canvas.height / Math.max(1, graph.height)))
  return { x: (graph.width - canvas.width / scale) / 2, y: (graph.height - canvas.height / scale) / 2, scale }
}

/** The view zoomed by `factor` with the canvas point `about` held still. */
export function zoomView(view: View, factor: number, about: { x: number; y: number }): View {
  const scale = clampScale(view.scale * factor)
  return { x: view.x + about.x / view.scale - about.x / scale, y: view.y + about.y / view.scale - about.y / scale, scale }
}

/** A number for an attribute, without the noise of floating point. */
const num = (value: number): string => String(Math.round(value * 1000) / 1000)

export type CanvasOptions = {
  doc: Document
  /** The canvas's accessible name, such as "Steps of archon-deliver-block". */
  label: string
  /** Makes the canvas's ids unique in its document. */
  idPrefix: string
  observeSize?: ObserveSize
  /** A step was pressed, by a click or by Enter or Space while it has focus. */
  onStep?(id: string): void
  /** An edge was clicked: the ids of the steps at its two ends. */
  onEdge?(from: string, to: string): void
}

export type Canvas = {
  /** The canvas: its tools, the viewport and the minimap. A caller may put an overlay inside it. */
  root: HTMLElement
  /** The row of tools; a caller may add its own controls after the canvas's own. */
  tools: HTMLElement
  /** The viewport, which holds the drawing and takes the keys. */
  viewport: HTMLElement
  /**
   * Shows a drawing of a layout, with each step's state for the minimap. The view is kept unless
   * `fit` is set or the person has not moved it, when the graph is fitted.
   */
  show(drawing: SVGSVGElement, laid: Layout, states: ReadonlyMap<string, string>, options: { fit: boolean }): void
  stop(): void
}

export function createCanvas(options: CanvasOptions): Canvas {
  const { doc } = options
  const el = elementMaker(doc)
  const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] => {
    const element = doc.createElementNS(SVG, tag)
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
    return element
  }
  const button = (text: string, name: string | null, run: () => void): HTMLButtonElement => {
    const made = el('button', text, 'tool')
    made.setAttribute('type', 'button')
    if (name !== null) {
      made.setAttribute('aria-label', name)
      made.setAttribute('title', name)
    }
    made.addEventListener('click', run)
    return made
  }

  const root = el('div', undefined, 'canvas-frame')
  const tools = el('div', undefined, 'canvas-tools')
  const viewport = el('div', undefined, 'viewport')
  const helpId = `${options.idPrefix}-keys`
  const help = el('p', KEYS_HELP, 'keys-help muted')
  help.id = helpId
  viewport.setAttribute('tabindex', '0')
  viewport.setAttribute('role', 'group')
  viewport.setAttribute('aria-label', options.label)
  viewport.setAttribute('aria-describedby', helpId)
  const minimap = svgEl('svg', { class: 'minimap', 'aria-hidden': 'true' })
  const frame = svgEl('rect', { class: 'minimap-frame' })
  root.append(tools, viewport, minimap, help)

  let size: Size = FIRST_SIZE
  let graph: Size = { width: 1, height: 1 }
  let view: View = fitView(graph, size)
  /** Whether the person has moved the view since it was last fitted. */
  let moved = false
  let drawing: SVGSVGElement | null = null
  let miniScale = 1

  function place(): void {
    const width = size.width / view.scale
    const height = size.height / view.scale
    if (drawing !== null) {
      drawing.setAttribute('viewBox', `${num(view.x)} ${num(view.y)} ${num(width)} ${num(height)}`)
      drawing.setAttribute('width', num(size.width))
      drawing.setAttribute('height', num(size.height))
    }
    frame.setAttribute('x', num(view.x))
    frame.setAttribute('y', num(view.y))
    frame.setAttribute('width', num(width))
    frame.setAttribute('height', num(height))
  }
  function fit(): void {
    view = fitView(graph, size)
    moved = false
    place()
  }
  function move(next: View): void {
    view = next
    moved = true
    place()
  }
  const centre = (): { x: number; y: number } => ({ x: size.width / 2, y: size.height / 2 })
  const zoom = (factor: number, about = centre()): void => move(zoomView(view, factor, about))
  const pan = (dx: number, dy: number): void => move({ ...view, x: view.x + dx / view.scale, y: view.y + dy / view.scale })

  tools.append(button('+', 'Zoom in', () => zoom(ZOOM_STEP)), button('−', 'Zoom out', () => zoom(1 / ZOOM_STEP)), button('Fit', null, fit))

  viewport.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'Enter' || event.key === ' ') {
      const id = stepOf(event.target)
      if (id === null) return
      event.preventDefault()
      options.onStep?.(id)
      return
    }
    const keys: Record<string, () => void> = {
      ArrowLeft: () => pan(-PAN_STEP, 0),
      ArrowRight: () => pan(PAN_STEP, 0),
      ArrowUp: () => pan(0, -PAN_STEP),
      ArrowDown: () => pan(0, PAN_STEP),
      '+': () => zoom(ZOOM_STEP),
      '=': () => zoom(ZOOM_STEP),
      '-': () => zoom(1 / ZOOM_STEP),
      '0': fit
    }
    if (!Object.hasOwn(keys, event.key)) return
    event.preventDefault()
    keys[event.key]?.()
  })

  const local = (element: Element, event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = element.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  viewport.addEventListener(
    'wheel',
    (event) => {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
      event.preventDefault()
      const factor = Math.min(2, Math.max(0.5, ZOOM_STEP ** (-event.deltaY / 100)))
      zoom(factor, local(viewport, event))
    },
    { passive: false }
  )

  /** The press that may become a drag of the canvas. */
  let press: { pointer: number; x: number; y: number; from: View; dragging: boolean } | null = null
  /** Set after a drag, so the click that ends it opens nothing. */
  let dragged = false
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    press = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: view, dragging: false }
    dragged = false
  })
  viewport.addEventListener('pointermove', (event) => {
    if (press?.pointer !== event.pointerId) return
    const dx = event.clientX - press.x
    const dy = event.clientY - press.y
    if (!press.dragging && Math.hypot(dx, dy) < DRAG_START) return
    if (!press.dragging) {
      press.dragging = true
      if (typeof viewport.setPointerCapture === 'function') viewport.setPointerCapture(event.pointerId)
    }
    move({ ...press.from, x: press.from.x - dx / view.scale, y: press.from.y - dy / view.scale })
  })
  const release = (event: PointerEvent): void => {
    if (press?.pointer !== event.pointerId) return
    dragged = press.dragging
    press = null
  }
  viewport.addEventListener('pointerup', release)
  viewport.addEventListener('pointercancel', release)
  /** The step id of the drawn step that holds an event's target, or null. */
  const stepOf = (target: EventTarget | null): string | null => {
    for (let at = target as Element | null; at !== null && at !== viewport; at = at.parentElement) {
      const id = at.getAttribute('data-step')
      if (id !== null) return id
    }
    return null
  }
  viewport.addEventListener('click', (event) => {
    // A click that ends a drag is the drag's, not a press of the step under it.
    if (dragged) {
      dragged = false
      return
    }
    const id = stepOf(event.target)
    if (id !== null) {
      options.onStep?.(id)
      return
    }
    const edge = event.target as Element | null
    if (edge === null) return
    const from = edge.getAttribute('data-from')
    const to = edge.getAttribute('data-to')
    if (from !== null && to !== null) options.onEdge?.(from, to)
  })

  /** The pointer on the minimap moves the view's centre to the graph point under it. */
  let miniPointer: number | null = null
  const centreAt = (event: PointerEvent): void => {
    const point = local(minimap, event)
    move({ ...view, x: point.x / miniScale - size.width / view.scale / 2, y: point.y / miniScale - size.height / view.scale / 2 })
  }
  minimap.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    miniPointer = event.pointerId
    if (typeof minimap.setPointerCapture === 'function') minimap.setPointerCapture(event.pointerId)
    centreAt(event)
  })
  minimap.addEventListener('pointermove', (event) => {
    if (miniPointer === event.pointerId) centreAt(event)
  })
  const miniRelease = (event: PointerEvent): void => {
    if (miniPointer === event.pointerId) miniPointer = null
  }
  minimap.addEventListener('pointerup', miniRelease)
  minimap.addEventListener('pointercancel', miniRelease)

  const observed = options.observeSize?.(viewport, (width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    size = { width, height }
    if (moved) place()
    else fit()
  })

  return {
    root,
    tools,
    viewport,
    show(next, laid, states, { fit: refit }) {
      graph = { width: Math.max(1, laid.width), height: Math.max(1, laid.height) }
      drawing = next
      viewport.replaceChildren(next)
      miniScale = Math.min(MINIMAP_WIDTH / graph.width, MINIMAP_HEIGHT / graph.height)
      minimap.setAttribute('viewBox', `0 0 ${num(graph.width)} ${num(graph.height)}`)
      minimap.setAttribute('width', num(graph.width * miniScale))
      minimap.setAttribute('height', num(graph.height * miniScale))
      const boxes = laid.steps.map((box) =>
        svgEl('rect', { class: `mini-step state-${states.get(box.id) ?? 'not-reached'}`, x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 })
      )
      const groups = laid.groups.map((box) => svgEl('rect', { class: 'mini-group', x: box.x, y: box.y, width: box.width, height: box.height, rx: 8 }))
      minimap.replaceChildren(...groups, ...boxes, frame)
      if (refit || !moved) fit()
      else place()
    },
    stop() {
      observed?.dispose()
    }
  }
}
