// The inspector's form for a node (#16, #28): which fields it edits for each node kind, with a
// label each, and how a value typed into one is read and set on the node. A field is named by
// the key a save writes, a field inside `loop`, `approval` or `wait` by its path, such as
// `loop.prompt`. Setting a field changes that field alone: every other field of the node, the
// ones the builder does not recognise included, is carried over as it was. It is pure.
import { WIRE_KEY_ROLES } from "./archon/types/index.js";
/** Says a whole number is wanted, for a number field that does not hold one. */
export const WHOLE_NUMBER = 'Enter a whole number, 0 or more.';
const NOT_A_CHOICE = 'Choose one of the listed values.';
const NOT_SET = { value: '', label: '(not set)' };
const TRIGGER_RULES = ['all_success', 'one_success', 'none_failed_min_one_success', 'all_done'].map((value) => ({ value, label: value }));
const RUNTIMES = [
    { value: 'bun', label: 'bun' },
    { value: 'uv', label: 'uv' }
];
/** What a wait waits for, each with the keys it writes and its value when chosen. */
const WAIT_MODES = [
    { value: 'duration_ms', label: 'A length of time', start: { duration_ms: 60_000 } },
    { value: 'until', label: 'A moment in time', start: { until: '' } },
    { value: 'event', label: 'An event', start: { event: '', deadline_ms: 60_000 } },
    { value: 'attention', label: 'A person', start: { attention: '' } }
];
const WAIT_MODE_KEYS = ['duration_ms', 'until', 'event', 'deadline_ms', 'attention'];
const text = (key, label, required = false) => ({ key, label, input: 'text', required });
const area = (key, label, required = false) => ({ key, label, input: 'textarea', required });
const whole = (key, label, required = false) => ({ key, label, input: 'number', required });
const tick = (key, label) => ({ key, label, input: 'checkbox', required: false });
/** The fields every node has, a read-only one included. The dependencies are edited in their own list. */
const SHARED = [
    text('description', 'Description'),
    text('when', 'Runs when'),
    { key: 'trigger_rule', label: 'Trigger rule', input: 'select', options: [NOT_SET, ...TRIGGER_RULES], required: false },
    text('output_type', 'Output type')
];
/** The fields of a node kind that calls a provider. `model` only while it is one string. */
const ai = (node) => [
    text('provider', 'Provider'),
    ...(Array.isArray(node.base.model) ? [] : [text('model', 'Model')]),
    tick('persist_session', 'Keep the session for later nodes')
];
/** Which keys a wait carries decide what it waits for; one with none of them is edited as a length of time. */
function waitMode(data) {
    return WAIT_MODES.find((mode) => Object.hasOwn(data, mode.value))?.value ?? 'duration_ms';
}
function waitFields(data) {
    const mode = waitMode(data);
    const chooser = { key: 'wait.mode', label: 'Wait for', input: 'select', options: WAIT_MODES.map(({ value, label }) => ({ value, label })), required: true };
    switch (mode) {
        case 'until':
            return [chooser, text('wait.until', 'Until (a UTC time, such as 2026-01-31T09:00:00Z)', true)];
        case 'event':
            return [chooser, text('wait.event', 'Event', true), whole('wait.deadline_ms', 'Deadline (ms)', true)];
        case 'attention':
            return [chooser, area('wait.attention', 'Question for the person', true)];
        default:
            return [chooser, whole('wait.duration_ms', 'Duration (ms)', true)];
    }
}
function kindFields(node) {
    switch (node.variant) {
        case 'opaque':
            return [];
        case 'prompt':
            return [area('prompt', 'Prompt', true), ...ai(node)];
        case 'command':
            return [text('command', 'Command', true), ...ai(node)];
        case 'bash':
            return [area('bash', 'Bash script', true), whole('timeout', 'Timeout (ms)')];
        case 'script':
            return [
                area('script', 'Script', true),
                { key: 'runtime', label: 'Runtime', input: 'select', options: RUNTIMES, required: true },
                { key: 'deps', label: 'Dependencies, one per line', input: 'lines', required: false },
                whole('timeout', 'Timeout (ms)')
            ];
        case 'loop':
            return [
                node.data.command === undefined ? area('loop.prompt', 'Prompt for each iteration', true) : text('loop.command', 'Command for each iteration', true),
                whole('loop.max_iterations', 'Most iterations', true),
                text('loop.until', 'Until (the signal that ends the loop)'),
                text('loop.until_bash', 'Until (a bash check, exit 0 ends the loop)'),
                text('loop.until_field', 'Until (an output field that ends the loop)'),
                tick('loop.fresh_context', 'Fresh context each iteration'),
                tick('loop.interactive', 'Ask a person between iterations'),
                text('loop.gate_message', 'Message to the person'),
                whole('timeout', 'Timeout (ms)'),
                ...ai(node)
            ];
        case 'approval':
            return [
                area('approval.message', 'Message', true),
                tick('approval.capture_response', "Keep the person's response"),
                area('approval.on_reject.prompt', 'On reject, the prompt to run'),
                whole('approval.on_reject.max_attempts', 'On reject, most attempts')
            ];
        case 'wait':
            return waitFields(node.data);
        case 'cancel':
            return [area('cancel', 'Reason', true)];
    }
}
const BASE_KEYS = new Set(Object.entries(WIRE_KEY_ROLES).filter(([, role]) => role === 'base').map(([key]) => key));
/** Where a field lives on a node: in its shared fields or its kind's data, and the path inside. */
function locate(node, key) {
    if (BASE_KEYS.has(key))
        return { where: 'base', path: [key] };
    if (node.variant === 'cancel' && key === 'cancel')
        return { where: 'data', path: ['reason'] };
    const [outer, ...inner] = key.split('.');
    if ((node.variant === 'loop' || node.variant === 'approval' || node.variant === 'wait') && outer === node.variant && inner.length > 0)
        return { where: 'data', path: inner };
    return { where: 'data', path: [key] };
}
const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function read(record, path) {
    let at = record;
    for (const part of path) {
        if (!isPlain(at) || !Object.hasOwn(at, part))
            return undefined;
        at = at[part];
    }
    return at;
}
/** `record` with the value at `path` set, or removed when `value` is undefined. An object left empty by a removal is removed too. */
function written(record, path, value) {
    const [head, ...rest] = path;
    if (head === undefined)
        return record;
    if (rest.length === 0) {
        if (value === undefined) {
            const { [head]: _gone, ...kept } = record;
            return kept;
        }
        return { ...record, [head]: value };
    }
    const inner = isPlain(record[head]) ? record[head] : {};
    const next = written(inner, rest, value);
    if (Object.keys(next).length === 0) {
        const { [head]: _gone, ...kept } = record;
        return kept;
    }
    return { ...record, [head]: next };
}
function shown(node, spec) {
    if (spec.key === 'wait.mode')
        return waitMode(node.data);
    const { where, path } = locate(node, spec.key);
    const value = read((where === 'base' ? node.base : node.data), path);
    switch (spec.input) {
        case 'checkbox':
            return value === true;
        case 'number':
            return typeof value === 'number' ? String(value) : '';
        case 'lines':
            return Array.isArray(value) ? value.filter((item) => typeof item === 'string').join('\n') : '';
        default:
            return typeof value === 'string' ? value : '';
    }
}
/** The fields the inspector shows for a node, with the values it holds. A read-only node has the shared fields alone. */
export function formFields(node) {
    return [...kindFields(node), ...SHARED].map((spec) => ({ ...spec, value: shown(node, spec) }));
}
/** The value a field's input holds, read as the node holds it; undefined removes the field. */
function parsed(field, raw) {
    if (field.input === 'checkbox')
        return { ok: true, value: raw === true ? true : undefined };
    const typed = typeof raw === 'string' ? raw : '';
    switch (field.input) {
        case 'number': {
            const trimmed = typed.trim();
            if (trimmed === '')
                return field.required ? { ok: false, error: WHOLE_NUMBER } : { ok: true, value: undefined };
            if (!/^\d+$/.test(trimmed))
                return { ok: false, error: WHOLE_NUMBER };
            const value = Number(trimmed);
            return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, error: WHOLE_NUMBER };
        }
        case 'lines': {
            const items = typed
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line !== '');
            return { ok: true, value: items.length === 0 ? undefined : items };
        }
        case 'select': {
            if (typed === '' && !field.required)
                return { ok: true, value: undefined };
            return field.options?.some((option) => option.value === typed) === true ? { ok: true, value: typed } : { ok: false, error: NOT_A_CHOICE };
        }
        default:
            return { ok: true, value: typed === '' && !field.required ? undefined : typed };
    }
}
/**
 * The node with one field set from what its input holds, every other field as it was. A value the
 * field cannot hold, such as a number field holding letters, is refused with a sentence that says why.
 */
export function applyField(node, field, raw) {
    const value = parsed(field, raw);
    if (!value.ok)
        return value;
    if (field.key === 'wait.mode') {
        const mode = WAIT_MODES.find((candidate) => candidate.value === value.value);
        if (mode === undefined || node.variant !== 'wait')
            return { ok: false, error: NOT_A_CHOICE };
        const data = node.data;
        if (waitMode(data) === mode.value)
            return { ok: true, node };
        const kept = Object.fromEntries(Object.entries(data).filter(([key]) => !WAIT_MODE_KEYS.includes(key)));
        return { ok: true, node: { ...node, data: { ...mode.start, ...kept } } };
    }
    const { where, path } = locate(node, field.key);
    if (where === 'base')
        return { ok: true, node: { ...node, base: written(node.base, path, value.value) } };
    return { ok: true, node: { ...node, data: written(node.data, path, value.value) } };
}
