// PROTOTYPE - throwaway. Builder editing screen with 3 layout variants, connect mode,
// inspector forms, read-only nodes, >300 node cap, Ctrl/Cmd+S check, and draft restore timing.
import {
  MAX_CANVAS_NODES,
  NODE_H,
  NODE_W,
  clipLabel,
  edgePath,
  isReadOnlyNode,
  layoutGraph,
  toYaml,
  validateLocal
} from './layout.js'

const SVG = 'http://www.w3.org/2000/svg'
const $ = (id) => document.getElementById(id)

const VARIANTS = [
  { id: 'A', name: 'A — Split-rail IDE' },
  { id: 'B', name: 'B — Canvas + Tabbed Sidecar' },
  { id: 'C', name: 'C — Outline Workbench' }
]

const state = {
  variant: new URLSearchParams(location.search).get('variant') || 'A',
  workflows: [],
  workflow: null, // current editable copy
  savedJson: '',
  dirty: false,
  selectedNodeId: null,
  selectedEdge: null, // { from, to }
  connectSourceId: null,
  centerTab: 'canvas', // 'canvas' | 'yaml' | 'issues'
  sidecarTab: 'inspector', // 'inspector' | 'outline' | 'yaml' (for Variant B)
  direction: 'TB',
  serverErrors: [],
  layout: null,
  view: { x: 0, y: 0, k: 1 },
  autoFit: true
}

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text != null) e.textContent = text
  return e
}

function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k === 'hidden') e.hidden = Boolean(v)
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, String(v))
  }
  for (const c of children) {
    if (c == null || c === false) continue
    e.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return e
}

function setStatus(text) {
  $('status-line').textContent = text
}

function logProto(line) {
  void orca.plugin.request('proto.log', { line })
}

async function persistDraft() {
  if (!state.workflow) return
  state.dirty = JSON.stringify(state.workflow) !== state.savedJson
  $('dirty-badge').hidden = !state.dirty
  $('discard-btn').hidden = !state.dirty
  if (state.dirty) {
    await orca.plugin.request('builder.saveDraft', {
      key: state.workflow.key,
      draft: state.workflow
    })
  } else {
    await orca.plugin.request('builder.discardDraft', { key: state.workflow.key })
  }
}

function markEdited() {
  void persistDraft()
  renderAll()
}

function setVariant(id) {
  state.variant = VARIANTS.some((v) => v.id === id) ? id : 'A'
  document.body.dataset.variant = state.variant
  const info = VARIANTS.find((v) => v.id === state.variant)
  $('var-label').textContent = info.name
  const url = new URL(location.href)
  url.searchParams.set('variant', state.variant)
  history.replaceState(null, '', url)
  renderInspectorOrSidecar()
  renderIssues()
  if (state.autoFit) fit()
}

function cycleVariant(delta) {
  const idx = VARIANTS.findIndex((v) => v.id === state.variant)
  const next = VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length]
  setVariant(next.id)
}

function selectNode(id) {
  if (state.connectSourceId) {
    if (id && id !== state.connectSourceId) {
      completeConnect(id)
      return
    }
  }
  state.selectedNodeId = id
  state.selectedEdge = null
  renderAll({ skipLayout: true })
}

function selectEdge(edge) {
  state.selectedEdge = edge
  state.selectedNodeId = null
  renderAll({ skipLayout: true })
}

function startConnect(sourceId) {
  if (!sourceId) return
  state.connectSourceId = sourceId
  $('connect-banner').hidden = false
  $('connect-text').textContent =
    `Connect mode: click target node (or press Enter in outline) to depend on "${sourceId}".`
  renderAll({ skipLayout: true })
}

function cancelConnect() {
  state.connectSourceId = null
  $('connect-banner').hidden = true
  renderAll({ skipLayout: true })
}

function completeConnect(targetId) {
  const sourceId = state.connectSourceId
  state.connectSourceId = null
  $('connect-banner').hidden = true
  const target = state.workflow.nodes.find((n) => n.id === targetId)
  if (target && sourceId && target.id !== sourceId) {
    target.dependsOn = target.dependsOn || []
    if (!target.dependsOn.includes(sourceId)) {
      target.dependsOn.push(sourceId)
      setStatus(`Connected ${sourceId} → ${targetId}`)
      markEdited()
      return
    }
  }
  renderAll({ skipLayout: true })
}

function removeEdge(from, to) {
  const target = state.workflow.nodes.find((n) => n.id === to)
  if (!target) return
  target.dependsOn = (target.dependsOn || []).filter((d) => d !== from)
  if (state.selectedEdge?.from === from && state.selectedEdge?.to === to) {
    state.selectedEdge = null
  }
  setStatus(`Removed edge ${from} → ${to}`)
  markEdited()
}

function addNode(kind) {
  const base = kind === 'approval' ? 'gate' : kind
  let idx = state.workflow.nodes.length + 1
  let id = `${base}-${idx}`
  const existing = new Set(state.workflow.nodes.map((n) => n.id))
  while (existing.has(id)) {
    idx++
    id = `${base}-${idx}`
  }
  const node = {
    id,
    label: `New ${kind}`,
    kind,
    dependsOn: state.selectedNodeId ? [state.selectedNodeId] : [],
    ...(kind === 'prompt' ? { prompt: 'Describe the task…', model: 'claude-sonnet-4-5', triggerRule: 'all_success' } : {}),
    ...(kind === 'bash' ? { command: 'echo "hello"', runtime: 'bun' } : {}),
    ...(kind === 'loop' ? { prompt: 'Iterate until done…', maxIterations: 3, until: 'DONE', interactive: false, freshContext: true } : {}),
    ...(kind === 'approval' ? { message: 'Approve to continue?', options: ['Approve', 'Reject'] } : {})
  }
  state.workflow.nodes.push(node)
  state.selectedNodeId = node.id
  state.selectedEdge = null
  setStatus(`Added ${kind} node "${node.id}"`)
  markEdited()
}

function deleteNode(id) {
  state.workflow.nodes = state.workflow.nodes.filter((n) => n.id !== id)
  for (const n of state.workflow.nodes) {
    if (n.dependsOn) n.dependsOn = n.dependsOn.filter((d) => d !== id)
  }
  if (state.selectedNodeId === id) state.selectedNodeId = null
  setStatus(`Removed node "${id}"`)
  markEdited()
}

function renderOutline(container) {
  const { byNode } = validateLocal(state.workflow)
  const items = state.workflow.nodes.map((n) => {
    const ro = isReadOnlyNode(n)
    const errs = byNode.get(n.id) || []
    const isSel = n.id === state.selectedNodeId
    const isTarget = state.connectSourceId && state.connectSourceId !== n.id
    const li = h(
      'li',
      {
        class: `outline-item${isSel ? ' selected' : ''}${isTarget ? ' connect-target' : ''}`,
        role: 'option',
        tabindex: '0',
        'aria-selected': String(isSel),
        onclick: () => selectNode(n.id),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            selectNode(n.id)
          }
        }
      },
      h('span', { class: 'o-label' }, n.label || n.id),
      ro ? h('span', { class: 'badge ro', title: n.readOnlyReason || 'Read-only' }, 'ro') : null,
      errs.length ? h('span', { class: 'badge err', title: errs.join('\n') }, String(errs.length)) : null,
      h('span', { class: 'o-kind' }, n.kind)
    )
    return li
  })
  container.replaceChildren(...items)
}

function renderInspector(container) {
  if (state.selectedEdge) {
    const { from, to } = state.selectedEdge
    container.replaceChildren(
      h('div', { class: 'insp-head' }, h('h3', {}, 'Selected edge')),
      h('p', {}, `Dependency: ${from} → ${to}`),
      h('p', { class: 'muted' }, `"${to}" waits for "${from}" to finish.`),
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: () => removeEdge(from, to)
        },
        'Remove edge (Del)'
      )
    )
    return
  }

  const node = state.workflow.nodes.find((n) => n.id === state.selectedNodeId)
  if (!node) {
    container.replaceChildren(
      h('div', { class: 'insp-head' }, h('h3', {}, state.workflow.name)),
      h('p', { class: 'muted' }, state.workflow.description || 'No description.'),
      h('p', { class: 'muted' }, 'Select a node or edge from the canvas or outline to inspect or edit it.')
    )
    return
  }

  const ro = isReadOnlyNode(node)
  const nodes = state.workflow.nodes
  const availableDeps = nodes.filter((other) => other.id !== node.id && !(node.dependsOn || []).includes(other.id))

  const head = h(
    'div',
    { class: 'insp-head' },
    h('h3', {}, `${node.label || node.id}`),
    h(
      'div',
      { style: 'display:flex;gap:4px;' },
      h(
        'button',
        {
          type: 'button',
          title: 'Connect from this node (C)',
          onclick: () => startConnect(node.id)
        },
        'Connect'
      ),
      !ro
        ? h(
            'button',
            {
              type: 'button',
              class: 'danger',
              onclick: () => deleteNode(node.id)
            },
            'Delete'
          )
        : null
    )
  )

  const parts = [head]

  if (ro) {
    parts.push(
      h('p', { class: 'badge ro' }, 'Read-only node — preserved unchanged on save'),
      h('p', { class: 'muted' }, node.readOnlyReason || `Kind "${node.kind}" has no editor in this version.`)
    )
  } else {
    // Common fields
    parts.push(
      fieldText('Label', node.label || '', (val) => {
        node.label = val
        markEdited()
      }),
      fieldText('Node ID', node.id, (val) => {
        const oldId = node.id
        node.id = val
        for (const other of state.workflow.nodes) {
          if (other.dependsOn) {
            other.dependsOn = other.dependsOn.map((d) => (d === oldId ? val : d))
          }
        }
        if (state.selectedNodeId === oldId) state.selectedNodeId = val
        markEdited()
      })
    )

    if (node.kind === 'prompt') {
      parts.push(
        fieldTextarea('Prompt', node.prompt || '', (val) => {
          node.prompt = val
          markEdited()
        }),
        fieldText('Model', node.model || '', (val) => {
          node.model = val
          markEdited()
        }),
        fieldText('When (condition)', node.when || '', (val) => {
          node.when = val
          markEdited()
        }),
        fieldSelect('Trigger rule', node.triggerRule || 'all_success', ['all_success', 'one_success', 'all_done'], (val) => {
          node.triggerRule = val
          markEdited()
        })
      )
    } else if (node.kind === 'loop') {
      parts.push(
        fieldTextarea('Prompt', node.prompt || '', (val) => {
          node.prompt = val
          markEdited()
        }),
        fieldNumber('Max iterations', node.maxIterations ?? 3, (val) => {
          node.maxIterations = Number(val)
          markEdited()
        }),
        fieldText('Until (exit signal)', node.until || '', (val) => {
          node.until = val
          markEdited()
        }),
        h(
          'div',
          { class: 'field inline' },
          h(
            'label',
            {},
            h('input', {
              type: 'checkbox',
              ...(node.interactive ? { checked: 'checked' } : {}),
              onchange: (e) => {
                node.interactive = e.target.checked
                markEdited()
              }
            }),
            'Interactive'
          ),
          h(
            'label',
            {},
            h('input', {
              type: 'checkbox',
              ...(node.freshContext ? { checked: 'checked' } : {}),
              onchange: (e) => {
                node.freshContext = e.target.checked
                markEdited()
              }
            }),
            'Fresh context'
          )
        ),
        fieldText('Model', node.model || '', (val) => {
          node.model = val
          markEdited()
        }),
        fieldText('When (condition)', node.when || '', (val) => {
          node.when = val
          markEdited()
        })
      )
    } else if (node.kind === 'approval') {
      parts.push(
        fieldTextarea('Gate message', node.message || '', (val) => {
          node.message = val
          markEdited()
        }),
        fieldText('Options (comma-separated)', (node.options || []).join(', '), (val) => {
          node.options = val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          markEdited()
        })
      )
    } else if (node.kind === 'bash' || node.kind === 'script') {
      parts.push(
        fieldTextarea('Command', node.command || '', (val) => {
          node.command = val
          markEdited()
        }),
        fieldSelect('Runtime', node.runtime || 'bun', ['bun', 'node', 'bash'], (val) => {
          node.runtime = val
          markEdited()
        })
      )
    }

    // Depends on list
    const depsChips = (node.dependsOn || []).map((dep) =>
      h(
        'span',
        { class: 'dep-chip' },
        dep,
        h(
          'button',
          {
            type: 'button',
            'aria-label': `Remove dependency ${dep}`,
            onclick: () => removeEdge(dep, node.id)
          },
          '×'
        )
      )
    )
    const addDepSelect = h(
      'select',
      {
        'aria-label': 'Add dependency',
        onchange: (e) => {
          const val = e.target.value
          if (!val) return
          node.dependsOn = node.dependsOn || []
          if (!node.dependsOn.includes(val)) node.dependsOn.push(val)
          markEdited()
        }
      },
      h('option', { value: '' }, '+ Add dependency…'),
      ...availableDeps.map((d) => h('option', { value: d.id }, `${d.id} (${d.kind})`))
    )
    parts.push(
      h(
        'div',
        { class: 'field' },
        h('label', {}, 'Depends on'),
        h('div', { class: 'deps-list' }, ...(depsChips.length ? depsChips : [h('span', { class: 'muted' }, 'None')])),
        availableDeps.length ? addDepSelect : null
      )
    )
  }

  if (node.extra && Object.keys(node.extra).length > 0) {
    parts.push(
      h(
        'div',
        { class: 'ro-group' },
        h('h4', {}, 'Not editable here'),
        h('pre', {}, JSON.stringify(node.extra, null, 2))
      )
    )
  }

  container.replaceChildren(...parts)
}

function fieldText(label, value, onChange) {
  return h(
    'div',
    { class: 'field' },
    h('label', {}, label),
    h('input', {
      type: 'text',
      value,
      onchange: (e) => onChange(e.target.value)
    })
  )
}

function fieldNumber(label, value, onChange) {
  return h(
    'div',
    { class: 'field' },
    h('label', {}, label),
    h('input', {
      type: 'number',
      value: String(value),
      min: '1',
      onchange: (e) => onChange(e.target.value)
    })
  )
}

function fieldTextarea(label, value, onChange) {
  const ta = h('textarea', { onchange: (e) => onChange(e.target.value) }, value)
  return h('div', { class: 'field' }, h('label', {}, label), ta)
}

function fieldSelect(label, value, options, onChange) {
  const sel = h(
    'select',
    { onchange: (e) => onChange(e.target.value) },
    ...options.map((opt) => h('option', { value: opt, ...(opt === value ? { selected: 'selected' } : {}) }, opt))
  )
  return h('div', { class: 'field' }, h('label', {}, label), sel)
}

function renderIssues() {
  if (!state.workflow) return
  const { errors } = validateLocal(state.workflow)
  const total = state.serverErrors.length + errors.length
  $('issues-count').textContent = String(total)
  $('issues-count-tab').textContent = String(total)

  const rows = [
    ...state.serverErrors.map((msg) => h('div', { class: 'issue-row server' }, `Server: ${msg}`)),
    ...errors.map((err) =>
      h(
        'div',
        { class: 'issue-row' },
        err.nodeId
          ? h(
              'button',
              {
                type: 'button',
                class: 'link',
                onclick: () => selectNode(err.nodeId)
              },
              err.nodeId
            )
          : null,
        h('span', {}, err.message)
      )
    )
  ]
  if (rows.length === 0) {
    rows.push(h('p', { class: 'muted', style: 'margin:4px 0' }, 'No local or server issues.'))
  }
  $('issues-list').replaceChildren(...rows)
}

function applyView() {
  $('viewport').setAttribute('transform', `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`)
  const box = $('canvas').getBoundingClientRect()
  if (!box.width || !box.height) return
  const frame = $('mm-view')
  frame.setAttribute('x', -state.view.x / state.view.k)
  frame.setAttribute('y', -state.view.y / state.view.k)
  frame.setAttribute('width', box.width / state.view.k)
  frame.setAttribute('height', box.height / state.view.k)
}

function fit() {
  if (!state.layout) return
  const box = $('canvas').getBoundingClientRect()
  if (!box.width || !box.height) return
  const { width, height } = state.layout
  const k = Math.min(1.15, box.width / width, box.height / height)
  state.view = { k, x: (box.width - width * k) / 2, y: Math.max(8, (box.height - height * k) / 2) }
  applyView()
}

function zoomAt(factor, cx, cy) {
  state.autoFit = false
  const k = Math.min(3, Math.max(0.05, state.view.k * factor))
  state.view.x = cx - ((cx - state.view.x) * k) / state.view.k
  state.view.y = cy - ((cy - state.view.y) * k) / state.view.k
  state.view.k = k
  applyView()
}

function renderCanvas(skipLayout) {
  const overCap = state.workflow.nodes.length > MAX_CANVAS_NODES
  $('cap-notice').hidden = !overCap
  $('canvas').style.display = overCap ? 'none' : 'block'
  $('minimap').style.display = overCap ? 'none' : 'block'
  if (overCap) {
    $('cap-notice-text').textContent =
      `This workflow has ${state.workflow.nodes.length} nodes (canvas limit is ${MAX_CANVAS_NODES}).`
    return
  }

  if (!skipLayout || !state.layout) {
    state.layout = layoutGraph(state.workflow, state.direction)
  }
  const { byNode } = validateLocal(state.workflow)
  const frag = document.createDocumentFragment()

  for (const e of state.layout.edges) {
    const isSel = state.selectedEdge?.from === e.from && state.selectedEdge?.to === e.to
    const d = edgePath(e.points)
    frag.append(
      el('path', {
        class: `edge${e.conditional ? ' conditional' : ''}${isSel ? ' selected' : ''}`,
        d,
        'marker-end': isSel ? 'url(#arrow-selected)' : 'url(#arrow)'
      }),
      el('path', {
        class: 'edge-hit',
        d,
        'data-from': e.from,
        'data-to': e.to
      })
    )
  }

  for (const n of state.layout.nodes) {
    const d = n.data
    const ro = isReadOnlyNode(d)
    const hasErr = byNode.has(d.id)
    const isSel = d.id === state.selectedNodeId
    const isSrc = d.id === state.connectSourceId
    const isTgt = Boolean(state.connectSourceId && state.connectSourceId !== d.id)
    const cls = [
      'node',
      ro ? 'readonly' : '',
      hasErr ? 'has-error' : '',
      isSel ? 'selected' : '',
      isSrc ? 'connect-source' : '',
      isTgt ? 'connect-target' : ''
    ]
      .filter(Boolean)
      .join(' ')

    const g = el('g', {
      class: cls,
      transform: `translate(${n.x},${n.y})`,
      tabindex: 0,
      role: 'button',
      'aria-pressed': String(isSel),
      'aria-label': `${d.label || d.id}, ${d.kind}${ro ? ', read-only' : ''}`,
      'data-id': d.id
    })
    const glyph = hasErr ? '!' : ro ? '🔒' : ''
    g.append(
      el('rect', { class: 'box', width: NODE_W, height: NODE_H, rx: 6 }),
      el('rect', { class: 'bar', width: 4, height: NODE_H - 10, x: 4, y: 5, rx: 2 }),
      el('text', { class: 'label', x: 15, y: 21 }, clipLabel(d.label || d.id)),
      el('text', { class: 'kind', x: 15, y: 38 }, ro ? `${d.kind} · read-only` : d.kind),
      glyph ? el('text', { class: 'glyph', x: NODE_W - 15, y: 30 }, glyph) : document.createTextNode('')
    )
    frag.append(g)
  }

  $('viewport').replaceChildren(frag)
  $('minimap').setAttribute('viewBox', `0 0 ${state.layout.width} ${state.layout.height}`)
  $('mm-nodes').replaceChildren(
    ...state.layout.nodes.map((n) =>
      el('rect', {
        class: `mm-node${n.id === state.selectedNodeId ? ' selected' : ''}`,
        x: n.x,
        y: n.y,
        width: n.w,
        height: n.h
      })
    )
  )
  if (state.autoFit) fit()
  else applyView()
}

function renderInspectorOrSidecar() {
  if (!state.workflow) return
  if (state.variant === 'B') {
    $('sc-inspector').setAttribute('aria-selected', String(state.sidecarTab === 'inspector'))
    $('sc-outline').setAttribute('aria-selected', String(state.sidecarTab === 'outline'))
    $('sc-yaml').setAttribute('aria-selected', String(state.sidecarTab === 'yaml'))
    if (state.sidecarTab === 'outline') {
      const ul = h('ul', { class: 'outline-list-inline' })
      renderOutline(ul)
      $('inspector-body').replaceChildren(ul)
      return
    }
    if (state.sidecarTab === 'yaml') {
      $('inspector-body').replaceChildren(h('pre', { style: 'margin:0;font:11px/1.45 ui-monospace,monospace;' }, toYaml(state.workflow)))
      return
    }
  }
  renderInspector($('inspector-body'))
}

function renderCenterTabs() {
  $('tab-canvas').setAttribute('aria-selected', String(state.centerTab === 'canvas'))
  $('tab-yaml').setAttribute('aria-selected', String(state.centerTab === 'yaml'))
  $('tab-issues').setAttribute('aria-selected', String(state.centerTab === 'issues'))

  $('canvas-stage').style.display = state.centerTab === 'canvas' ? 'block' : 'none'
  $('yaml-view').hidden = state.centerTab !== 'yaml'
  if (state.centerTab === 'yaml') {
    $('yaml-view').textContent = toYaml(state.workflow)
  }
  if (state.centerTab === 'issues') {
    $('issues-pane').style.display = 'flex'
    $('issues-pane').style.gridArea = 'canvas'
  } else {
    $('issues-pane').style.display = ''
    $('issues-pane').style.gridArea = ''
  }
}

function renderAll({ skipLayout = false } = {}) {
  if (!state.workflow) return
  $('wf-scope').textContent = state.workflow.scope
  $('wf-file').textContent = state.workflow.file
  $('outline-count').textContent = `(${state.workflow.nodes.length})`
  renderOutline($('outline-list'))
  renderInspectorOrSidecar()
  renderIssues()
  renderCenterTabs()
  renderCanvas(skipLayout)
}

async function loadWorkflow(key) {
  const t0 = performance.now()
  const { saved, draft, storageMs } = await orca.plugin.request('builder.load', { key })
  const totalMs = performance.now() - t0
  state.savedJson = JSON.stringify(saved)
  state.workflow = structuredClone(draft || saved)
  state.dirty = Boolean(draft)
  $('dirty-badge').hidden = !state.dirty
  $('discard-btn').hidden = !state.dirty
  state.selectedNodeId = state.workflow.nodes[0]?.id ?? null
  state.selectedEdge = null
  state.serverErrors = []
  state.autoFit = true
  renderAll()
  const msg = `${draft ? 'Restored draft' : 'Loaded saved'} (${key}) in ${totalMs.toFixed(1)} ms (storage ${storageMs.toFixed(1)} ms)`
  setStatus(msg)
  logProto(msg)
}

async function saveWorkflow() {
  const res = await orca.plugin.request('builder.save', {
    key: state.workflow.key,
    workflow: state.workflow
  })
  state.savedJson = JSON.stringify(res.saved)
  state.dirty = false
  $('dirty-badge').hidden = true
  $('discard-btn').hidden = true
  setStatus(`Saved ${state.workflow.key} (${state.workflow.nodes.length} nodes)`)
}

async function validateWorkflow() {
  const local = validateLocal(state.workflow)
  const server = await orca.plugin.request('builder.validate', { workflow: state.workflow })
  state.serverErrors = server.errors || []
  renderAll({ skipLayout: true })
  setStatus(`Validated: ${local.errors.length} local, ${state.serverErrors.length} server issue(s)`)
}

// Wire controls
$('wf-select').addEventListener('change', (e) => void loadWorkflow(e.target.value))
$('direction').addEventListener('change', (e) => {
  state.direction = e.target.value
  state.autoFit = true
  renderAll()
})
$('add-node-btn').addEventListener('click', () => addNode($('add-kind').value))
$('connect-btn').addEventListener('click', () => startConnect(state.selectedNodeId))
$('connect-cancel').addEventListener('click', cancelConnect)
$('save-btn').addEventListener('click', () => void saveWorkflow())
$('validate-btn').addEventListener('click', () => void validateWorkflow())
$('discard-btn').addEventListener('click', async () => {
  await orca.plugin.request('builder.discardDraft', { key: state.workflow.key })
  await loadWorkflow(state.workflow.key)
})
$('width-toggle').addEventListener('click', () => {
  document.body.classList.toggle('sim-780')
  $('width-toggle').textContent = document.body.classList.contains('sim-780') ? 'Full width' : '780px'
  if (state.autoFit) fit()
})

$('tab-canvas').addEventListener('click', () => {
  state.centerTab = 'canvas'
  renderCenterTabs()
  if (state.autoFit) fit()
})
$('tab-yaml').addEventListener('click', () => {
  state.centerTab = 'yaml'
  renderCenterTabs()
})
$('tab-issues').addEventListener('click', () => {
  state.centerTab = 'issues'
  renderCenterTabs()
})

$('sc-inspector').addEventListener('click', () => {
  state.sidecarTab = 'inspector'
  renderInspectorOrSidecar()
})
$('sc-outline').addEventListener('click', () => {
  state.sidecarTab = 'outline'
  renderInspectorOrSidecar()
})
$('sc-yaml').addEventListener('click', () => {
  state.sidecarTab = 'yaml'
  renderInspectorOrSidecar()
})

$('var-prev').addEventListener('click', () => cycleVariant(-1))
$('var-next').addEventListener('click', () => cycleVariant(1))

// Canvas pan/zoom/select
let drag = null
$('canvas').addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node') || e.target.closest('.edge-hit')) return
  state.autoFit = false
  drag = { x: e.clientX - state.view.x, y: e.clientY - state.view.y }
  $('canvas').setPointerCapture(e.pointerId)
  $('canvas').classList.add('panning')
})
$('canvas').addEventListener('pointermove', (e) => {
  if (!drag) return
  state.view.x = e.clientX - drag.x
  state.view.y = e.clientY - drag.y
  applyView()
})
$('canvas').addEventListener('pointerup', () => {
  drag = null
  $('canvas').classList.remove('panning')
})
$('canvas').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const box = $('canvas').getBoundingClientRect()
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - box.left, e.clientY - box.top)
  },
  { passive: false }
)
$('canvas').addEventListener('click', (e) => {
  const node = e.target.closest('.node')
  if (node) {
    selectNode(node.dataset.id)
    return
  }
  const edge = e.target.closest('.edge-hit')
  if (edge) {
    selectEdge({ from: edge.dataset.from, to: edge.dataset.to })
    return
  }
  if (!state.connectSourceId) selectNode(null)
})

function centre() {
  const box = $('canvas').getBoundingClientRect()
  return [box.width / 2, box.height / 2]
}
$('zoom-in').addEventListener('click', () => zoomAt(1.25, ...centre()))
$('zoom-out').addEventListener('click', () => zoomAt(0.8, ...centre()))
$('fit').addEventListener('click', () => {
  state.autoFit = true
  fit()
})
new ResizeObserver(() => state.autoFit && fit()).observe($('canvas'))

// Global keyboard shortcuts: Ctrl/Cmd+S, Esc, C (connect), Delete (edge), variant arrows
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveWorkflow()
    setStatus('Saved via Ctrl/Cmd+S intercepted inside frame!')
    logProto('Ctrl/Cmd+S reached builder frame and triggered Save')
    return
  }
  if (e.key === 'Escape' && state.connectSourceId) {
    cancelConnect()
    return
  }
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  if (inInput) return

  if (e.key === 'ArrowLeft') {
    cycleVariant(-1)
  } else if (e.key === 'ArrowRight') {
    cycleVariant(1)
  } else if (e.key.toLowerCase() === 'c' && state.selectedNodeId) {
    startConnect(state.selectedNodeId)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedEdge) {
    e.preventDefault()
    removeEdge(state.selectedEdge.from, state.selectedEdge.to)
  }
})

// Boot: read pointer file + load draft/workflow BEFORE first render
const doc = await orca.document.get()
let pointer = {}
try {
  pointer = JSON.parse(doc.content.kind === 'text' ? doc.content.text : '{}')
} catch {
  pointer = {}
}
state.workflows = await orca.plugin.request('builder.list', {})
$('wf-select').replaceChildren(
  ...state.workflows.map((w) =>
    h('option', { value: w.key }, `${w.name} (${w.scope}, ${w.nodeCount})`)
  )
)
const initialKey = state.workflows.some((w) => w.key === pointer.key)
  ? pointer.key
  : state.workflows[0].key
$('wf-select').value = initialKey
setVariant(state.variant)
await loadWorkflow(initialKey)
