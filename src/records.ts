// Values whose shape nothing promises, such as a parsed JSON answer or a thrown error.

/** Refuses a frame's request: Orca answers the frame with `invalid_params` and this message. */
export function refuseRequest(message: string): never {
  throw Object.assign(new Error(message), { code: 'invalid_params' })
}

/** The message of a thrown value, or the value as text when it is not an Error. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a value is a plain object: not null and not a list. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A field of its own on a record, or undefined when the record does not have it. */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** A field of its own that is a plain object, or an empty object when it is missing or is not one. */
export function ownRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = own(record, key)
  return isRecord(value) ? value : {}
}

/** Whether a value is text with at least one character. */
export function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** How a request that takes one text field and nothing else is named in its refusals. */
export type OneTextRequest = {
  /** The request's name, as in "Link does not take path." */
  name: string
  /** The refusal when the input is not a record, such as "Link takes the id of an Archon project." */
  shape: string
  /** The field's key in the input. */
  key: string
  /** The field as a refusal names it, such as "The project id". */
  field: string
  /** The most characters the field may have. */
  cap: number
}

/** Whether a value is text of 1 to `cap` characters. */
export function isCappedText(value: unknown, cap: number): value is string {
  return isText(value) && value.length <= cap
}

/** The refusal for a field that is not text of 1 to `cap` characters. */
export function cappedTextRefusal(field: string, cap: number): string {
  return `${field} must be text of 1 to ${String(cap)} characters.`
}

/** The one text field of a request that takes nothing else, or a refusal. */
export function parseOneText(input: unknown, request: OneTextRequest): string {
  if (!isRecord(input)) refuseRequest(request.shape)
  const value = own(input, request.key)
  if (!isCappedText(value, request.cap)) refuseRequest(cappedTextRefusal(request.field, request.cap))
  refuseOtherKeys(input, [request.key], request.name)
  return value
}

/** Refuses a request with a key not in `keys`, as in "Link does not take path." */
export function refuseOtherKeys(input: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const key of Object.keys(input)) if (!keys.includes(key)) refuseRequest(`${name} does not take ${key}.`)
}
