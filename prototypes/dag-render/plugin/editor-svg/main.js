// PROTOTYPE - throwaway. Variant A: dagre layout drawn as hand-written SVG. No build step:
// Orca loads this file and its relative imports as they are.
import {
  NODE_H,
  NODE_W,
  STATUS_GLYPH,
  clipLabel,
  edgePath,
  kindLine,
  layoutGraph,
  visibleGraph
} from '../shared/layout.js'
import { afterPaint, fillSelect, loadContext, loadGraph, showDetail } from '../shared/chrome.js'

const SVG = 'http://www.w3.org/2000/svg'
const $ = (id) => document.getElementById(id)
const svg = $('canvas')
const viewport = $('viewport')
const aside = $('detail')
const stats = $('stats')
const minimap = $('minimap')

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text != null) e.textContent = text
  return e
}

let view = { x: 0, y: 0, k: 1 }
let current = null // { graph, layout }
let selected = null
let autoFit = true // refit when the tab is resized, until the user pans or zooms

function applyView() {
  viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`)
  // The minimap's frame is the part of the graph the canvas is showing.
  const box = svg.getBoundingClientRect()
  const frame = $('mm-view')
  frame.setAttribute('x', -view.x / view.k)
  frame.setAttribute('y', -view.y / view.k)
  frame.setAttribute('width', box.width / view.k)
  frame.setAttribute('height', box.height / view.k)
}

function drawMinimap(layout) {
  minimap.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`)
  $('mm-nodes').replaceChildren(
    ...layout.nodes.map((n) =>
      el('rect', {
        class: n.group ? 'mm-group' : `mm-node st-${n.data.status}`,
        x: n.x,
        y: n.y,
        width: n.w,
        height: n.h
      })
    )
  )
}

/** Centres the canvas on the graph point under a minimap pointer event. */
function panFromMinimap(e) {
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(minimap.getScreenCTM().inverse())
  const box = svg.getBoundingClientRect()
  autoFit = false
  view.x = box.width / 2 - p.x * view.k
  view.y = box.height / 2 - p.y * view.k
  applyView()
}

function fit() {
  if (!current) return
  const box = svg.getBoundingClientRect()
  const { width, height } = current.layout
  const k = Math.min(1.25, box.width / width, box.height / height)
  view = { k, x: (box.width - width * k) / 2, y: Math.max(0, (box.height - height * k) / 2) }
  applyView()
}

function zoomAt(factor, cx, cy) {
  autoFit = false
  const k = Math.min(3, Math.max(0.03, view.k * factor))
  view.x = cx - ((cx - view.x) * k) / view.k
  view.y = cy - ((cy - view.y) * k) / view.k
  view.k = k
  applyView()
}

function select(id) {
  selected = id
  for (const g of viewport.querySelectorAll('.node')) {
    const on = g.dataset.id === id
    g.classList.toggle('selected', on)
    g.setAttribute('aria-pressed', String(on))
  }
  showDetail(aside, current.graph, current.graph.nodes.find((n) => n.id === id) ?? null)
}

function draw(layout) {
  const frag = document.createDocumentFragment()
  for (const n of layout.nodes.filter((n) => n.group)) {
    const g = el('g', { class: 'group' })
    g.append(
      el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 8 }),
      el('text', { x: n.x + 8, y: n.y + 14 }, `${n.data.label} · ${n.data.kind}`)
    )
    frag.append(g)
  }
  for (const e of layout.edges) {
    frag.append(
      el('path', {
        class: e.conditional ? 'edge conditional' : 'edge',
        d: edgePath(e.points),
        'marker-end': 'url(#arrow)'
      })
    )
  }
  for (const n of layout.nodes.filter((n) => !n.group)) {
    const d = n.data
    const g = el('g', {
      class: `node st-${d.status}`,
      transform: `translate(${n.x},${n.y})`,
      tabindex: 0,
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `${d.label}, ${d.kind}, ${d.status}`,
      'data-id': d.id
    })
    g.append(
      el('rect', { class: 'box', width: NODE_W, height: NODE_H, rx: 6 }),
      el('rect', { class: 'bar', width: 4, height: NODE_H - 8, x: 4, y: 4, rx: 2 }),
      el('text', { class: 'label', x: 16, y: 19 }, clipLabel(d.label)),
      el('text', { class: 'kind', x: 16, y: 35 }, kindLine(d)),
      el('text', { class: 'glyph', x: NODE_W - 16, y: 28 }, STATUS_GLYPH[d.status])
    )
    frag.append(g)
  }
  viewport.replaceChildren(frag)
  drawMinimap(layout)
}

async function show(name) {
  stats.textContent = 'loading…'
  const { graph: full, fetchMs } = await loadGraph(name)
  const graph = visibleGraph(full, $('expand').checked)
  const t0 = performance.now()
  const layout = layoutGraph(graph, $('direction').value)
  const t1 = performance.now()
  draw(layout)
  const t2 = performance.now()
  current = { graph, layout }
  autoFit = true
  fit()
  select(null)
  const t3 = await afterPaint()
  const text =
    `${graph.nodes.length} nodes · ${layout.edges.length} edges · ` +
    `${svg.querySelectorAll('*').length} elements\n` +
    `worker ${fetchMs.toFixed(0)} ms · layout ${(t1 - t0).toFixed(0)} ms · ` +
    `draw ${(t2 - t1).toFixed(0)} ms · paint ${(t3 - t2).toFixed(0)} ms`
  stats.textContent = text
  const mode = $('expand').checked ? ' expanded' : ''
  void orca.plugin.request('stats.report', {
    line: `svg  ${name}${mode}: ${text.replace('\n', ' | ')}`
  })
}

// Pan with a drag on the background, zoom with the wheel, select with a click or Enter.
let drag = null
svg.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node')) return
  autoFit = false
  drag = { x: e.clientX - view.x, y: e.clientY - view.y }
  svg.setPointerCapture(e.pointerId)
  svg.classList.add('panning')
})
svg.addEventListener('pointermove', (e) => {
  if (!drag) return
  view.x = e.clientX - drag.x
  view.y = e.clientY - drag.y
  applyView()
})
svg.addEventListener('pointerup', () => {
  drag = null
  svg.classList.remove('panning')
})
svg.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const box = svg.getBoundingClientRect()
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - box.left, e.clientY - box.top)
  },
  { passive: false }
)
svg.addEventListener('click', (e) => {
  const node = e.target.closest('.node')
  select(node ? node.dataset.id : null)
})
const PAN = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }
svg.addEventListener('keydown', (e) => {
  const node = e.target.closest('.node')
  if (node && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    select(node.dataset.id)
  } else if (PAN[e.key]) {
    e.preventDefault()
    autoFit = false
    view.x += PAN[e.key][0]
    view.y += PAN[e.key][1]
    applyView()
  } else if (e.key === '+' || e.key === '=') {
    zoomAt(1.25, ...centre())
  } else if (e.key === '-') {
    zoomAt(0.8, ...centre())
  } else if (e.key === '0') {
    autoFit = true
    fit()
  }
})
let mapDrag = false
minimap.addEventListener('pointerdown', (e) => {
  mapDrag = true
  minimap.setPointerCapture(e.pointerId)
  panFromMinimap(e)
})
minimap.addEventListener('pointermove', (e) => mapDrag && panFromMinimap(e))
minimap.addEventListener('pointerup', () => {
  mapDrag = false
})
function centre() {
  const box = svg.getBoundingClientRect()
  return [box.width / 2, box.height / 2]
}
$('fit').addEventListener('click', () => {
  autoFit = true
  fit()
})
$('expand').addEventListener('change', () => show($('workflow').value))
new ResizeObserver(() => autoFit && fit()).observe(svg)
$('zoom-in').addEventListener('click', () => zoomAt(1.25, ...centre()))
$('zoom-out').addEventListener('click', () => zoomAt(0.8, ...centre()))
$('workflow').addEventListener('change', (e) => show(e.target.value))
$('direction').addEventListener('change', () => show($('workflow').value))
orca.on('theme', (theme) => console.log(`[proto svg] theme event: ${JSON.stringify(theme)}`))

const { pointer, list } = await loadContext()
const first = list.some((g) => g.name === pointer.workflow) ? pointer.workflow : list[0].name
fillSelect($('workflow'), list, first)
$('expand').checked = pointer.expand === true
if (pointer.direction === 'LR') $('direction').value = 'LR'
await show(first)
