/**
 * `{ [key]: value }` when `value` is defined, `{}` otherwise — for building
 * sparse object literals via spread without repeating the
 * `...(x !== undefined ? { key: x } : {})` ternary at every call site.
 */
export function ifDefined(key, value) {
    return value !== undefined ? { [key]: value } : {};
}
