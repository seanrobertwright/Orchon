/**
 * Word scalars a YAML parser may re-type, matched case-insensitively. Includes
 * the YAML 1.1 boolean spellings (yes/no/on/off) so the output stays a string
 * under either schema.
 */
const AMBIGUOUS_WORDS = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off', 'nan']);
/**
 * Number-like spellings YAML re-types: plain ints/floats, scientific notation
 * (1e5), hex (0x1A), octal (0o17), and infinity/NaN (.inf/.nan), with an
 * optional sign. Multi-dot strings like 1.2.3 are NOT numbers and stay plain.
 */
const NUMERIC_LIKE = /^[+-]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.(?:inf|nan))$/i;
/** Scalars that must be quoted to avoid being re-parsed as a different type. */
function quoteIfAmbiguous(value) {
    if (value === '' ||
        AMBIGUOUS_WORDS.has(value.toLowerCase()) ||
        NUMERIC_LIKE.test(value) ||
        value.includes(':') ||
        value.includes('#') ||
        value.includes('"') ||
        value.includes("'") ||
        value.startsWith('{') ||
        value.startsWith('[') ||
        value.startsWith('&') ||
        value.startsWith('*') ||
        value.startsWith('-') ||
        value.startsWith('+') ||
        value.startsWith('?') ||
        value.startsWith('!') ||
        value.startsWith('%') ||
        value.startsWith('@') ||
        value.startsWith('`') ||
        value !== value.trim()) {
        return JSON.stringify(value);
    }
    return value;
}
/** Serialize one value. `indent` is the column of the key the value follows. */
function serializeValue(value, indent) {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'string') {
        // Multi-line strings use a literal block scalar.
        if (value.includes('\n')) {
            const pad = ' '.repeat(indent + 2);
            return ('|\n' +
                value
                    .split('\n')
                    .map(line => pad + line)
                    .join('\n'));
        }
        return quoteIfAmbiguous(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0)
            return '[]';
        const pad = ' '.repeat(indent + 2);
        return '\n' + value.map(v => pad + '- ' + serializeValue(v, indent + 4)).join('\n');
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (entries.length === 0)
            return '{}';
        const pad = ' '.repeat(indent + 2);
        return '\n' + entries.map(([k, v]) => keyLine(pad, k, v, indent + 2)).join('\n');
    }
    // Unreachable for wire-definition input (all shapes handled above).
    return JSON.stringify(value);
}
/**
 * Render `key: value` after `prefix`, omitting the space when the value
 * renders as an indented block (which begins with its own newline) so no
 * line carries trailing whitespace.
 */
function keyLine(prefix, key, value, indent) {
    const rendered = serializeValue(value, indent);
    return rendered.startsWith('\n') ? prefix + key + ':' + rendered : prefix + key + ': ' + rendered;
}
/** Node keys render `id` first, then the author's field order. */
function nodeKeyOrder(node) {
    const keys = Object.keys(node).filter(k => k !== 'id');
    return ['id', ...keys];
}
/** Serialize one node as a `- ` list item at the given indent. */
function serializeNode(node, indent) {
    const record = node;
    const pad = ' '.repeat(indent);
    const lines = [];
    let first = true;
    for (const key of nodeKeyOrder(node)) {
        const value = record[key];
        if (value === undefined)
            continue;
        const prefix = first ? pad + '- ' : pad + '  ';
        lines.push(keyLine(prefix, key, value, indent + 2));
        first = false;
    }
    return lines.join('\n');
}
/** Convert a wire workflow definition into the YAML preview string. */
export function serializeToYaml(def) {
    const { name, description, nodes, ...meta } = def;
    const lines = [];
    lines.push(keyLine('', 'name', name, 0));
    if (description !== undefined && description !== '') {
        lines.push(keyLine('', 'description', description, 0));
    }
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined)
            continue;
        lines.push(keyLine('', key, value, 0));
    }
    lines.push('');
    lines.push('nodes:');
    for (const node of nodes) {
        lines.push(serializeNode(node, 2));
    }
    return lines.join('\n') + '\n';
}
