// A small stand-in for the browser DOM, for the editor tests: `orca plugin test` runs in plain
// Node, which has none. It holds what the editors use and no more: elements in a tree with
// attributes, text set through `textContent`, listeners, events that bubble to the root, and the
// element with focus. A test reads what was drawn through the helpers below. It is development
// tooling: Orca never loads it.

type Listener = (event: FakeEvent) => void

/** What a test may set on an event: a key, a pointer's place and button, a wheel's turn. */
export type EventFields = {
  key?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  clientX?: number
  clientY?: number
  button?: number
  pointerId?: number
  deltaY?: number
}

export type FakeEvent = EventFields & {
  type: string
  /** The element the event was delivered to first. */
  target: FakeElement
  preventDefault(): void
  defaultPrevented: boolean
  stopPropagation(): void
}

/** The element with focus in each stand-in document, by the document's root. */
const focused = new WeakMap<FakeElement, FakeElement>()

export class FakeElement {
  readonly tagName: string
  readonly namespaceURI: string | null
  readonly children: FakeElement[] = []
  parentElement: FakeElement | null = null
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Listener[]>()
  /** The element's own text, when it holds text and no elements. */
  private text = ''
  /** Whether `innerHTML` or another way of writing markup was used. Editors never do. */
  markupWritten = false
  /** A radio's or checkbox's state. */
  checked = false
  /** What an input, a text area or a select holds. */
  value = ''

  constructor(tagName: string, namespaceURI: string | null) {
    this.tagName = tagName
    this.namespaceURI = namespaceURI
  }

  get textContent(): string {
    return this.children.length === 0 ? this.text : this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string | null) {
    for (const child of this.children) child.parentElement = null
    this.children.length = 0
    this.text = value ?? ''
  }

  set innerHTML(_value: string) {
    this.markupWritten = true
  }

  get id(): string {
    return this.getAttribute('id') ?? ''
  }

  set id(value: string) {
    this.setAttribute('id', value)
  }

  get hidden(): boolean {
    return this.attributes.has('hidden')
  }

  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '')
    else this.attributes.delete('hidden')
  }

  get disabled(): boolean {
    return this.attributes.has('disabled')
  }

  set disabled(value: boolean) {
    if (value) this.attributes.set('disabled', '')
    else this.attributes.delete('disabled')
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentElement?.removeChild(child)
    this.text = ''
    this.children.push(child)
    child.parentElement = this
    return child
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = new FakeElement('#text', null)
        text.textContent = node
        this.appendChild(text)
      } else {
        this.appendChild(node)
      }
    }
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentElement = null
    return child
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.textContent = ''
    this.append(...nodes)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((held) => held !== listener)
    )
  }

  /** Delivers an event to this element's listeners and then to each ancestor's, as a press or a key would. */
  dispatch(type: string, fields: EventFields = {}): FakeEvent {
    let stopped = false
    const event: FakeEvent = {
      type,
      ...fields,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true
      },
      stopPropagation() {
        stopped = true
      }
    }
    for (const at of [this, ...this.ancestors()]) {
      if (stopped) break
      for (const listener of at.listeners.get(type) ?? []) listener(event)
    }
    return event
  }

  /** The root of the tree that holds this element. */
  private root(): FakeElement {
    return this.ancestors().at(-1) ?? this
  }

  /** The element's parent, its parent's parent and so on, nearest first. */
  private ancestors(): FakeElement[] {
    const found: FakeElement[] = []
    for (let at = this.parentElement; at !== null; at = at.parentElement) found.push(at)
    return found
  }

  /** Gives this element focus within its document. */
  focus(): void {
    focused.set(this.root(), this)
  }

  /** Whether this element has focus within its document. */
  get hasFocus(): boolean {
    return focused.get(this.root()) === this
  }

  contains(other: FakeElement | null): boolean {
    for (let at = other; at !== null; at = at.parentElement) if (at === this) return true
    return false
  }

  /** A stand-in document lays nothing out: every element sits at the origin with no size. */
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 0, height: 0 }
  }

  click(): void {
    this.dispatch('click')
  }
}

export type FakeDocument = {
  documentElement: FakeElement
  /** The element with focus, or the body. */
  readonly activeElement: FakeElement
  body: FakeElement
  createElement(tagName: string): FakeElement
  createElementNS(namespaceURI: string, tagName: string): FakeElement
  getElementById(id: string): FakeElement | null
}

/** A document with an empty body, and the `#app` element the editors draw into. */
export function fakeDocument(): FakeDocument {
  const documentElement = new FakeElement('html', null)
  const body = documentElement.appendChild(new FakeElement('body', null))
  const app = body.appendChild(new FakeElement('div', null))
  app.id = 'app'
  return {
    documentElement,
    get activeElement() {
      return focused.get(documentElement) ?? body
    },
    body,
    createElement: (tagName) => new FakeElement(tagName.toLowerCase(), null),
    createElementNS: (namespaceURI, tagName) => new FakeElement(tagName, namespaceURI),
    getElementById: (id) => find(documentElement, (element) => element.id === id)
  }
}

/** Every element under `root`, `root` included, in document order. */
export function walk(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(walk)]
}

export const findAll = (root: FakeElement, match: (element: FakeElement) => boolean): FakeElement[] => walk(root).filter(match)

export const find = (root: FakeElement, match: (element: FakeElement) => boolean): FakeElement | null => walk(root).find(match) ?? null

/** The elements that carry a class among their `class` attribute's words. */
export const withClass = (root: FakeElement, name: string): FakeElement[] =>
  findAll(root, (element) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name))

/** Whether anything under `root` was written as markup rather than text. */
export const markupWritten = (root: FakeElement): boolean => walk(root).some((element) => element.markupWritten)
