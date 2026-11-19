import { applyField } from "./node-form.js";
/** A choice in a select. */
export function option(el, value, text) {
    const made = el('option', text);
    made.value = value;
    made.setAttribute('value', value);
    return made;
}
function textInput(el, numeric) {
    const input = el('input', undefined, 'field-input');
    input.type = 'text';
    if (numeric)
        input.setAttribute('inputmode', 'numeric');
    return input;
}
function textArea(el, rows) {
    const area = el('textarea', undefined, 'field-input');
    area.rows = rows;
    return area;
}
/** The control each kind of input is edited with. A new kind of input is added here and in `node-form.ts`. */
const CONTROLS = {
    text: (el) => textInput(el, false),
    number: (el) => textInput(el, true),
    textarea: (el) => textArea(el, 5),
    lines: (el) => textArea(el, 3),
    checkbox(el) {
        const input = el('input');
        input.type = 'checkbox';
        return input;
    },
    select(el, field) {
        const select = el('select', undefined, 'field-input');
        for (const choice of field.options ?? [])
            select.appendChild(option(el, choice.value, choice.label));
        return select;
    }
};
/**
 * The field's label, control and error line. A value the field cannot hold is not set: the control
 * is marked invalid and the error line says why. The control carries `data-focus`, so the focus can
 * be put back on it when the inspector is drawn again.
 */
export function fieldControl(field, ports) {
    const { el, id } = ports;
    const ticked = field.input === 'checkbox';
    const wrap = el('div', undefined, ticked ? 'field check' : 'field');
    const label = el('label', field.label);
    label.setAttribute('for', id);
    const error = el('p', '', 'field-error');
    error.id = `${id}-error`;
    const control = CONTROLS[field.input](el, field);
    control.id = id;
    control.setAttribute('data-focus', `field:${field.key}`);
    if (ticked)
        control.checked = field.value === true;
    else
        control.value = typeof field.value === 'string' ? field.value : '';
    const set = (typing) => {
        const held = ports.held();
        if (held === undefined)
            return;
        const raw = ticked ? control.checked : control.value;
        const applied = applyField(held, field, raw);
        if (!applied.ok) {
            control.setAttribute('aria-invalid', 'true');
            control.setAttribute('aria-describedby', error.id);
            error.textContent = applied.error;
            return;
        }
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-describedby');
        error.textContent = '';
        ports.set(applied.node, typing);
    };
    if (ticked || field.input === 'select')
        control.addEventListener('change', () => set(false));
    else {
        control.addEventListener('input', () => set(true));
        control.addEventListener('change', () => ports.settled());
    }
    if (ticked)
        wrap.append(control, label, error);
    else
        wrap.append(label, control, error);
    return wrap;
}
