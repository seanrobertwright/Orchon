// Reading values whose shape nothing promises: JSON answers, files on disk and parse results.

/** A field of a value, or undefined when the value has another shape. */
export function field(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** A string that is not empty, or undefined. */
export const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** What a parser answers in place of its result when the input is wrong. */
export interface Refusal {
  error: string
}

/** Whether a parser refused its input. */
export const isRefusal = <T extends object>(parsed: T | Refusal): parsed is Refusal => Object.hasOwn(parsed, 'error')
