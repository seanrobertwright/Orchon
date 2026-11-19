// Whether two definitions mean the same workflow: the outside-change check of a save (#16) and
// the tab's reads compare what Archon serves with the copy the builder opened by this, not by
// text, so keys that come back in another order are no change. Lists keep their order; a key
// more or less, another value or another type is a change. It lives beside the tab because the
// editors import nothing from src/; the worker imports it from here.

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether two JSON values are the same, records compared without regard to key order. */
export function sameDefinition(first: unknown, second: unknown): boolean {
  if (first === second) return true
  if (Array.isArray(first)) {
    if (!Array.isArray(second) || first.length !== second.length) return false
    return first.every((item, index) => sameDefinition(item, (second as unknown[])[index]))
  }
  if (!isPlainRecord(first) || !isPlainRecord(second)) return false
  const keys = Object.keys(first)
  if (keys.length !== Object.keys(second).length) return false
  return keys.every((key) => Object.hasOwn(second, key) && sameDefinition(first[key], second[key]))
}
