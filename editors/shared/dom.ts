// The element factory the editors share. Outside text is set through `textContent` only.

/** Makes an element, with its text and its class when given. */
export type MakeElement = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => HTMLElementTagNameMap[K]

/** The element factory for one document. */
export function elementMaker(doc: Document): MakeElement {
  return (tag, text, className) => {
    const element = doc.createElement(tag)
    if (text !== undefined) element.textContent = text
    if (className !== undefined) element.setAttribute('class', className)
    return element
  }
}
