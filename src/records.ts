// Plain objects in values whose shape nothing promises, such as a parsed JSON answer.

/** Whether a value is a plain object: not null and not a list. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
