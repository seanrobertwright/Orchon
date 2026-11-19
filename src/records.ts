// Plain objects in values whose shape nothing promises, such as a parsed JSON answer.

/** Whether a value is a plain object: not null and not a list. */
/** Refuses a frame's request: Orca answers the frame with `invalid_params` and this message. */
export function refuseRequest(message: string): never {
  throw Object.assign(new Error(message), { code: 'invalid_params' })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A field of its own on a record, or undefined when the record does not have it. */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
