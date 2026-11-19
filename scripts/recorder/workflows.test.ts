// What the recorder may launch: its own workflows with no agent, and never the cleanup workflow.
import { assert, describe, test } from 'orca/testing'
import { isA } from './testing.ts'
import {
  assertLaunchable,
  assertNoAgent,
  assertReadWithoutAgent,
  FORBIDDEN_WORKFLOWS,
  LaunchRefused,
  RECORDER_WORKFLOWS,
  workflowFile
} from './workflows.ts'

describe("the recorder's workflows", () => {
  test('never launches archon-worktree-cleanup', () => {
    assert.deepEqual(FORBIDDEN_WORKFLOWS, ['archon-worktree-cleanup'])
    assert.throws(() => assertLaunchable('archon-worktree-cleanup'), isA(LaunchRefused))
  })

  test('launches only its own workflows', () => {
    for (const workflow of Object.values(RECORDER_WORKFLOWS)) {
      assert.match(workflow.name, /^orchon-recorder-[a-z]+$/)
      assertLaunchable(workflow.name)
    }
    for (const name of ['archon-forge-check', 'archon-assist', 'orchon-recorder-other', 'ORCHON-RECORDER-ECHO', '']) {
      assert.throws(() => assertLaunchable(name), isA(LaunchRefused))
    }
  })

  test('its own workflows have no agent, need no worktree and are written as checked', () => {
    for (const workflow of Object.values(RECORDER_WORKFLOWS)) {
      assertNoAgent(workflow)
      assert.deepEqual(workflow.worktree, { enabled: false })
      const file = workflowFile(workflow)
      assert.equal(file.name, `${workflow.name}.yaml`)
      assert.deepEqual(JSON.parse(file.text), workflow)
    }
  })

  test('between them they hold a gate, an attention wait, a required input, a failing step and a slow one', () => {
    const { gate, inputs, fail, echo, slow } = RECORDER_WORKFLOWS
    assert.match(String(slow.nodes[0]?.bash), /^sleep \d+;/)
    assert.deepEqual(
      gate.nodes.map((node) => Object.keys(node).find((key) => ['approval', 'wait', 'bash'].includes(key))),
      ['approval', 'wait', 'bash']
    )
    assert.equal(inputs.inputs?.item?.required, true)
    assert.equal(echo.inputs, undefined)
    assert.match(String(fail.nodes[0]?.bash), /exit 1/)
  })

  test('refuses a workflow with a step that could run an agent', () => {
    const withNode = (node: Record<string, unknown>): unknown => ({ name: 'x', nodes: [{ id: 'ok', bash: 'true' }, node] })
    for (const node of [
      { id: 'a', prompt: 'Fix the bug.' },
      { id: 'a', command: 'archon-implement' },
      { id: 'a', loop: { prompt: 'Again.', until: 'DONE' } },
      { id: 'a', script: 'console.log(1)', runtime: 'bun' },
      { id: 'a', workflow: 'archon-assist' },
      { id: 'a', include: 'archon-assist' },
      { id: 'a', bash: 'true', model: 'small' },
      { id: 'a', bash: 'true', approval: { message: 'Both.' } },
      { id: 'a' },
      'a'
    ]) {
      assert.throws(() => assertNoAgent(withNode(node as Record<string, unknown>)), isA(LaunchRefused))
    }
    for (const workflow of [null, {}, { nodes: [] }, { nodes: 'none' }]) {
      assert.throws(() => assertNoAgent(workflow), isA(LaunchRefused))
    }
  })

  test('leaves out a key that is null, as a definition that came back as JSON may hold', () => {
    assertNoAgent({ nodes: [{ id: 'a', bash: 'true', prompt: null, model: undefined }] })
  })

  test("accepts Archon's own reading only when every step is a gate, a wait or a shell step", () => {
    assertReadWithoutAgent({
      nodes: [
        { id: 'gate', kind: 'gate', message: 'Go on?' },
        { id: 'ask', kind: 'wait', wait: { attention: 'Pick one.' } },
        { id: 'done', kind: 'exec', script: 'echo recorded', runtime: 'sh' }
      ]
    })
    for (const node of [
      { id: 'a', kind: 'agent', prompt: 'Fix the bug.' },
      { id: 'a', kind: 'loop' },
      { id: 'a', kind: 'loop_group' },
      { id: 'a', kind: 'exec', script: 'merged', runtime: 'bun' },
      { id: 'a', kind: 'exec', script: 'true' },
      { id: 'a', kind: 'something-new' },
      { id: 'a', bash: 'true' },
      null
    ]) {
      assert.throws(() => assertReadWithoutAgent({ nodes: [node] }), isA(LaunchRefused))
    }
    assert.throws(() => assertReadWithoutAgent({ nodes: [] }), isA(LaunchRefused))
    assert.throws(() => assertReadWithoutAgent(undefined), isA(LaunchRefused))
  })
})
