// Pure logic of the builder's editing: the session that holds the copy being edited, applies each
// edit through the copied Archon editor state, knows whether the copy differs from the one opened,
// and undoes and redoes. A test reads what a save would write, through `definition()`.
import { assert, describe, test } from 'orca/testing'
import { openSession, type EditSession } from './edit-session.ts'
import { applyField, formFields, type FormField } from './node-form.ts'

const open = (definition: Record<string, unknown>): EditSession => {
  const session = openSession(definition)
  if (session === null) throw new Error('The definition did not open.')
  return session
}

const nodesOf = (session: EditSession): Record<string, unknown>[] => session.definition().nodes as unknown as Record<string, unknown>[]

const field = (session: EditSession, index: number, key: string): FormField => {
  const node = session.workflow().nodes[index]
  if (node === undefined) throw new Error(`There is no node ${String(index)}.`)
  const found = formFields(node).find((candidate) => candidate.key === key)
  if (found === undefined) throw new Error(`Node ${String(index)} has no field ${key}.`)
  return found
}

/** Sets a field of a node as the inspector does, and fails when the value is refused. */
const edit = (session: EditSession, index: number, key: string, raw: string | boolean): void => {
  const node = session.workflow().nodes[index]
  if (node === undefined) throw new Error(`There is no node ${String(index)}.`)
  const applied = applyField(node, field(session, index, key), raw)
  if (!applied.ok) throw new Error(applied.error)
  session.setNode(index, applied.node)
}

/** A node of each editable kind, each with a field no release names and a field Archon carries with no editor. */
const UNKNOWN = {
  name: 'unknowns',
  description: 'Fields the builder does not edit',
  tags: ['kept'],
  nodes: [
    { id: 'p', prompt: 'Plan', teleport: { to: 'mars' }, hooks: { PreToolUse: [] }, retry: { max_attempts: 2 } },
    { id: 'c', command: 'review', with: { depth: 2 }, depends_on: ['p'], allowed_tools: ['Read'], mystery: 1 },
    { id: 'b', bash: 'npm test', on_timeout: 'skip', timeout: 5000, sandbox: { enabled: true }, extra: 'x' },
    { id: 's', script: 'index', runtime: 'bun', with: { a: 1 }, on_timeout: 'skip', odd: [1, 2] },
    { id: 'l', loop: { prompt: 'again', until: 'DONE', max_iterations: 3, fresh_context: false, signal_completes: true, on_exhausted: 'complete' }, context: 'fresh', weird: true },
    { id: 'a', approval: { message: 'OK?', decisions: [{ id: 'go' }], capture_response: true }, other: 'y' },
    { id: 'w', wait: { attention: 'Look', form: 'select', options: ['a', 'b'] }, odd: 'z' },
    { id: 'x', cancel: 'Stop', reason_code: 7 },
    { id: 'g', loop_group: { max_iterations: 2, fresh_context: false, nodes: [{ id: 'inner', prompt: 'i' }] } }
  ]
}

/** The edit made to each node in turn: one field that has an editor. */
const EDITS: [string, string][] = [
  ['p', 'prompt'],
  ['c', 'command'],
  ['b', 'bash'],
  ['s', 'script'],
  ['l', 'loop.prompt'],
  ['a', 'approval.message'],
  ['w', 'wait.attention'],
  ['x', 'cancel'],
  ['g', 'when']
]

describe('an edit', () => {
  test('round-trips every field the builder does not edit unchanged, on every kind', () => {
    const session = open(UNKNOWN)
    const before = nodesOf(session)
    EDITS.forEach(([id, key], index) => {
      assert.equal(session.workflow().nodes[index]?.id, id)
      edit(session, index, key, key === 'when' ? "$p.output == 'x'" : 'changed')
    })
    const after = nodesOf(session)
    after.forEach((node, index) => {
      const [, key] = EDITS[index] ?? ['', '']
      const [outer, inner] = key.split('.')
      const was = before[index] ?? {}
      for (const [name, value] of Object.entries(was)) {
        if (name === outer && inner === undefined) continue
        if (name === outer && inner !== undefined) {
          const { [inner]: _edited, ...kept } = value as Record<string, unknown>
          const { [inner]: _now, ...keptNow } = node[name] as Record<string, unknown>
          assert.deepEqual(keptNow, kept, `${String(node.id)}.${name}`)
          continue
        }
        assert.deepEqual(node[name], value, `${String(node.id)}.${name}`)
      }
    })
    const definition = session.definition() as unknown as Record<string, unknown>
    assert.deepEqual(definition.tags, ['kept'])
    assert.equal(nodesOf(session)[0]?.prompt, 'changed')
    assert.equal(nodesOf(session)[8]?.when, "$p.output == 'x'")
  })
})

const SMALL = {
  name: 'small',
  description: 'Two nodes',
  nodes: [
    { id: 'plan', prompt: 'Plan it' },
    { id: 'run', bash: 'npm test', depends_on: ['plan'] }
  ]
}

const ids = (session: EditSession): string[] => session.workflow().nodes.map((node) => node.id)
const depends = (session: EditSession, index: number): unknown => nodesOf(session)[index]?.depends_on

describe('Unsaved changes', () => {
  test('is false on open, true once the definition differs, and false again once it is the one opened', () => {
    const session = open(SMALL)
    assert.equal(session.dirty(), false)
    edit(session, 0, 'prompt', 'Plan it well')
    assert.equal(session.dirty(), true)
    edit(session, 0, 'prompt', 'Plan it')
    assert.equal(session.dirty(), false)
  })
})

describe('undo and redo', () => {
  test('step back and forward through the edits, and a typed burst in one field is one step', () => {
    const session = open(SMALL)
    assert.equal(session.canUndo(), false)
    const node = (): Parameters<EditSession['setNode']>[1] => session.workflow().nodes[0] as Parameters<EditSession['setNode']>[1]
    for (const typed of ['P', 'Pl', 'Pla']) {
      const applied = applyField(node(), field(session, 0, 'prompt'), typed)
      assert.ok(applied.ok)
      session.setNode(0, applied.node, typed !== 'P')
    }
    session.addNode('cancel')
    assert.deepEqual(ids(session), ['plan', 'run', 'cancel-1'])
    assert.ok(session.undo())
    assert.deepEqual(ids(session), ['plan', 'run'])
    assert.equal(nodesOf(session)[0]?.prompt, 'Pla')
    assert.ok(session.undo())
    assert.equal(nodesOf(session)[0]?.prompt, 'Plan it')
    assert.equal(session.dirty(), false)
    assert.equal(session.undo(), false)
    assert.ok(session.redo())
    assert.equal(nodesOf(session)[0]?.prompt, 'Pla')
    assert.ok(session.redo())
    assert.deepEqual(ids(session), ['plan', 'run', 'cancel-1'])
    assert.equal(session.canRedo(), false)
  })
})

describe('nodes', () => {
  test('a node added from the menu gets a fresh id and the kind\'s starting fields', () => {
    const session = open(SMALL)
    assert.equal(session.addNode('prompt'), 2)
    assert.equal(session.addNode('prompt'), 3)
    assert.deepEqual(nodesOf(session).slice(2), [
      { id: 'prompt-1', prompt: '' },
      { id: 'prompt-2', prompt: '' }
    ])
  })

  test('a removed node is gone, and so is every dependency on it', () => {
    const session = open(SMALL)
    assert.ok(session.removeNode(0))
    assert.deepEqual(nodesOf(session), [{ id: 'run', bash: 'npm test' }])
  })

  test('a duplicate is a copy with a fresh id at the end, with no dependencies, its other fields kept', () => {
    const session = open({ name: 'd', nodes: [{ id: 'plan', prompt: 'p' }, { id: 'run', bash: 'ls', depends_on: ['plan'], teleport: 1 }] })
    assert.equal(session.duplicateNode(1), 2)
    assert.deepEqual(nodesOf(session)[2], { id: 'run-copy', bash: 'ls', teleport: 1 })
  })

  test('the workflow description is edited; the name stays', () => {
    const session = open(SMALL)
    session.setDescription('Plan, then test')
    assert.equal(session.definition().description, 'Plan, then test')
    assert.equal(session.definition().name, 'small')
  })
})

describe('dependencies', () => {
  test('are added once, never on the node itself, and removed', () => {
    const session = open(SMALL)
    assert.ok(session.addDependency(0, 'run'))
    assert.deepEqual(depends(session, 0), ['run'])
    assert.equal(session.addDependency(0, 'run'), false)
    assert.equal(session.addDependency(0, 'plan'), false)
    assert.ok(session.removeDependency(1, 'plan'))
    assert.equal(depends(session, 1), undefined)
  })

  test('a dependency on a node that does not exist can be removed', () => {
    const session = open({ name: 'd', nodes: [{ id: 'a', prompt: 'p', depends_on: ['nope', 'b'] }, { id: 'b', prompt: 'q' }] })
    assert.ok(session.removeDependency(0, 'nope'))
    assert.deepEqual(depends(session, 0), ['b'])
  })

  test("a read-only node's dependencies and shared fields are edited, and its own fields kept", () => {
    const session = open({ name: 'd', nodes: [{ id: 'a', prompt: 'p' }, { id: 'g', include: 'common.yaml', depends_on: ['a'] }] })
    assert.ok(session.removeDependency(1, 'a'))
    edit(session, 1, 'when', "$a.output == 'x'")
    edit(session, 1, 'description', 'Shared steps')
    assert.deepEqual(nodesOf(session)[1], { id: 'g', include: 'common.yaml', when: "$a.output == 'x'", description: 'Shared steps' })
  })
})

describe('two nodes with one id', () => {
  test('an edit to one reaches it alone', () => {
    const session = open({ name: 'd', nodes: [{ id: 'twin', prompt: 'one' }, { id: 'twin', prompt: 'two' }, { id: 'x', prompt: 'x' }] })
    edit(session, 1, 'prompt', 'changed')
    assert.ok(session.addDependency(1, 'x'))
    assert.deepEqual(nodesOf(session).slice(0, 2), [
      { id: 'twin', prompt: 'one' },
      { id: 'twin', prompt: 'changed', depends_on: ['x'] }
    ])
    assert.ok(session.removeNode(0))
    assert.deepEqual(ids(session), ['twin', 'x'])
  })
})
