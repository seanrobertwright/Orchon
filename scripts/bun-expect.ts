// The part of `bun:test` that the tests copied from Archon's builder use, on top of `orca/testing`,
// so those tests run under `orca plugin test` with no Bun. A ported test changes only its import
// line. The matchers follow Bun's documented meaning:
//
// - `toEqual` compares recursively and treats a property whose value is undefined as absent.
// - `toBe` is `Object.is`. `toContain` is substring or `Object.is` membership.
// - `toMatchObject` requires every property of the expected object, recursively.
// - `expect.objectContaining` and `expect.arrayContaining` match a subset inside `toEqual`.
import { assert, describe, test } from 'orca/testing'

export { describe, test }

/** A value that decides for itself whether it matches, as Bun's `expect.objectContaining` does. */
class Asymmetric {
  readonly matches: (actual: unknown) => boolean
  readonly label: string
  constructor(label: string, matches: (actual: unknown) => boolean) {
    this.label = label
    this.matches = matches
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

const definedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).filter((key) => value[key] !== undefined)

/** Bun's `toEqual` equality. */
function equals(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Asymmetric) return expected.matches(actual)
  if (Object.is(actual, expected)) return true
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, index) => equals(item, expected[index]))
  }
  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size !== expected.size) return false
    for (const [key, value] of expected) {
      if (!actual.has(key) || !equals(actual.get(key), value)) return false
    }
    return true
  }
  if (actual instanceof Set && expected instanceof Set) {
    if (actual.size !== expected.size) return false
    return [...expected].every((item) => [...actual].some((candidate) => equals(candidate, item)))
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    const actualKeys = definedKeys(actual)
    const expectedKeys = definedKeys(expected)
    if (actualKeys.length !== expectedKeys.length) return false
    return expectedKeys.every((key) => Object.hasOwn(actual, key) && equals(actual[key], expected[key]))
  }
  return false
}

/** Bun's `toMatchObject`: every property of `expected` is present and matches in `actual`. */
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Asymmetric) return expected.matches(actual)
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, index) => matchesObject(item, expected[index]))
  }
  if (isPlainObject(expected)) {
    if (typeof actual !== 'object' || actual === null) return false
    const record = actual as Record<string, unknown>
    return Object.keys(expected).every((key) => Object.hasOwn(record, key) && matchesObject(record[key], expected[key]))
  }
  return equals(actual, expected)
}

/** Readable text of a value for a failure message. */
function show(value: unknown): string {
  if (value instanceof Asymmetric) return value.label
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  try {
    return JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (item instanceof Map) return { Map: [...item.entries()] }
        if (item instanceof Set) return { Set: [...item] }
        if (item instanceof Asymmetric) return item.label
        return item
      }
    )
  } catch {
    return String(value)
  }
}

export interface Matchers {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toMatchObject(expected: unknown): void
  toContain(expected: unknown): void
  toContainEqual(expected: unknown): void
  toHaveLength(expected: number): void
  toBeNull(): void
  toBeUndefined(): void
  toBeDefined(): void
  toBeGreaterThan(expected: number): void
  toThrow(expected?: RegExp | string): void
}

function matchers(actual: unknown, negated: boolean): Matchers {
  const check = (pass: boolean, words: string, ...expected: unknown[]): void => {
    if (pass !== negated) return
    const subject = `expected ${show(actual)} ${negated ? 'not ' : ''}${words}`
    assert.fail(expected.length > 0 ? `${subject} ${show(expected[0])}` : subject)
  }
  const length = (): number | undefined => {
    if (typeof actual === 'string' || Array.isArray(actual)) return actual.length
    return undefined
  }
  return {
    toBe: (expected) => check(Object.is(actual, expected), 'to be', expected),
    toEqual: (expected) => check(equals(actual, expected), 'to equal', expected),
    toMatchObject: (expected) => check(matchesObject(actual, expected), 'to match object', expected),
    toContain: (expected) =>
      check(
        typeof actual === 'string'
          ? typeof expected === 'string' && actual.includes(expected)
          : Array.isArray(actual) || actual instanceof Set
            ? [...actual].some((item) => Object.is(item, expected))
            : false,
        'to contain',
        expected
      ),
    toContainEqual: (expected) =>
      check(Array.isArray(actual) && actual.some((item) => equals(item, expected)), 'to contain an item equal to', expected),
    toHaveLength: (expected) => check(length() === expected, 'to have length', expected),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeGreaterThan: (expected) => check(typeof actual === 'number' && actual > expected, 'to be greater than', expected),
    toThrow: (expected) => {
      if (typeof actual !== 'function') assert.fail('toThrow needs a function')
      let thrown: unknown
      let threw = false
      try {
        ;(actual as () => unknown)()
      } catch (error) {
        threw = true
        thrown = error
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      const pass =
        threw &&
        (expected === undefined ||
          (typeof expected === 'string' ? message.includes(expected) : expected.test(message)))
      check(pass, 'to throw', expected)
    }
  }
}

export interface Expect {
  (actual: unknown): Matchers & { not: Matchers }
  objectContaining(expected: Record<string, unknown>): unknown
  arrayContaining(expected: readonly unknown[]): unknown
}

export const expect: Expect = Object.assign(
  (actual: unknown) => ({ ...matchers(actual, false), not: matchers(actual, true) }),
  {
    objectContaining: (expected: Record<string, unknown>): unknown =>
      new Asymmetric(`objectContaining(${show(expected)})`, (actual) => {
        if (typeof actual !== 'object' || actual === null) return false
        const record = actual as Record<string, unknown>
        return Object.keys(expected).every((key) => Object.hasOwn(record, key) && equals(record[key], expected[key]))
      }),
    arrayContaining: (expected: readonly unknown[]): unknown =>
      new Asymmetric(
        `arrayContaining(${show(expected)})`,
        (actual) => Array.isArray(actual) && expected.every((item) => actual.some((candidate) => equals(candidate, item)))
      )
  }
)
