// Which local validation findings stop the builder's Save: the four graph rules and no others.
import { assert, describe, test } from 'orca/testing'
import { fromWorkflowDefinition } from './archon/model/index.ts'
import type { Issue, WireDagNode } from './archon/types/index.ts'
import { runValidation } from './archon/validation/index.ts'
import { saveBlockers } from './save-blockers.ts'

/** Every local finding, import and validation, for a workflow holding these nodes. */
function issuesOf(...nodes: Record<string, unknown>[]): Issue[] {
  const { workflow, issues } = fromWorkflowDefinition({ name: 'w', description: 'd', nodes: nodes as WireDagNode[] })
  return [...issues, ...runValidation(workflow)]
}

const rulesOf = (issues: readonly Issue[]): string[] => [...new Set(issues.map((issue) => issue.rule))].sort()

describe('what blocks a save', () => {
  test('an unknown variable and an unparsable when are warnings, and do not block a save', () => {
    const issues = issuesOf(
      { id: 'plan', prompt: 'Read $ghost.output' },
      { id: 'run', depends_on: ['plan'], bash: 'ls', when: "$plan.output == 'x' &&" }
    )
    const found = issues.filter((issue) => issue.rule === 'content.var.unknown' || issue.rule === 'content.when.parse')
    assert.deepEqual(rulesOf(found), ['content.var.unknown', 'content.when.parse'])
    assert.deepEqual(
      found.map((issue) => issue.severity),
      found.map(() => 'warning')
    )
    assert.deepEqual(saveBlockers(issues), [])
  })

  test('an empty id, a duplicate id, an unknown dependency and a cycle each block a save', () => {
    for (const [rule, nodes] of [
      ['structural.id.empty', [{ id: ' ', prompt: 'p' }]],
      ['structural.id.duplicate', [{ id: 'a', prompt: 'p' }, { id: 'a', prompt: 'q' }]],
      ['graph.ref.unknown', [{ id: 'a', depends_on: ['nowhere'], prompt: 'p' }]],
      [
        'graph.cycle',
        [
          { id: 'a', depends_on: ['b'], prompt: 'p' },
          { id: 'b', depends_on: ['a'], prompt: 'q' }
        ]
      ]
    ] as const) {
      const blockers = saveBlockers(issuesOf(...nodes))
      assert.deepEqual(rulesOf(blockers), [rule], rule)
      assert.ok(blockers.every((issue) => issue.severity === 'error'), rule)
    }
  })

  test('no other finding blocks a save or is an error, however many a workflow raises', () => {
    const issues = issuesOf(
      { id: 'empty', prompt: '' },
      { id: 'blank-command', command: '  ' },
      { id: 'loop', loop: { prompt: '', max_iterations: 0, fresh_context: false } },
      { id: 'wait', wait: { until: 'tomorrow' } },
      { id: 'gate', approval: { message: '' } },
      { id: 'script', script: '', runtime: 'bun' },
      { id: 'odd', teleport: true },
      { id: 'kept', prompt: 'p', future_field: 1 }
    )
    assert.ok(issues.length >= 6, `the workflow raises ${issues.length} findings`)
    assert.deepEqual(saveBlockers(issues), [])
    assert.deepEqual(
      issues.filter((issue) => issue.severity === 'error').map((issue) => issue.rule),
      []
    )
  })
})
