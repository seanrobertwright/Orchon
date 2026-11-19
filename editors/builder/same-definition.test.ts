// Pure logic: whether two definitions mean the same workflow. The outside-change check of a save
// and the tab's own reads both ask it, so a re-read whose keys come back in another order is not
// taken for a change, while any changed value, list order or extra key is.
import { assert, describe, test } from 'orca/testing'
import { sameDefinition } from './same-definition.ts'

describe('whether two definitions mean the same workflow', () => {
  test('key order inside records does not matter', () => {
    assert.equal(sameDefinition({ name: 'a', nodes: [{ id: 'x', prompt: 'p', depends_on: ['y'] }] }, { nodes: [{ depends_on: ['y'], prompt: 'p', id: 'x' }], name: 'a' }), true)
  })

  test('a changed value, a list in another order, a key more or less, or another type is a difference', () => {
    const base = { name: 'a', nodes: [{ id: 'x', prompt: 'p' }, { id: 'y', bash: 'true' }] }
    const others: unknown[] = [
      { name: 'a', nodes: [{ id: 'x', prompt: 'q' }, { id: 'y', bash: 'true' }] },
      { name: 'a', nodes: [{ id: 'y', bash: 'true' }, { id: 'x', prompt: 'p' }] },
      { name: 'a', nodes: [{ id: 'x', prompt: 'p', extra: null }, { id: 'y', bash: 'true' }] },
      { name: 'a', nodes: [{ id: 'x' }, { id: 'y', bash: 'true' }] },
      { name: 'a', nodes: { 0: { id: 'x', prompt: 'p' }, 1: { id: 'y', bash: 'true' } } },
      { name: 'a', nodes: [{ id: 'x', prompt: 'p' }, { id: 'y', bash: 'true' }], timeout: '1' }
    ]
    for (const other of others) assert.equal(sameDefinition(base, other), false, JSON.stringify(other))
  })

  test('numbers, booleans, null and text compare by value and type', () => {
    assert.equal(sameDefinition({ a: 1, b: true, c: null, d: '1' }, { d: '1', c: null, b: true, a: 1 }), true)
    assert.equal(sameDefinition({ a: 1 }, { a: '1' }), false)
    assert.equal(sameDefinition({ a: null }, {}), false)
    assert.equal(sameDefinition({ a: false }, { a: 0 }), false)
  })
})
