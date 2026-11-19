// The builder tab (#16, #28): a wide editor tab on a `.orchonflow` pointer file. It reads the
// workflow's identity from the file, asks the worker for the workflow's authored form, and draws
// it in the layout of #28: the canvas, a docked issues strip at the bottom, and a right sidecar
// with the tabs Inspector, Outline and YAML. It is read-only for now: it never edits its file and
// holds no control that writes. Every piece of outside text is set through `textContent`.
import { createCanvas, type Canvas, type ObserveSize } from '../shared/canvas.ts'
import { elementMaker } from '../shared/dom.ts'
import { drawGraph, type DrawStep } from '../shared/graph-draw.ts'
import { layoutGraph, type Layout } from '../shared/graph-layout.ts'
import { isRecord } from '../shared/records.ts'
import type { TabConnection, TabScreen } from '../run-graph/graph-view.ts'
import type { TabTimers } from '../run-graph/refetch.ts'
import { mib, SCOPE_CAP, WORKFLOW_NAME_CAP, type BuilderAnswer, type BuilderHeader, type BuilderIdentity, type BuilderView } from './builder-view.ts'
import { workflowFacts, type NodeFacts, type WorkflowFacts } from './workflow-facts.ts'

/** The most nodes the canvas lays out, as the run graph (#17). Past it the outline carries on. */
export const CANVAS_CAP = 300
/** The most nodes the outline lists; past it a line says how many are not shown. */
export const OUTLINE_CAP = 2_000
/** The most issues the strip lists; past it a line says how many are not shown. */
export const ISSUES_CAP = 200
/** The most dependencies the inspector lists for one node; past it a line says how many are not shown. */
export const DEPENDS_CAP = 200

/** The cap a pointer file's project id is read under, as the worker allows; its name and scope use the contract's caps. */
const PROJECT_CAP = 200

export const UNREADABLE_FILE = 'Orchon could not read this file: it does not name a workflow.'
export const VIEW_ONLY_LINE = 'This workflow is installed, so it can only be viewed here.'
export const UNREADABLE_DEFINITION = "The builder could not read this workflow's definition."
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
  /** The tab sets no timer of its own today; it is given the frame's for the ones editing brings. */
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
type Shown = { view: Ready; facts: WorkflowFacts | null } | { view: Extract<BuilderView, { kind: 'too-large' }>; facts: null }
type SidecarTab = 'inspector' | 'outline' | 'yaml'
const SIDECAR_TABS: readonly { id: SidecarTab; name: string }[] = [
  { id: 'inspector', name: 'Inspector' },
  { id: 'outline', name: 'Outline' },
  { id: 'yaml', name: 'YAML' }
]

let tabs = 0

/** A size in MiB with one decimal, as a person reads it. */
/** A node's name as the tab shows it: its id, or `(no id)`. */
const nodeLabel = (node: NodeFacts): string => (node.id === '' ? '(no id)' : node.id)

export function startBuilderTab(ports: BuilderTabPorts): BuilderTab {
  const { doc } = ports
  const el = elementMaker(doc)
  const prefix = `builder-${String((tabs += 1))}`

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

  const top = el('header', undefined, 'tab-header')
  const banners = el('div', undefined, 'banners')
  banners.setAttribute('role', 'status')
  banners.setAttribute('aria-live', 'polite')
  const content = el('main', undefined, 'content builder-content')
  content.appendChild(el('p', 'Loading the workflow…', 'muted'))
  ports.app.replaceChildren(top, banners, content)

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

  let identity: BuilderIdentity | null = null
  let shown: Shown | null = null
  /** The definition last drawn, as JSON, so an answer that did not change it draws nothing again. */
  let drawnDefinition = ''
  let selected: number | null = null
  let canvas: Canvas | undefined
  let boxes = new Map<string, Element>()
  let outlineButtons: HTMLButtonElement[] = []
  /** Rises with each read; only the newest read's answer is drawn. */
  let counter = 0
  let inFlight = false
  let queued = false
  /** Whether the last answer found Archon: a post that it is found again reads once more. */
  let connected = false
  let stopped = false
  const subscriptions: { dispose(): void }[] = []

  /** Replaces the banners with these lines, or clears them. */
  function setBanners(lines: readonly string[]): void {
    banners.replaceChildren(...lines.map((line) => el('p', line, 'banner')))
  }

  /** Stops the canvas and lets it go, so the next draw makes a new one. */
  function dropCanvas(): void {
    canvas?.stop()
    canvas = undefined
  }

  function drawHeader(view: BuilderHeader | null): void {
    if (view === null) {
      top.replaceChildren()
      return
    }
    const parts: HTMLElement[] = [el('h1', view.name), el('p', `Source: ${view.source}`, 'meta'), el('p', `File: ${view.file}`, 'meta file')]
    if (view.viewOnly) parts.push(el('p', VIEW_ONLY_LINE, 'view-only'))
    const actions = el('p', undefined, 'actions')
    if (view.openYaml) actions.appendChild(button('Open YAML', openYaml))
    actions.appendChild(button('Reload', () => load()))
    parts.push(actions)
    top.replaceChildren(...parts)
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

  /** Marks the selected node on the canvas and in the outline. */
  function markSelected(): void {
    for (const [key, box] of boxes) box.setAttribute('aria-pressed', String(key === `n${String(selected)}`))
    outlineButtons.forEach((item, index) => item.setAttribute('aria-pressed', String(index === selected)))
  }

  function select(index: number | null): void {
    selected = index
    markSelected()
    if (shown?.facts != null) drawInspector(shown.facts)
  }

  /** The canvas, or the notice past the cap. Laid out once per definition. */
  function drawCanvas(facts: WorkflowFacts): void {
    if (facts.nodes.length > CANVAS_CAP) {
      dropCanvas()
      boxes = new Map()
      const notice = el('section', undefined, 'cap-notice')
      notice.append(
        el('h2', 'The canvas is not drawn'),
        el('p', `This workflow has ${String(facts.nodes.length)} nodes. The canvas draws at most ${String(CANVAS_CAP)}, so it gives way here. Every node is listed under Outline.`)
      )
      canvasPane.replaceChildren(notice)
      return
    }
    const label = `Nodes of ${facts.name === '' ? 'this workflow' : facts.name}`
    canvas ??= createCanvas({
      doc,
      label,
      idPrefix: prefix,
      onStep: (key) => {
        const index = Number(key.slice(1))
        if (!Number.isInteger(index)) return
        select(index)
        choose('inspector')
      },
      ...(ports.observeSize === undefined ? {} : { observeSize: ports.observeSize })
    })
    canvas.viewport.setAttribute('aria-label', label)
    const keys = facts.nodes.map((_, index) => `n${String(index)}`)
    const laid: Layout = layoutGraph(
      facts.nodes.map((node, index) => ({ id: keys[index] ?? '', group: null, isGroup: false, conditional: node.conditional })),
      facts.edges.map((edge) => ({ from: keys[edge.from] ?? '', to: keys[edge.to] ?? '' })),
      'TB'
    )
    const steps = new Map<string, DrawStep>()
    facts.nodes.forEach((node, index) => {
      steps.set(keys[index] ?? '', { name: nodeLabel(node), kind: node.kind, state: 'draft', stateText: node.kind, note: null, readOnly: node.readOnly })
    })
    const svg = drawGraph(doc, laid, steps, { label, idPrefix: prefix })
    boxes = new Map()
    const visit = (element: Element): void => {
      const key = element.getAttribute('data-step')
      if (key !== null) boxes.set(key, element)
      for (const child of Array.from(element.children)) visit(child)
    }
    visit(svg)
    canvas.show(svg, laid, new Map(keys.map((key) => [key, 'draft'])), { fit: true })
    canvasPane.replaceChildren(canvas.root)
  }

  function drawOutline(facts: WorkflowFacts): void {
    const panel = panels.get('outline')
    if (panel === undefined) return
    const count = facts.nodes.length
    const list = el('ul', undefined, 'outline')
    list.setAttribute('aria-label', 'Nodes')
    outlineButtons = facts.nodes.slice(0, OUTLINE_CAP).map((node, index) => {
      const item = button('', () => select(index), 'outline-node')
      item.setAttribute('aria-label', `${nodeLabel(node)}, ${node.kind}${node.readOnly ? ', read-only' : ''}`)
      item.append(el('span', nodeLabel(node), 'outline-id'), el('span', node.kind, 'outline-kind'))
      if (node.readOnly) item.appendChild(el('span', 'ro', 'badge ro'))
      const row = el('li')
      row.appendChild(item)
      list.appendChild(row)
      return item
    })
    const parts: HTMLElement[] = [el('p', `${String(count)} ${count === 1 ? 'node' : 'nodes'}`, 'muted'), list]
    if (count > OUTLINE_CAP) parts.push(el('p', `${String(count - OUTLINE_CAP)} more nodes are not shown.`, 'muted'))
    panel.replaceChildren(...parts)
  }

  function yamlBlock(text: string, label: string): HTMLPreElement {
    const block = el('pre', text, 'yaml')
    block.setAttribute('aria-label', label)
    block.setAttribute('tabindex', '0')
    return block
  }

  function drawInspector(facts: WorkflowFacts): void {
    const panel = panels.get('inspector')
    if (panel === undefined) return
    const node: NodeFacts | undefined = selected === null ? undefined : facts.nodes[selected]
    if (node === undefined) {
      const parts: HTMLElement[] = [el('h2', facts.name === '' ? 'This workflow' : facts.name)]
      if (facts.description !== '') parts.push(el('p', facts.description))
      if (facts.settingsYaml !== '') parts.push(el('h3', 'Workflow settings'), yamlBlock(facts.settingsYaml, 'Workflow settings, read-only'))
      parts.push(el('p', PICK_A_NODE, 'muted'))
      panel.replaceChildren(...parts)
      return
    }
    const name = nodeLabel(node)
    const parts: HTMLElement[] = [el('h2', name), el('p', `Kind: ${node.kind}`)]
    if (node.readOnly) parts.push(el('p', `🔒 Read-only. ${node.reason ?? ''} It is saved unchanged.`, 'banner read-only-banner'))
    parts.push(el('h3', 'Depends on'))
    if (node.dependsOn.length === 0) parts.push(el('p', 'Nothing.', 'muted'))
    else {
      const list = el('ul')
      for (const id of node.dependsOn.slice(0, DEPENDS_CAP)) list.appendChild(el('li', id))
      parts.push(list)
      const more = node.dependsOn.length - DEPENDS_CAP
      if (more > 0) parts.push(el('p', `${String(more)} more ${more === 1 ? 'dependency is' : 'dependencies are'} not shown.`, 'muted'))
    }
    if (node.notEditable.length > 0) {
      const group = el('section', undefined, 'not-editable')
      const fields = el('ul')
      for (const field of node.notEditable) fields.appendChild(el('li', field))
      group.append(el('h3', 'Not editable here'), fields, el('p', 'These fields are kept and saved unchanged.', 'muted'))
      parts.push(group)
    }
    parts.push(el('h3', 'YAML'), yamlBlock(node.yaml, `YAML of ${name}, read-only`))
    panel.replaceChildren(...parts)
  }

  function drawYaml(facts: WorkflowFacts): void {
    const panel = panels.get('yaml')
    if (panel === undefined) return
    panel.replaceChildren(el('p', 'The YAML a save would write. It is read-only here.', 'muted'), yamlBlock(facts.yaml, `YAML of ${facts.name}, read-only`))
  }

  function drawIssues(facts: WorkflowFacts): void {
    const count = facts.issues.length
    const list = el('ul', undefined, 'issues')
    for (const issue of facts.issues.slice(0, ISSUES_CAP)) {
      const where = issue.nodeId === null ? '' : ` (node ${issue.nodeId})`
      list.appendChild(el('li', `${issue.severity}: ${issue.message}${where}`, `issue issue-${issue.severity.toLowerCase()}`))
    }
    const parts: HTMLElement[] = [el('h2', `Issues (${String(count)})`)]
    parts.push(count === 0 ? el('p', 'No issues found.', 'muted') : list)
    if (count > ISSUES_CAP) parts.push(el('p', `${String(count - ISSUES_CAP)} more issues are not shown.`, 'muted'))
    issuesStrip.replaceChildren(...parts)
  }

  /** Draws a read workflow. Nothing is read or laid out again while the definition is unchanged. */
  function drawReady(view: Ready, lines: string[]): void {
    drawHeader(view.header)
    setBanners(lines)
    const text = JSON.stringify(view.definition)
    if (text !== drawnDefinition || shown?.view.kind !== 'ready') {
      drawnDefinition = text
      const facts = workflowFacts(view.definition)
      shown = { view, facts }
      if (facts === null) {
        dropCanvas()
        content.replaceChildren(el('p', UNREADABLE_DEFINITION))
        return
      }
      if (selected !== null && selected >= facts.nodes.length) selected = null
      drawCanvas(facts)
      drawOutline(facts)
      drawInspector(facts)
      drawYaml(facts)
      drawIssues(facts)
      markSelected()
    } else shown = { view, facts: shown.facts }
    if (shown.facts !== null && content.children[0] !== layout) content.replaceChildren(layout)
  }

  function drawTooLarge(view: Extract<BuilderView, { kind: 'too-large' }>, lines: string[]): void {
    shown = { view, facts: null }
    drawnDefinition = ''
    drawHeader(view.header)
    setBanners(lines)
    const size = view.bytes === null ? `over ${mib(view.cap)}` : mib(view.bytes)
    content.replaceChildren(el('p', `This workflow's definition is ${size}. The builder opens definitions of at most ${mib(view.cap)}, so it does not open this one.`))
  }

  /** Draws what is shown again with banner lines over it. */
  function drawShown(lines: string[]): void {
    if (shown === null) return
    if (shown.view.kind === 'ready') drawReady(shown.view, lines)
    else drawTooLarge(shown.view, lines)
  }

  function apply(answer: BuilderAnswer): void {
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
        shown = null
        drawnDefinition = ''
        dropCanvas()
        drawMessage(builder.message, true)
        return
      case 'too-large':
        drawTooLarge(builder, [])
        return
      case 'ready':
        drawReady(builder, [])
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
    const request = { ...identity, locale: ports.locale }
    void ports
      .request('builder.read', request)
      .then(
        (answer) => {
          if (!stopped && mine === counter && isAnswer(answer)) apply(answer)
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
