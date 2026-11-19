// Reading values whose shape nothing promises, such as a parsed JSON message, in the editors.
/** Whether a value is a plain object: not null and not a list. */
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** A field of its own on a record, or undefined when the record does not have it. */
export function own(record, key) {
    return Object.hasOwn(record, key) ? record[key] : undefined;
}
