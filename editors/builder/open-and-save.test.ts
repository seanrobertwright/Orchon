// Nothing a workflow holds is dropped when the builder opens it: a field the logic does not
// recognise stays on its node, and a node the builder cannot edit opens read-only. Both are
// written back unchanged.
import { assert, describe, test } from 'orca/testing'
import { fromWorkflowDefinition, toWorkflowDefinition } from './archon/model/index.ts'
import { runValidation } from './archon/validation/index.ts'
import type { WireDagNode, WireWorkflowDefinition } from './archon/types/index.ts'

/** A workflow holding these nodes, as Archon would give it. */
const workflowOf = (...nodes: Record<string, unknown>[]): WireWorkflowDefinition => ({
  name: 'kept',
  description: 'Nothing is dropped',
  nodes: nodes as WireDagNode[]
})

/** What a save sends: the definition as JSON. */
const asSent = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/** Opens `definition`, saves it with no edit, and requires what was opened. */
function assertSavedUnchanged(definition: WireWorkflowDefinition): void {
  const { workflow } = fromWorkflowDefinition(definition)
  assert.deepEqual(asSent(toWorkflowDefinition(workflow)), asSent(definition))
}

const variantOf = (definition: WireWorkflowDefinition, id: string): string | undefined =>
  fromWorkflowDefinition(definition).workflow.nodes.find((node) => node.id === id)?.variant

describe('opening a workflow drops nothing', () => {
  test('a field no release of Archon names stays on its node and is written back unchanged', () => {
    const definition = workflowOf(
      { id: 'plan', prompt: 'Plan it', future_field: { nested: [1, 2] } },
      { id: 'run', depends_on: ['plan'], bash: 'npm test', 'x-note': 'keep me' }
    )
    assertSavedUnchanged(definition)
    assert.equal(variantOf(definition, 'plan'), 'prompt')
    assert.equal(variantOf(definition, 'run'), 'bash')
  })

  test('a known field on a node kind that does not carry it is written back unchanged', () => {
    assertSavedUnchanged(
      workflowOf(
        { id: 'ask', prompt: 'p', timeout: 5000, on_timeout: 'skip' },
        { id: 'do', command: 'c', isolation: 'worktree', runtime: 'uv' },
        { id: 'gate', approval: { message: 'Ok?' }, with: { a: 1 } }
      )
    )
  })

  test('a field kept this way is not reported as dropped', () => {
    const { issues } = fromWorkflowDefinition(workflowOf({ id: 'plan', prompt: 'p', future_field: true }))
    assert.deepEqual(
      issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.message),
      []
    )
  })

  for (const [what, node] of [
    ['a node of an unrecognised kind', { id: 'odd', depends_on: ['plan'], teleport: { to: 'mars' } }],
    ['a node with no kind at all', { id: 'odd', depends_on: ['plan'] }],
    ['a script node with no runtime', { id: 'odd', depends_on: ['plan'], script: 'build-index', timeout: 1000 }],
    [
      'a loop node with both prompt and command',
      { id: 'odd', depends_on: ['plan'], loop: { prompt: 'p', command: 'c', until: 'DONE', max_iterations: 2 } }
    ]
  ] as const) {
    test(`${what} opens read-only and is written back unchanged`, () => {
      const definition = workflowOf({ id: 'plan', prompt: 'Plan it' }, node)
      assert.equal(variantOf(definition, 'odd'), 'opaque')
      assertSavedUnchanged(definition)
      const { workflow, issues } = fromWorkflowDefinition(definition)
      assert.deepEqual(
        issues.map((issue) => [issue.path.nodeId, issue.severity]),
        [['odd', 'info']]
      )
      assert.deepEqual(
        runValidation(workflow).filter((issue) => issue.severity === 'error'),
        []
      )
    })
  }
})
