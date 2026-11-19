// The fields of a node that the builder lists under "Not editable here".
import { assert, describe, test } from 'orca/testing'
import { fromWorkflowDefinition } from './archon/model/index.ts'
import type { WireDagNode } from './archon/types/index.ts'
import { notEditableHere } from './not-editable.ts'

/** The one node of a workflow holding only `node`, as the builder opens it. */
function opened(node: Record<string, unknown>) {
  const { workflow } = fromWorkflowDefinition({
    name: 'w',
    description: 'd',
    nodes: [node as WireDagNode]
  })
  const [only] = workflow.nodes
  assert.ok(only !== undefined)
  return only
}

describe('Not editable here', () => {
  test('lists the fields a node kind has no editor for, in the order a save writes them', () => {
    const node = opened({
      id: 'plan',
      allowed_tools: ['Read'],
      prompt: 'Plan it',
      depends_on: ['a'],
      output_format: { type: 'object' },
      model: 'opus',
      when: "$a.output == 'x'"
    })
    assert.deepEqual(notEditableHere(node), ['allowed_tools', 'output_format'])
  })

  test('lists nothing for a node whose every field has an editor', () => {
    const node = opened({ id: 'run', bash: 'npm test', timeout: 1000, depends_on: ['a'], trigger_rule: 'all_done', output_type: 'report' })
    assert.deepEqual(notEditableHere(node), [])
  })

  test('lists a model preference list, which is edited as YAML, but not a single model', () => {
    assert.deepEqual(notEditableHere(opened({ id: 'a', command: 'c', model: ['@implementer', 'large'] })), ['model'])
    assert.deepEqual(notEditableHere(opened({ id: 'a', command: 'c', model: 'large' })), [])
  })

  test('lists the AI fields on a node kind that makes no provider call', () => {
    assert.deepEqual(notEditableHere(opened({ id: 'a', bash: 'ls', provider: 'claude', model: 'opus' })), ['provider', 'model'])
  })

  test('names a field inside a loop, an approval or a wait by its path', () => {
    const loop = opened({
      id: 'refine',
      loop: { prompt: 'p', until_field: 'done', max_iterations: 3, fresh_context: false, signal_completes: true },
      output_format: { type: 'object' }
    })
    assert.deepEqual(notEditableHere(loop), ['output_format', 'loop.signal_completes'])

    const approval = opened({ id: 'gate', approval: { message: 'Ok?', decisions: [{ id: 'approve' }], capture_response: true } })
    assert.deepEqual(notEditableHere(approval), ['approval.decisions'])

    const wait = opened({
      id: 'ask',
      wait: { attention: 'Which?', form: { type: 'object' }, options: ['a'], labels: ['x'], recommendation: 'a' }
    })
    assert.deepEqual(notEditableHere(wait), ['wait.form', 'wait.options', 'wait.labels', 'wait.recommendation'])
  })

  test('lists a field no release of Archon names', () => {
    assert.deepEqual(notEditableHere(opened({ id: 'a', prompt: 'p', future_field: { kept: true } })), ['future_field'])
  })

  test('lists every field of a node the builder shows read-only but its id and the shared fields, which stay editable', () => {
    const group = opened({ id: 'tdd', depends_on: ['a'], when: "$a.output == 'x'", description: 'd', trigger_rule: 'all_done', loop_group: { max_iterations: 2, nodes: [] }, model: 'opus' })
    assert.deepEqual(notEditableHere(group), ['model', 'loop_group'])
  })

  test('lists no field the inspector has an editor for, the description included', () => {
    assert.deepEqual(notEditableHere(opened({ id: 'a', prompt: 'p', description: 'Plans', persist_session: true })), [])
    assert.deepEqual(notEditableHere(opened({ id: 'g', approval: { message: 'm', on_reject: { prompt: 'p', max_attempts: 2 } } })), [])
  })
})
