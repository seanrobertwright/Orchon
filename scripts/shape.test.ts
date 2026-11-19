import { assert, describe, test } from 'orca/testing'
import { field, isRefusal, text } from './shape.ts'

describe('reading values of no promised shape', () => {
  test('a field is read through nested objects, and is undefined when a step is missing or not an object', () => {
    const value: unknown = JSON.parse('{"run":{"status":"failed","note":null}}')
    assert.equal(field(value, 'run', 'status'), 'failed')
    assert.equal(field(value, 'run', 'note'), null)
    assert.equal(field(value, 'run', 'missing'), undefined)
    assert.equal(field(value, 'run', 'status', 'length'), undefined)
    assert.equal(field(null, 'run'), undefined)
  })

  test('an inherited property is not a field', () => {
    assert.equal(field({}, 'toString'), undefined)
  })

  test('text is a string that is not empty', () => {
    assert.equal(text('id'), 'id')
    assert.equal(text(''), undefined)
    assert.equal(text(7), undefined)
  })

  test('a refusal is told from a result by its own error field', () => {
    assert.equal(isRefusal<{ root: string }>({ error: 'Name a folder.' }), true)
    assert.equal(isRefusal<{ root: string }>({ root: '/tmp' }), false)
  })
})
