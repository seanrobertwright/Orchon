// The builder tab (#16, #28): a wide editor tab on a `.orchonflow` pointer file. It reads the
// workflow's identity from the file, asks the worker for the workflow's authored form, and draws
// it in the layout of #28: the canvas, a docked issues strip at the bottom, and a right sidecar
// with the tabs Inspector, Outline and YAML. A person edits the copy it holds: a node in the
// inspector's form, nodes added from a menu and removed or duplicated from the canvas or the
// outline, and dependencies in the "Depends on" list or in connect mode. Each edit goes through
// the edit session, which uses the copied Archon editor state; the graph is laid out again after
// every change, and the local rules run on the copy as it stands. Nothing is saved yet: the tab
// never edits its file, and no edit leaves the frame. An installed workflow is only viewed. Every
// piece of outside text is set through `textContent`.
import { createCanvas, type Canvas, type ObserveSize } from '../shared/canvas.ts'
import { elementMaker } from '../shared/dom.ts'
import { drawGraph, type DrawStep } from '../shared/graph-draw.ts'
import { layoutGraph, type Layout } from '../shared/graph-layout.ts'
import { isRecord } from '../shared/records.ts'
import type { TabConnection, TabScreen } from '../run-graph/graph-view.ts'
import type { TabTimers } from '../run-graph/refetch.ts'
import { VARIANTS, VARIANT_REGISTRY } from './archon/variants/index.ts'
import { mib, SCOPE_CAP, WORKFLOW_NAME_CAP, type BuilderAnswer, type BuilderHeader, type BuilderIdentity, type BuilderView } from './builder-view.ts'
import { openSession, type EditSession } from './edit-session.ts'
import { applyField, formFields, type FormField } from './node-form.ts'
import { workflowFactsOf, type IssueFacts, type NodeFacts, type WorkflowFacts } from './workflow-facts.ts'

/** The most nodes the canvas lays out, as the run graph (#17). Past it the outline carries on. */
export const CANVAS_CAP = 300
/** The most nodes the outline lists; past it a line says how many are not shown. */
export const OUTLINE_CAP = 2_000
/** The most issues the strip lists; past it a line says how many are not shown. */
export const ISSUES_CAP = 200
/** The most dependencies the inspector lists for one node; past it a line says how many are not shown. */
export const DEPENDS_CAP = 200
/** The most nodes the "Add a dependency" select offers; past it a line says how many are not offered. */
export const CHOICES_CAP = 2_000

/** The cap a pointer file's project id is read under, as the worker allows; its name and scope use the contract's caps. */
const PROJECT_CAP = 200

export const UNREADABLE_FILE = 'Orchon could not read this file: it does not name a workflow.'
export const VIEW_ONLY_LINE = 'This workflow is installed, so it can only be viewed here.'
export const UNREADABLE_DEFINITION = "The builder could not read this workflow's definition."
export const UNSAVED_LINE = 'Unsaved changes'
export const OUTSIDE_CHANGE = 'This workflow changed outside the builder. Your unsaved changes are kept until you choose.'
export const RELOAD_ASKED = 'Reloading replaces the copy you are editing. Your unsaved changes are kept until you choose.'
const WORKER_UNANSWERED = "Orchon's worker did not answer."
const NOT_CONNECTED_BANNER = 'Orchon is not connected to Archon. What is shown was read before.'
const PICK_A_NODE = 'Choose a node on the canvas or in the outline to see it here.'

export type BuilderTabPorts = {
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
  /** The tab sets no timer of its own today; it is given the frame's for the ones saving brings. */
  timers: TabTimers
  /** Opens a link in the system browser, when the frame can. */
  openExternal?(url: string): Promise<unknown>
  /** Reports the canvas's size and its changes, so the graph is fitted to it. */
  observeSize?: ObserveSize
}

export type BuilderTab = { stop(): void }

const capped = (value: unknown, cap: number): value is string => typeof value === 'string' && value !== '' && value.length <= cap

/** The workflow a pointer file names, or null: `{ "orchon": "builder", name, codebaseId, scope }`. */
export function parseBuilderPointer(text: string | null): BuilderIdentity | null {
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || value.orchon !== 'builder') return null
  if (!Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'codebaseId') || !Object.hasOwn(value, 'scope')) return null
  const { name, codebaseId, scope } = value
  if (!capped(name, WORKFLOW_NAME_CAP) || !capped(scope, SCOPE_CAP)) return null
  if (codebaseId !== null && !capped(codebaseId, PROJECT_CAP)) return null
  return { name, codebaseId, scope }
}

/** Whether an answer came back in the shape the tab draws. The worker is trusted, but a frame checks what it reads. */
function isAnswer(value: unknown): value is BuilderAnswer {
  return isRecord(value) && isRecord(value.connection) && isRecord(value.builder) && typeof value.builder.kind === 'string' && typeof value.connection.kind === 'string'
}

type Ready = Extract<BuilderView, { kind: 'ready' }>
type TooLarge = Extract<BuilderView, { kind: 'too-large' }>
type SidecarTab = 'inspector' | 'outline' | 'yaml'
const SIDECAR_TABS: readonly { id: SidecarTab; name: string }[] = [
  { id: 'inspector', name: 'Inspector' },
  { id: 'outline', name: 'Outline' },
  { id: 'yaml', name: 'YAML' }
]

type EditOptions = { keepSelection?: boolean; typing?: boolean }

/** What a node at fault carries: a glyph and the count in words. Errors outrank warnings; information is no fault. */
type Fault = { glyph: string; words: string }

let tabs = 0

/** A node's name as the tab shows it: its id, or `(no id)`. */
const nodeLabel = (node: NodeFacts): string => (node.id === '' ? '(no id)' : node.id)
const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

/** The fault of each node, by position, from the issues that name it. */
function faultsOf(facts: WorkflowFacts): (Fault | null)[] {
  const counts = new Map<string, { errors: number; warnings: number }>()
  for (const issue of facts.issues) {
    if (issue.nodeId === null || issue.severity === 'Info') continue
    const held = counts.get(issue.nodeId) ?? { errors: 0, warnings: 0 }
    if (issue.severity === 'Error') held.errors += 1
    else held.warnings += 1
    counts.set(issue.nodeId, held)
  }
  return facts.nodes.map((node) => {
    const held = counts.get(node.id)
    if (held === undefined) return null
    if (held.errors > 0) return { glyph: '✖', words: plural(held.errors, 'error', 'errors') }
    return { glyph: '⚠', words: plural(held.warnings, 'warning', 'warnings') }
  })
}

/** Whether a key press is typed into a field, where the tab's own keys do not apply. */
function typedIntoField(target: EventTarget | null): boolean {
  const name = target === null ? '' : String((target as Element).tagName).toLowerCase()
  return name === 'input' || name === 'textarea' || name === 'select'
}

/** Every element under `root`, `root` included, in document order. */
const elementsUnder = (root: HTMLElement): HTMLElement[] => [root, ...Array.from(root.children).flatMap((child) => elementsUnder(child as HTMLElement))]

export function startBuilderTab(ports: BuilderTabPorts): BuilderTab {
  const { doc } = ports
  const el = elementMaker(doc)
  const prefix = `builder-${String((tabs += 1))}`
  let ids = 0
  /** A unique id in this document. */
  const freshId = (what: string): string => `${prefix}-${what}-${String((ids += 1))}`

  /** A sentence in which each word between backticks is code. */
  const withCode = (sentence: string): HTMLParagraphElement => {
    const line = el('p')
    sentence.split('`').forEach((part, index) => {
      if (part === '') return
      line.appendChild(index % 2 === 1 ? el('code', part) : el('span', part))
    })
    return line
  }
  const button = (text: string, onClick: () => void, className?: string): HTMLButtonElement => {
    const made = el('button', text, className)
    made.setAttribute('type', 'button')
    made.addEventListener('click', onClick)
    return made
  }
  /** A button whose name says more than its text, such as "Remove plan" for "Remove". */
  const named = (text: string, name: string, onClick: () => void, className?: string): HTMLButtonElement => {
    const made = button(text, onClick, className)
    made.setAttribute('aria-label', name)
    made.setAttribute('title', name)
    return made
  }

  const top = el('header', undefined, 'tab-header')
  const banners = el('div', undefined, 'banners')
  banners.setAttribute('role', 'status')
  banners.setAttribute('aria-live', 'polite')
  /** The question asked when a read would replace the copy being edited. */
  const changePrompt = el('section', undefined, 'outside-change')
  changePrompt.setAttribute('aria-label', 'The workflow changed')
  changePrompt.hidden = true
  const content = el('main', undefined, 'content builder-content')
  content.appendChild(el('p', 'Loading the workflow…', 'muted'))
  ports.app.replaceChildren(top, banners, changePrompt, content)

  // The layout of #28, made once and kept while the tab is open.
  const layout = el('div', undefined, 'builder-layout')
  const canvasPane = el('section', undefined, 'canvas-pane')
  canvasPane.setAttribute('aria-label', 'Workflow graph')
  const sidecar = el('aside', undefined, 'sidecar')
  sidecar.setAttribute('aria-label', 'Inspector, outline and YAML')
  const issuesStrip = el('section', undefined, 'issues-strip')
  issuesStrip.setAttribute('aria-label', 'Issues')
  layout.append(canvasPane, sidecar, issuesStrip)

  const tabList = el('div', undefined, 'sidecar-tabs')
  tabList.setAttribute('role', 'tablist')
  tabList.setAttribute('aria-label', 'Sidecar')
  const tabButtons = new Map<SidecarTab, HTMLButtonElement>()
  const panels = new Map<SidecarTab, HTMLElement>()
  let current: SidecarTab = 'inspector'
  for (const { id, name } of SIDECAR_TABS) {
    const tabButton = button(name, () => choose(id), 'sidecar-tab')
    tabButton.id = `${prefix}-tab-${id}`
    tabButton.setAttribute('role', 'tab')
    tabButton.setAttribute('aria-controls', `${prefix}-panel-${id}`)
    tabButtons.set(id, tabButton)
    tabList.appendChild(tabButton)
    const panel = el('div', undefined, 'sidecar-panel')
    panel.id = `${prefix}-panel-${id}`
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tabButton.id)
    panel.setAttribute('tabindex', '0')
    panels.set(id, panel)
  }
  sidecar.append(tabList, ...panels.values())
  // The tab keyboard pattern: arrows, Home and End move between the tabs, and show the one reached.
  tabList.addEventListener('keydown', (event) => {
    const order = SIDECAR_TABS.map((entry) => entry.id)
    const at = order.indexOf(current)
    const next =
      event.key === 'ArrowRight' ? order[(at + 1) % order.length] : event.key === 'ArrowLeft' ? order[(at + order.length - 1) % order.length] : event.key === 'Home' ? order[0] : event.key === 'End' ? order.at(-1) : undefined
    if (next === undefined) return
    event.preventDefault()
    choose(next)
    tabButtons.get(next)?.focus()
  })

  function choose(id: SidecarTab): void {
    current = id
    for (const [tabId, tabButton] of tabButtons) {
      const selected = tabId === id
      tabButton.setAttribute('aria-selected', String(selected))
      tabButton.setAttribute('tabindex', selected ? '0' : '-1')
      const panel = panels.get(tabId)
      if (panel !== undefined) panel.hidden = !selected
    }
  }
  choose('inspector')

  // The header's editing controls, made once: Undo, Redo, and the Add node menu.
  const unsavedLine = el('p', '', 'unsaved')
  const undoButton = button('Undo', () => edit(() => session?.undo() ?? false, { keepSelection: true }))
  const redoButton = button('Redo', () => edit(() => session?.redo() ?? false, { keepSelection: true }))
  const addMenu = el('div', undefined, 'add-menu')
  addMenu.id = `${prefix}-add-menu`
  addMenu.setAttribute('aria-label', 'Kinds of node')
  addMenu.setAttribute('role', 'group')
  addMenu.hidden = true
  const addButton = button('Add node', () => setMenu(addButton.getAttribute('aria-expanded') !== 'true'))
  addButton.setAttribute('aria-expanded', 'false')
  addButton.setAttribute('aria-controls', addMenu.id)
  for (const variant of VARIANTS) {
    addMenu.appendChild(
      button(VARIANT_REGISTRY[variant].label, () => {
        setMenu(false)
        if (session === null || !editable) return
        const added = session.addNode(variant)
        finish(true)
        select(added)
        choose('inspector')
      })
    )
  }
  const editBar = el('div', undefined, 'edit-bar')
  editBar.setAttribute('role', 'group')
  editBar.setAttribute('aria-label', 'Editing')
  editBar.append(undoButton, redoButton, addButton, addMenu)

  /** Opens or closes the Add node menu. A closing menu hands the focus it held back to its button, as a disclosure does. */
  function setMenu(open: boolean): void {
    const active = doc.activeElement
    if (!open && active !== null && addMenu.contains(active)) addButton.focus()
    addMenu.hidden = !open
    addButton.setAttribute('aria-expanded', String(open))
  }

  // The canvas's own editing tools, for the node chosen on it.
  const canvasConnect = button('Connect', () => toggleConnect())
  const canvasDuplicate = button('Duplicate', () => {
    if (selected !== null) duplicate(selected)
  })
  const canvasRemove = button('Remove', () => {
    if (selected !== null) remove(selected)
  })
  const canvasTools = [canvasConnect, canvasDuplicate, canvasRemove]

  let identity: BuilderIdentity | null = null
  /** The view last drawn, or null before one. */
  let shown: Ready | TooLarge | null = null
  /** The copy being edited, opened from `openedText`. */
  let session: EditSession | null = null
  let openedText = ''
  /** A definition the person chose to keep editing over: a read that brings it again asks nothing. */
  let keptOver = ''
  /** The read that would replace the copy being edited, held until the person chooses. */
  let waiting: Ready | null = null
  let editable = false
  let facts: WorkflowFacts | null = null
  let faults: (Fault | null)[] = []
  let selected: number | null = null
  let selectedEdge: { from: number; to: number } | null = null
  /** The node a dependency is being connected from, in connect mode. */
  let connecting: number | null = null
  /** The field being typed into, so a burst of typing is one undo step. */
  let burst: string | null = null
  let connectionLines: string[] = []
  let canvas: Canvas | undefined
  /** What the canvas was drawn from, so an edit that changes nothing on it draws nothing again. */
  let canvasKey = ''
  let layoutKey = ''
  let laid: Layout | null = null
  let fitNext = true
  let outlineKey = ''
  let boxes = new Map<string, Element>()
  let edgePaths = new Map<string, Element>()
  let outlineButtons: HTMLButtonElement[] = []
  let inspectorYaml: HTMLElement | null = null
  /** Rises with each read; only the newest read's answer is drawn. */
  let counter = 0
  let inFlight = false
  let queued = false
  /** Whether the person asked for the read now in flight, by Reload. */
  let asked = false
  /** Whether the last answer found Archon: a post that it is found again reads once more. */
  let connected = false
  let stopped = false
  const subscriptions: { dispose(): void }[] = []

  /** The banners: the connection's lines, then connect mode's. */
  function showBanners(): void {
    const lines = [...connectionLines]
    const from = connecting === null ? undefined : facts?.nodes[connecting]
    if (from !== undefined) lines.push(`Connecting from ${nodeLabel(from)}: choose the node that runs after it. Esc cancels.`)
    banners.replaceChildren(...lines.map((line) => el('p', line, 'banner')))
  }
  function setBanners(lines: readonly string[]): void {
    connectionLines = [...lines]
    showBanners()
  }

  /** Stops the canvas and lets it go, so the next draw makes a new one. */
  function dropCanvas(): void {
    canvas?.stop()
    canvas = undefined
    canvasKey = ''
  }

  function drawHeader(view: BuilderHeader | null): void {
    if (view === null) {
      top.replaceChildren()
      return
    }
    const parts: HTMLElement[] = [el('h1', view.name), el('p', `Source: ${view.source}`, 'meta'), el('p', `File: ${view.file}`, 'meta file')]
    if (view.viewOnly) parts.push(el('p', VIEW_ONLY_LINE, 'view-only'))
    else parts.push(unsavedLine)
    const actions = el('p', undefined, 'actions')
    if (view.openYaml) actions.appendChild(button('Open YAML', openYaml))
    actions.appendChild(
      button('Reload', () => {
        asked = true
        load()
      })
    )
    parts.push(actions)
    if (!view.viewOnly) parts.push(editBar)
    top.replaceChildren(...parts)
  }

  /** Says whether the copy differs from the one opened, and what can be undone and redone. */
  function drawEditState(): void {
    unsavedLine.textContent = session?.dirty() === true ? UNSAVED_LINE : ''
    undoButton.disabled = session?.canUndo() !== true
    redoButton.disabled = session?.canRedo() !== true
    canvasConnect.setAttribute('aria-pressed', String(connecting !== null))
    for (const tool of canvasTools) tool.disabled = selected === null
  }

  function openYaml(): void {
    if (identity === null) return
    void ports
      .request('builder.openYaml', identity)
      .then((answer) => {
        if (isRecord(answer) && answer.opened === false && typeof answer.reason === 'string') setBanners([answer.reason])
      })
      .catch(() => setBanners([WORKER_UNANSWERED]))
  }

  function drawScreen(screen: TabScreen): void {
    drawHeader(null)
    setBanners([])
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
            .then(() => load())
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

  /** A message in place of the content, with Try again when the read may work a second time. */
  function drawMessage(message: string, tryAgain: boolean): void {
    drawHeader(null)
    setBanners([])
    content.replaceChildren(el('p', message), ...(tryAgain ? [button('Try again', () => load())] : []))
  }

  /** Marks the chosen node and edge on the canvas and in the outline. */
  function markSelected(): void {
    for (const [key, box] of boxes) box.setAttribute('aria-pressed', String(key === `n${String(selected)}`))
    outlineButtons.forEach((item, index) => item.setAttribute('aria-pressed', String(index === selected)))
    const edgeKey = selectedEdge === null ? '' : `n${String(selectedEdge.from)}>n${String(selectedEdge.to)}`
    for (const [key, path] of edgePaths) {
      const words = (path.getAttribute('class') ?? '').split(' ').filter((word) => word !== 'selected' && word !== '')
      path.setAttribute('class', [...words, ...(key === edgeKey ? ['selected'] : [])].join(' '))
    }
  }

  function select(index: number | null): void {
    selected = index
    selectedEdge = null
    burst = null
    markSelected()
    drawEditState()
    if (facts !== null) drawInspector(facts)
  }

  function selectEdge(from: number, to: number): void {
    selected = null
    selectedEdge = { from, to }
    connecting = null
    burst = null
    showBanners()
    markSelected()
    drawEditState()
    if (facts !== null) drawInspector(facts)
  }

  /** A node pressed on the canvas or in the outline: the target in connect mode, else the node to show. */
  function pressNode(index: number): void {
    if (connecting !== null && editable) {
      const source = connecting
      const from = facts?.nodes[source]
      connecting = null
      if (from !== undefined && index !== source) edit(() => session?.addDependency(index, from.id) ?? false, { keepSelection: true })
      else {
        showBanners()
        drawEditState()
      }
      return
    }
    select(index)
  }

  function toggleConnect(): void {
    if (!editable || selected === null) return
    connecting = connecting === null ? selected : null
    showBanners()
    drawEditState()
    if (facts !== null) drawInspector(facts)
  }

  function cancelConnect(): void {
    if (connecting === null) return
    connecting = null
    showBanners()
    drawEditState()
    if (facts !== null) drawInspector(facts)
  }

  function duplicate(index: number): void {
    if (session === null || !editable) return
    const copy = session.duplicateNode(index)
    finish(copy !== null)
    if (copy !== null) select(copy)
  }

  function remove(index: number): void {
    const was = selected
    edit(() => session?.removeNode(index) ?? false)
    if (was !== null && was !== index) select(was > index ? was - 1 : was)
  }

  /**
   * Makes one edit and draws what changed. Every edit but a burst of typing ends connect mode and
   * the chosen edge, and the chosen node too unless `keepSelection` holds it; a node no longer
   * there is let go.
   */
  function edit(change: () => boolean, options: EditOptions = {}): void {
    if (session === null || !editable) return
    finish(change(), options)
  }

  /** Draws what an edit changed; `changed` says whether it changed the workflow. */
  function finish(changed: boolean, options: EditOptions = {}): void {
    if (session === null) return
    if (options.typing !== true) {
      burst = null
      connecting = null
      selectedEdge = null
      if (options.keepSelection !== true) selected = null
    }
    if (selected !== null && selected >= session.workflow().nodes.length) selected = null
    if (!changed && options.typing !== true) {
      showBanners()
      drawEditState()
      if (facts !== null) drawInspector(facts)
      return
    }
    redraw(options.typing === true ? 'typing' : 'all')
  }

  /** Works out what the copy shows and draws it: all of it, or, while a field is typed into, all but the form. */
  function redraw(scope: 'all' | 'typing'): void {
    if (session === null) return
    facts = workflowFactsOf(session.workflow(), session.openingIssues)
    faults = faultsOf(facts)
    if (connecting !== null && connecting >= facts.nodes.length) connecting = null
    drawCanvas(facts)
    drawOutline(facts)
    drawYaml(facts)
    drawIssues(facts)
    if (scope === 'all') drawInspector(facts)
    else if (inspectorYaml !== null && selected !== null) inspectorYaml.textContent = facts.nodes[selected]?.yaml ?? ''
    showBanners()
    markSelected()
    drawEditState()
  }

  /** The canvas, or the notice past the cap. Laid out again only when the nodes or arrows change. */
  function drawCanvas(drawn: WorkflowFacts): void {
    const key = JSON.stringify([drawn.name, editable, drawn.nodes.map((node, index) => [node.id, node.kind, node.readOnly, node.conditional, faults[index]?.words ?? '']), drawn.edges])
    if (key === canvasKey && (canvas !== undefined || drawn.nodes.length > CANVAS_CAP)) return
    canvasKey = key
    if (drawn.nodes.length > CANVAS_CAP) {
      canvas?.stop()
      canvas = undefined
      boxes = new Map()
      edgePaths = new Map()
      const notice = el('section', undefined, 'cap-notice')
      notice.append(
        el('h2', 'The canvas is not drawn'),
        el('p', `This workflow has ${String(drawn.nodes.length)} nodes. The canvas draws at most ${String(CANVAS_CAP)}, so it gives way here. Every node is listed under Outline.`)
      )
      canvasPane.replaceChildren(notice)
      return
    }
    const label = `Nodes of ${drawn.name === '' ? 'this workflow' : drawn.name}`
    canvas ??= createCanvas({
      doc,
      label,
      idPrefix: prefix,
      onStep: (stepKey) => {
        const index = Number(stepKey.slice(1))
        if (!Number.isInteger(index)) return
        pressNode(index)
        choose('inspector')
      },
      onEdge: (fromKey, toKey) => {
        const from = Number(fromKey.slice(1))
        const to = Number(toKey.slice(1))
        if (!Number.isInteger(from) || !Number.isInteger(to)) return
        selectEdge(from, to)
        choose('inspector')
      },
      ...(ports.observeSize === undefined ? {} : { observeSize: ports.observeSize })
    })
    canvas.viewport.setAttribute('aria-label', label)
    for (const tool of canvasTools) {
      if (editable && tool.parentElement !== canvas.tools) canvas.tools.appendChild(tool)
      if (!editable) tool.parentElement?.removeChild(tool)
    }
    const keys = drawn.nodes.map((_, index) => `n${String(index)}`)
    const nextLayout = JSON.stringify([drawn.nodes.map((node) => node.conditional), drawn.edges])
    if (laid === null || nextLayout !== layoutKey) {
      layoutKey = nextLayout
      laid = layoutGraph(
        drawn.nodes.map((node, index) => ({ id: keys[index] ?? '', group: null, isGroup: false, conditional: node.conditional })),
        drawn.edges.map((edge) => ({ from: keys[edge.from] ?? '', to: keys[edge.to] ?? '' })),
        'TB'
      )
    }
    const steps = new Map<string, DrawStep>()
    drawn.nodes.forEach((node, index) => {
      const fault = faults[index]
      steps.set(keys[index] ?? '', {
        name: nodeLabel(node),
        kind: node.kind,
        state: 'draft',
        stateText: node.kind,
        note: null,
        readOnly: node.readOnly,
        ...(fault === null || fault === undefined ? {} : { fault })
      })
    })
    const svg = drawGraph(doc, laid, steps, { label, idPrefix: prefix })
    boxes = new Map()
    edgePaths = new Map()
    const visit = (element: Element): void => {
      const step = element.getAttribute('data-step')
      if (step !== null) boxes.set(step, element)
      const from = element.getAttribute('data-from')
      const to = element.getAttribute('data-to')
      if (from !== null && to !== null) edgePaths.set(`${from}>${to}`, element)
      for (const child of Array.from(element.children)) visit(child)
    }
    visit(svg)
    canvas.show(svg, laid, new Map(keys.map((stepKey) => [stepKey, 'draft'])), { fit: fitNext })
    fitNext = false
    if (canvasPane.children[0] !== canvas.root) canvasPane.replaceChildren(canvas.root)
  }

  function drawOutline(drawn: WorkflowFacts): void {
    const panel = panels.get('outline')
    if (panel === undefined) return
    const key = JSON.stringify([editable, drawn.nodes.slice(0, OUTLINE_CAP).map((node, index) => [node.id, node.kind, node.readOnly, faults[index]?.words ?? '']), drawn.nodes.length])
    if (key === outlineKey) return
    outlineKey = key
    const count = drawn.nodes.length
    const list = el('ul', undefined, 'outline')
    list.setAttribute('aria-label', 'Nodes')
    outlineButtons = drawn.nodes.slice(0, OUTLINE_CAP).map((node, index) => {
      const fault = faults[index] ?? null
      const name = nodeLabel(node)
      const item = button('', () => pressNode(index), 'outline-node')
      item.setAttribute('aria-label', `${name}, ${node.kind}${node.readOnly ? ', read-only' : ''}${fault === null ? '' : `, ${fault.words}`}`)
      item.append(el('span', name, 'outline-id'), el('span', node.kind, 'outline-kind'))
      if (fault !== null) item.appendChild(el('span', fault.glyph, 'badge fault'))
      if (node.readOnly) item.appendChild(el('span', 'ro', 'badge ro'))
      const row = el('li', undefined, 'outline-row')
      row.appendChild(item)
      if (editable) row.append(named('⧉', `Duplicate ${name}`, () => duplicate(index), 'row-action'), named('✕', `Remove ${name}`, () => remove(index), 'row-action'))
      list.appendChild(row)
      return item
    })
    const parts: HTMLElement[] = [el('p', plural(count, 'node', 'nodes'), 'muted'), list]
    if (count > OUTLINE_CAP) parts.push(el('p', `${String(count - OUTLINE_CAP)} more nodes are not shown.`, 'muted'))
    panel.replaceChildren(...parts)
  }

  function yamlBlock(text: string, label: string): HTMLPreElement {
    const block = el('pre', text, 'yaml')
    block.setAttribute('aria-label', label)
    block.setAttribute('tabindex', '0')
    return block
  }

  /** Draws the inspector again, keeping the focus on the same control when it is still there. */
  function drawInspector(drawn: WorkflowFacts): void {
    const panel = panels.get('inspector')
    if (panel === undefined) return
    const active = doc.activeElement
    const focusKey = active !== null && panel.contains(active) ? active.getAttribute('data-focus') : null
    panel.replaceChildren(...inspectorParts(drawn))
    if (focusKey === null) return
    const again = elementsUnder(panel).find((element) => element.getAttribute('data-focus') === focusKey)
    again?.focus()
  }

  function inspectorParts(drawn: WorkflowFacts): HTMLElement[] {
    inspectorYaml = null
    if (selectedEdge !== null) {
      const from = drawn.nodes[selectedEdge.from]
      const to = drawn.nodes[selectedEdge.to]
      if (from !== undefined && to !== undefined) {
        const parts: HTMLElement[] = [el('h2', `${nodeLabel(from)} → ${nodeLabel(to)}`), el('p', `${nodeLabel(to)} depends on ${nodeLabel(from)}.`)]
        if (editable) {
          const target = selectedEdge.to
          parts.push(el('p', undefined, 'actions'))
          parts.at(-1)?.appendChild(focusable(button('Remove edge', () => edit(() => session?.removeDependency(target, from.id) ?? false, { keepSelection: true })), 'remove-edge'))
        }
        return parts
      }
    }
    const node: NodeFacts | undefined = selected === null ? undefined : drawn.nodes[selected]
    if (node === undefined || selected === null) return workflowParts(drawn)
    const index = selected
    const name = nodeLabel(node)
    const parts: HTMLElement[] = [el('h2', name), el('p', `Kind: ${node.kind}`)]
    if (node.readOnly) parts.push(el('p', `🔒 Read-only. ${node.reason ?? ''} It is saved unchanged.`, 'banner read-only-banner'))
    const fault = faults[index] ?? null
    if (fault !== null) parts.push(el('p', `${fault.glyph} ${fault.words}: see Issues.`, 'fault-line'))
    if (editable) {
      const actions = el('p', undefined, 'actions')
      const connect = focusable(button('Connect', () => toggleConnect()), 'connect')
      connect.setAttribute('aria-pressed', String(connecting === index))
      actions.append(connect, focusable(button('Duplicate', () => duplicate(index)), 'duplicate'), focusable(button('Remove', () => remove(index)), 'remove'))
      parts.push(actions)
      const held = session?.workflow().nodes[index]
      if (held !== undefined) {
        const form = el('div', undefined, 'node-form')
        for (const field of formFields(held)) form.appendChild(fieldControl(index, field))
        parts.push(form)
      }
    }
    parts.push(...dependsParts(drawn, node, index))
    if (node.notEditable.length > 0) {
      const group = el('section', undefined, 'not-editable')
      const fields = el('ul')
      for (const field of node.notEditable) fields.appendChild(el('li', field))
      group.append(el('h3', 'Not editable here'), fields, el('p', 'These fields are kept and saved unchanged.', 'muted'))
      parts.push(group)
    }
    const block = yamlBlock(node.yaml, `YAML of ${name}, read-only`)
    inspectorYaml = block
    parts.push(el('h3', 'YAML'), block)
    return parts
  }

  function workflowParts(drawn: WorkflowFacts): HTMLElement[] {
    const parts: HTMLElement[] = [el('h2', drawn.name === '' ? 'This workflow' : drawn.name)]
    if (editable) {
      const id = freshId('description')
      const label = el('label', 'Workflow description')
      label.setAttribute('for', id)
      const area = focusable(el('textarea', undefined, 'field-input'), 'workflow-description')
      area.id = id
      area.rows = 3
      area.value = drawn.description
      area.addEventListener('input', () => {
        const text = area.value
        edit(() => session?.setDescription(text, burst === 'description') ?? false, { typing: true })
        burst = 'description'
      })
      area.addEventListener('change', () => {
        burst = null
      })
      const field = el('div', undefined, 'field')
      field.append(label, area)
      parts.push(field)
    } else if (drawn.description !== '') parts.push(el('p', drawn.description))
    if (drawn.settingsYaml !== '') parts.push(el('h3', 'Workflow settings'), yamlBlock(drawn.settingsYaml, 'Workflow settings, read-only'))
    parts.push(el('p', PICK_A_NODE, 'muted'))
    return parts
  }

  /** The "Depends on" list, with Remove on each and a select to add one when the workflow is editable. */
  function dependsParts(drawn: WorkflowFacts, node: NodeFacts, index: number): HTMLElement[] {
    const parts: HTMLElement[] = [el('h3', 'Depends on')]
    if (node.dependsOn.length === 0) parts.push(el('p', 'Nothing.', 'muted'))
    else {
      const list = el('ul', undefined, 'depends')
      for (const id of node.dependsOn.slice(0, DEPENDS_CAP)) {
        const row = el('li')
        row.appendChild(el('span', id, 'dep-id'))
        if (editable) row.appendChild(focusable(named('Remove', `Remove the dependency on ${id}`, () => edit(() => session?.removeDependency(index, id) ?? false, { keepSelection: true }), 'row-action'), `dep-remove:${id}`))
        list.appendChild(row)
      }
      parts.push(list)
      const more = node.dependsOn.length - DEPENDS_CAP
      if (more > 0) parts.push(el('p', `${String(more)} more ${more === 1 ? 'dependency is' : 'dependencies are'} not shown.`, 'muted'))
    }
    if (!editable) return parts
    const taken = new Set([node.id, ...node.dependsOn])
    const choices: string[] = []
    for (const other of drawn.nodes) {
      if (other.id !== '' && !taken.has(other.id)) {
        taken.add(other.id)
        choices.push(other.id)
      }
    }
    const id = freshId('add-dependency')
    const label = el('label', 'Add a dependency')
    label.setAttribute('for', id)
    const select = focusable(el('select', undefined, 'field-input'), 'dep-select')
    select.id = id
    select.appendChild(option('', 'Choose a node'))
    for (const choice of choices.slice(0, CHOICES_CAP)) select.appendChild(option(choice, choice))
    select.value = ''
    const add = focusable(
      button('Add', () => {
        const chosen = select.value
        if (chosen !== '') edit(() => session?.addDependency(index, chosen) ?? false, { keepSelection: true })
      }),
      'dep-add'
    )
    const row = el('div', undefined, 'field add-dependency')
    row.append(label, select, add)
    parts.push(row)
    if (choices.length > CHOICES_CAP) parts.push(el('p', `${String(choices.length - CHOICES_CAP)} more nodes are not offered.`, 'muted'))
    return parts
  }

  function option(value: string, text: string): HTMLOptionElement {
    const made = el('option', text)
    made.value = value
    made.setAttribute('value', value)
    return made
  }

  /** Marks a control so the focus stays on it when the inspector is drawn again. */
  function focusable<T extends HTMLElement>(element: T, key: string): T {
    element.setAttribute('data-focus', key)
    return element
  }

  /** One labelled field of the form, which sets its value on the node as the person edits it. */
  function fieldControl(index: number, field: FormField): HTMLElement {
    const id = freshId('field')
    const wrap = el('div', undefined, field.input === 'checkbox' ? 'field check' : 'field')
    const label = el('label', field.label)
    label.setAttribute('for', id)
    const error = el('p', '', 'field-error')
    error.id = `${id}-error`
    let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    if (field.input === 'textarea' || field.input === 'lines') {
      const area = el('textarea', undefined, 'field-input')
      area.rows = field.input === 'lines' ? 3 : 5
      control = area
    } else if (field.input === 'select') {
      const select = el('select', undefined, 'field-input')
      for (const choice of field.options ?? []) select.appendChild(option(choice.value, choice.label))
      control = select
    } else {
      const input = el('input', undefined, field.input === 'checkbox' ? undefined : 'field-input')
      input.type = field.input === 'checkbox' ? 'checkbox' : 'text'
      if (field.input === 'number') input.setAttribute('inputmode', 'numeric')
      control = input
    }
    control.id = id
    focusable(control, `field:${field.key}`)
    if (field.input === 'checkbox') (control as HTMLInputElement).checked = field.value === true
    else control.value = typeof field.value === 'string' ? field.value : ''

    const set = (typing: boolean): void => {
      const held = session?.workflow().nodes[index]
      if (held === undefined) return
      const raw = field.input === 'checkbox' ? (control as HTMLInputElement).checked : control.value
      const applied = applyField(held, field, raw)
      if (!applied.ok) {
        control.setAttribute('aria-invalid', 'true')
        control.setAttribute('aria-describedby', error.id)
        error.textContent = applied.error
        return
      }
      control.removeAttribute('aria-invalid')
      control.removeAttribute('aria-describedby')
      error.textContent = ''
      const burstKey = `${String(index)}:${field.key}`
      edit(() => session?.setNode(index, applied.node, typing && burst === burstKey) ?? false, typing ? { typing: true } : { keepSelection: true })
      burst = typing ? burstKey : null
    }
    if (field.input === 'checkbox' || field.input === 'select') control.addEventListener('change', () => set(false))
    else {
      control.addEventListener('input', () => set(true))
      control.addEventListener('change', () => {
        burst = null
      })
    }
    if (field.input === 'checkbox') wrap.append(control, label, error)
    else wrap.append(label, control, error)
    return wrap
  }

  function drawYaml(drawn: WorkflowFacts): void {
    const panel = panels.get('yaml')
    if (panel === undefined) return
    const note = editable ? 'The YAML a save would write. It changes as you edit, and is read-only here.' : 'The YAML a save would write. It is read-only here.'
    panel.replaceChildren(el('p', note, 'muted'), yamlBlock(drawn.yaml, `YAML of ${drawn.name}, read-only`))
  }

  /** The first node an issue names, by position, or null. */
  function nodeOfIssue(drawn: WorkflowFacts, issue: IssueFacts): number | null {
    if (issue.nodeId === null) return null
    const index = drawn.nodes.findIndex((node) => node.id === issue.nodeId)
    return index < 0 ? null : index
  }

  function drawIssues(drawn: WorkflowFacts): void {
    const count = drawn.issues.length
    const list = el('ul', undefined, 'issues')
    for (const issue of drawn.issues.slice(0, ISSUES_CAP)) {
      const where = issue.nodeId === null ? '' : ` (node ${issue.nodeId})`
      const text = `${issue.severity}: ${issue.message}${where}`
      const row = el('li', undefined, `issue issue-${issue.severity.toLowerCase()}`)
      const index = nodeOfIssue(drawn, issue)
      // An issue that names a node moves to it when chosen; the focus stays on the issue.
      if (index === null) row.textContent = text
      else
        row.appendChild(
          button(
            text,
            () => {
              select(index)
              choose('inspector')
            },
            'issue-link'
          )
        )
      list.appendChild(row)
    }
    const parts: HTMLElement[] = [el('h2', `Issues (${String(count)})`)]
    parts.push(count === 0 ? el('p', 'No issues found.', 'muted') : list)
    if (count > ISSUES_CAP) parts.push(el('p', `${String(count - ISSUES_CAP)} more issues are not shown.`, 'muted'))
    issuesStrip.replaceChildren(...parts)
  }

  /** Opens a read workflow for editing, in place of whatever copy was held. */
  function openView(view: Ready): void {
    shown = view
    openedText = JSON.stringify(view.definition)
    keptOver = ''
    closePrompt()
    editable = !view.header.viewOnly
    session = openSession(view.definition)
    connecting = null
    selectedEdge = null
    burst = null
    setMenu(false)
    canvasKey = ''
    outlineKey = ''
    fitNext = true
    if (session === null) {
      facts = null
      dropCanvas()
      content.replaceChildren(el('p', UNREADABLE_DEFINITION))
      return
    }
    if (selected !== null && selected >= session.workflow().nodes.length) selected = null
    redraw('all')
    if (content.children[0] !== layout) content.replaceChildren(layout)
  }

  /** Asks the person whether a read should replace the copy being edited. */
  function ask(view: Ready, sentence: string): void {
    waiting = view
    const take = button('Load the saved copy', () => {
      const next = waiting
      if (next !== null) openView(next)
    })
    const keep = button('Keep editing', () => {
      if (waiting !== null) keptOver = JSON.stringify(waiting.definition)
      closePrompt()
    })
    changePrompt.replaceChildren(el('p', sentence), take, keep)
    changePrompt.hidden = false
  }

  function closePrompt(): void {
    waiting = null
    changePrompt.replaceChildren()
    changePrompt.hidden = true
  }

  /** Whether the person has changes a read must not replace without asking. */
  const editing = (): boolean => session !== null && editable && session.dirty()

  /** Draws a read workflow. A copy with unsaved changes is never replaced without asking. */
  function drawReady(view: Ready, lines: string[], byPerson: boolean): void {
    drawHeader(view.header)
    setBanners(lines)
    drawEditState()
    const text = JSON.stringify(view.definition)
    if (editing()) {
      if (byPerson) ask(view, RELOAD_ASKED)
      else if (text !== openedText && text !== keptOver) ask(view, OUTSIDE_CHANGE)
      if (content.children[0] !== layout) content.replaceChildren(layout)
      return
    }
    if (session === null || text !== openedText || shown?.kind !== 'ready') {
      openView(view)
      return
    }
    shown = view
    if (content.children[0] !== layout) content.replaceChildren(layout)
  }

  function drawTooLarge(view: TooLarge, lines: string[]): void {
    shown = view
    session = null
    facts = null
    openedText = ''
    closePrompt()
    dropCanvas()
    drawHeader(view.header)
    setBanners(lines)
    const size = view.bytes === null ? `over ${mib(view.cap)}` : mib(view.bytes)
    content.replaceChildren(el('p', `This workflow's definition is ${size}. The builder opens definitions of at most ${mib(view.cap)}, so it does not open this one.`))
  }

  /** Draws what is shown again with banner lines over it. The copy being edited is kept as it is. */
  function drawShown(lines: string[]): void {
    if (shown === null) return
    if (shown.kind === 'ready') {
      drawHeader(shown.header)
      setBanners(lines)
      drawEditState()
    } else drawTooLarge(shown, lines)
  }

  function apply(answer: BuilderAnswer, byPerson: boolean): void {
    const tabConnection: TabConnection = answer.connection
    const { builder } = answer
    connected = tabConnection.kind === 'connected'
    if (tabConnection.kind === 'screen') {
      // The builder keeps what it shows under a banner; with nothing shown it draws the state screen.
      if (shown !== null) drawShown([tabConnection.screen.title])
      else drawScreen(tabConnection.screen)
      return
    }
    if (tabConnection.kind === 'searching') {
      if (shown !== null) drawShown([tabConnection.banner])
      else {
        drawHeader(null)
        setBanners([])
        content.replaceChildren(el('p', tabConnection.label, 'muted'))
      }
      return
    }
    switch (builder.kind) {
      case 'not-connected':
        if (shown !== null) drawShown([NOT_CONNECTED_BANNER])
        return
      case 'failed':
        if (shown !== null) drawShown([builder.message])
        else drawMessage(builder.message, true)
        return
      case 'gone':
        // Unsaved changes are kept under the sentence; with none, the workflow is let go.
        if (editing()) {
          drawShown([builder.message])
          return
        }
        shown = null
        session = null
        facts = null
        dropCanvas()
        drawMessage(builder.message, true)
        return
      case 'too-large':
        if (editing()) {
          drawShown([`This workflow's definition is now over ${mib(builder.cap)}. Your unsaved changes are kept.`])
          return
        }
        drawTooLarge(builder, [])
        return
      case 'ready':
        drawReady(builder, [], byPerson)
    }
  }

  /** Reads the workflow: one read in flight, and at most one more queued. */
  function load(): void {
    if (stopped || identity === null) return
    if (inFlight) {
      queued = true
      return
    }
    inFlight = true
    counter += 1
    const mine = counter
    const byPerson = asked
    asked = false
    const request = { ...identity, locale: ports.locale }
    void ports
      .request('builder.read', request)
      .then(
        (answer) => {
          if (!stopped && mine === counter && isAnswer(answer)) apply(answer, byPerson)
        },
        () => {
          if (stopped || mine !== counter) return
          if (shown !== null) drawShown([WORKER_UNANSWERED])
          else drawMessage(WORKER_UNANSWERED, true)
        }
      )
      .finally(() => {
        inFlight = false
        if (queued) {
          queued = false
          load()
        }
      })
  }

  // The tab's own keys. A key typed into a field is the field's, but for Esc, which ends connect mode.
  ports.app.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (connecting !== null) {
        event.preventDefault()
        cancelConnect()
      } else if (addButton.getAttribute('aria-expanded') === 'true') {
        event.preventDefault()
        setMenu(false)
      } else if (selectedEdge !== null) {
        event.preventDefault()
        select(null)
      }
      return
    }
    if (!editable || session === null || typedIntoField(event.target)) return
    const command = event.ctrlKey || event.metaKey
    if (command && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault()
      if (event.shiftKey) edit(() => session?.redo() ?? false, { keepSelection: true })
      else edit(() => session?.undo() ?? false, { keepSelection: true })
      return
    }
    if (command && !event.altKey && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault()
      edit(() => session?.redo() ?? false, { keepSelection: true })
      return
    }
    if (command || event.altKey) return
    if ((event.key === 'c' || event.key === 'C') && selected !== null) {
      event.preventDefault()
      toggleConnect()
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdge !== null) {
      const from = facts?.nodes[selectedEdge.from]
      const target = selectedEdge.to
      if (from === undefined) return
      event.preventDefault()
      edit(() => session?.removeDependency(target, from.id) ?? false)
    }
  })

  subscriptions.push(
    // A tab that has not yet found Archon reads again once the worker says the connection changed:
    // on a return to Connected it loads; in another state it draws that state's screen or banner.
    ports.on('connection.changed', (payload) => {
      const kind = isRecord(payload) ? payload.kind : undefined
      if (kind === 'connected' && connected) return
      load()
    })
  )

  void ports.readPointer().then((text) => {
    if (stopped) return
    identity = parseBuilderPointer(text)
    if (identity === null) content.replaceChildren(el('p', UNREADABLE_FILE))
    else load()
  })

  return {
    stop() {
      stopped = true
      canvas?.stop()
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
