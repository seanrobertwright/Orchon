// Plain objects in values whose shape nothing promises, such as a parsed JSON answer.

/** Whether a value is a plain object: not null and not a list. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A field of its own on a record, or undefined when the record does not have it. */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
