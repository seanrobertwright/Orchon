// PROTOTYPE - throwaway. Data loading and the detail pane, shared by both variants.
import { STATUS_GLYPH } from './layout.js'

/** Reads the pointer file this tab is open on, then asks the worker for the graph list. */
export async function loadContext() {
  const doc = await orca.document.get()
  let pointer = {}
  try {
    pointer = JSON.parse(doc.content.kind === 'text' ? doc.content.text : '{}')
  } catch {
    pointer = {}
  }
  const list = await orca.plugin.request('graph.list', {})
  return { pointer, list }
}

export async function loadGraph(name) {
  const t0 = performance.now()
  const graph = await orca.plugin.request('graph.get', { name })
  return { graph, fetchMs: performance.now() - t0 }
}

export function fillSelect(select, list, current) {
  select.replaceChildren(
    ...list.map((g) => {
      const o = document.createElement('option')
      o.value = g.name
      o.textContent = `${g.name} (${g.nodes})`
      o.selected = g.name === current
      return o
    })
  )
}

const row = (dl, term, value) => {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  if (term === 'When' || term === 'Id') {
    const code = document.createElement('code')
    code.textContent = value
    dd.append(code)
  } else {
    dd.textContent = Array.isArray(value) ? value.join(', ') : String(value)
  }
  dl.append(dt, dd)
}

export function showDetail(aside, graph, node) {
  const h = document.createElement('h2')
  const dl = document.createElement('dl')
  if (!node) {
    h.textContent = graph.name
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = graph.description || 'No description.'
    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = 'Click a step, or Tab to one and press Enter, to see its detail.'
    aside.replaceChildren(h, p, hint, legend())
    return
  }
  h.textContent = node.label
  row(dl, 'State', `${STATUS_GLYPH[node.status]} ${node.status} (made up)`)
  row(dl, 'Kind', node.kind)
  row(dl, 'Id', node.id)
  row(dl, 'Inside', node.parent)
  row(dl, 'After', node.dependsOn)
  row(dl, 'When', node.when)
  row(dl, 'Trigger', node.triggerRule)
  row(dl, 'Model', node.model)
  row(dl, 'Max loops', node.maxIterations)
  row(dl, 'Holds', node.childCount ? `${node.childCount} nested steps` : null)
  aside.replaceChildren(h, dl, legend())
}

function legend() {
  const div = document.createElement('div')
  div.className = 'legend'
  for (const [status, glyph] of Object.entries(STATUS_GLYPH)) {
    const s = document.createElement('span')
    s.className = `st-${status}`
    s.dataset.glyph = glyph
    s.textContent = status
    div.append(s)
  }
  return div
}

/** Time until the browser has painted what was just put in the DOM. */
export function afterPaint() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))
  )
}
