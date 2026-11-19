// Pure logic: the one date helper. Everything about time in the shipped code goes through it.
import { assert, describe, test } from 'orca/testing'
import { formatClock, now, parseInstant } from './dates'

describe('the date helper', () => {
  test('now is the current time in milliseconds since the epoch', () => {
    const before = Date.now()
    const value = now()
    assert.ok(Number.isInteger(value))
    assert.ok(value >= before && value <= Date.now())
  })

  test('parses an instant that names its zone', () => {
    assert.equal(parseInstant('2026-11-15T03:52:33.126Z'), Date.UTC(2026, 10, 15, 3, 52, 33, 126))
    assert.equal(parseInstant('2026-11-15T03:52:33Z'), Date.UTC(2026, 10, 15, 3, 52, 33))
    assert.equal(parseInstant('2026-11-15T03:52:33+02:00'), Date.UTC(2026, 10, 15, 1, 52, 33))
    assert.equal(parseInstant('2026-11-15T03:52:33-05:30'), Date.UTC(2026, 10, 15, 9, 22, 33))
  })

  test('reads an instant with no zone as UTC, never as local time', () => {
    assert.equal(parseInstant('2026-11-18 00:51:42'), Date.UTC(2026, 10, 18, 0, 51, 42))
    assert.equal(parseInstant('2026-11-18T00:51:42'), Date.UTC(2026, 10, 18, 0, 51, 42))
    assert.equal(parseInstant('2026-11-18T00:51:42.5'), Date.UTC(2026, 10, 18, 0, 51, 42, 500))
  })

  test('answers null for anything that is not an instant', () => {
    const refused = [
      '',
      'yesterday',
      '2026-11-18',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-11-18T24:00:00Z',
      '2026-11-18T10:60:00Z',
      '2026-11-18T10:00:00+25:00',
      ' 2026-11-18T10:00:00Z',
      '2026-11-18T10:00:00Z trailing',
      1763427102000,
      null,
      undefined,
      {}
    ]
    for (const value of refused) assert.equal(parseInstant(value), null, JSON.stringify(value))
  })

  test('formats a wall-clock time in the given locale', () => {
    const at = Date.UTC(2026, 10, 18, 14, 32, 5)
    const expected = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(at)
    assert.equal(formatClock(at, 'en-GB'), expected)
    assert.match(formatClock(at, 'en-GB'), /^\d{2}:\d{2}$/)
  })

  test('formats with the default locale when the given one is not a locale', () => {
    const at = Date.UTC(2026, 10, 18, 14, 32, 5)
    assert.match(formatClock(at, 'not a locale'), /\d{1,2}.\d{2}/)
  })

  test('answers an empty text for a time no date can hold', () => {
    assert.equal(formatClock(Number.NaN, 'en-GB'), '')
    assert.equal(formatClock(Number.POSITIVE_INFINITY, 'en-GB'), '')
    assert.equal(formatClock(8.64e15 + 1, 'en-GB'), '')
    assert.equal(formatClock(-8.64e15 - 1, 'en-GB'), '')
  })
})
