// One labelled field of the inspector's form (#16, #28): the control each kind of input is edited
// with, and what it does as the person edits it. `node-form.ts` says which fields a node has and
// how a value is read; this file makes the control for one of them. Outside text is set through
// `textContent`.
import type { MakeElement } from '../shared/dom.ts'
import type { BuilderNode } from './archon/types/index.ts'
import { applyField, type FieldInput, type FormField } from './node-form.ts'

export type FieldPorts = {
  el: MakeElement
  /** An id unique in the document, for the control. */
  id: string
  /** The node the field is on, as it now stands, or undefined once it is gone. */
  held(): BuilderNode | undefined
  /** Sets the node with the field's new value. `typing` is true while the person types into the field. */
  set(node: BuilderNode, typing: boolean): void
  /** The person has left a field they typed into, so the next edit is a new undo step. */
  settled(): void
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

/** A choice in a select. */
export function option(el: MakeElement, value: string, text: string): HTMLOptionElement {
  const made = el('option', text)
  made.value = value
  made.setAttribute('value', value)
  return made
}

function textInput(el: MakeElement, numeric: boolean): HTMLInputElement {
  const input = el('input', undefined, 'field-input')
  input.type = 'text'
  if (numeric) input.setAttribute('inputmode', 'numeric')
  return input
}

function textArea(el: MakeElement, rows: number): HTMLTextAreaElement {
  const area = el('textarea', undefined, 'field-input')
  area.rows = rows
  return area
}

/** The control each kind of input is edited with. A new kind of input is added here and in `node-form.ts`. */
const CONTROLS: Record<FieldInput, (el: MakeElement, field: FormField) => Control> = {
  text: (el) => textInput(el, false),
  number: (el) => textInput(el, true),
  textarea: (el) => textArea(el, 5),
  lines: (el) => textArea(el, 3),
  checkbox(el) {
    const input = el('input')
    input.type = 'checkbox'
    return input
  },
  select(el, field) {
    const select = el('select', undefined, 'field-input')
    for (const choice of field.options ?? []) select.appendChild(option(el, choice.value, choice.label))
    return select
  }
}

/**
 * The field's label, control and error line. A value the field cannot hold is not set: the control
 * is marked invalid and the error line says why. The control carries `data-focus`, so the focus can
 * be put back on it when the inspector is drawn again.
 */
export function fieldControl(field: FormField, ports: FieldPorts): HTMLElement {
  const { el, id } = ports
  const ticked = field.input === 'checkbox'
  const wrap = el('div', undefined, ticked ? 'field check' : 'field')
  const label = el('label', field.label)
  label.setAttribute('for', id)
  const error = el('p', '', 'field-error')
  error.id = `${id}-error`
  const control = CONTROLS[field.input](el, field)
  control.id = id
  control.setAttribute('data-focus', `field:${field.key}`)
  if (ticked) (control as HTMLInputElement).checked = field.value === true
  else control.value = typeof field.value === 'string' ? field.value : ''

  const set = (typing: boolean): void => {
    const held = ports.held()
    if (held === undefined) return
    const raw = ticked ? (control as HTMLInputElement).checked : control.value
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
    ports.set(applied.node, typing)
  }
  if (ticked || field.input === 'select') control.addEventListener('change', () => set(false))
  else {
    control.addEventListener('input', () => set(true))
    control.addEventListener('change', () => ports.settled())
  }
  if (ticked) wrap.append(control, label, error)
  else wrap.append(label, control, error)
  return wrap
}
