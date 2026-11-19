// Pure logic of the builder tab: what it shows of a definition. Every node with its kind and
// whether it is read-only, the arrows between them, the issues and the YAML it would save. The
// copied Archon logic reads the definition; this module only gathers what the tab draws.
import { assert, describe, test } from 'orca/testing'
import { readRepoText } from '../../scripts/repo-files.ts'
import { workflowFacts, type WorkflowFacts } from './workflow-facts.ts'

const facts = (definition: Record<string, unknown>): WorkflowFacts => {
  const read = workflowFacts(definition)
  if (read === null) throw new Error('The definition did not read.')
  return read
}

const brief = (read: WorkflowFacts): string[] => read.nodes.map((node) => `${node.id} ${node.kind}${node.readOnly ? ' ro' : ''}`)

describe('the nodes of a workflow', () => {
  test('are listed in order with their kind; the kinds the builder cannot edit are read-only, each with its reason', () => {
    const read = facts({
      name: 'mixed',
      nodes: [
        { id: 'plan', prompt: 'Plan it' },
        { id: 'run', bash: 'npm test', depends_on: ['plan'] },
        { id: 'rounds', loop_group: { nodes: [{ id: 'inner', prompt: 'p' }] } },
        { id: 'sub', workflow: 'archon-review' },
        { id: 'shared', include: 'common.yaml' },
        { id: 'odd', teleport: { to: 'mars' } },
        { id: 'index', script: 'build-index' },
        { id: 'both', loop: { prompt: 'p', command: 'c', until: 'DONE', max_iterations: 2 } }
      ]
    })
    assert.deepEqual(brief(read), [
      'plan prompt',
      'run bash',
      'rounds loop group ro',
      'sub workflow ro',
      'shared include ro',
      'odd unknown kind ro',
      'index script with no runtime ro',
      'both loop with prompt and command ro'
    ])
    assert.deepEqual(
      read.nodes.map((node) => node.reason),
      [
        null,
        null,
        'A loop group has no editor here.',
        'A node that runs another workflow has no editor here.',
        'An include has no editor here.',
        'This node is of a kind the builder does not know.',
        'This script node names no runtime.',
        'This loop node has both a prompt and a command.'
      ]
    )
  })

  test('list the fields that have no editor under "Not editable here", and every field of a read-only node but its id and the shared fields', () => {
    const read = facts({ name: 'x', nodes: [{ id: 'plan', prompt: 'p', future_field: 1 }, { id: 'sub', workflow: 'other', depends_on: ['plan'] }] })
    assert.deepEqual(read.nodes.map((node) => node.notEditable), [['future_field'], ['workflow']])
  })

  test('each carry their own YAML and their dependencies', () => {
    const read = facts({ name: 'x', nodes: [{ id: 'plan', prompt: 'Plan it' }, { id: 'run', bash: 'npm test', depends_on: ['plan'] }] })
    assert.deepEqual(read.nodes.map((node) => node.dependsOn), [[], ['plan']])
    assert.equal(read.nodes[1]?.yaml, '- id: run\n  depends_on:\n    - plan\n  bash: npm test')
  })
})

describe('the arrows', () => {
  test('run from each dependency to the node that names it, by position; an arrow into a node with a `when` is conditional', () => {
    const read = facts({
      name: 'x',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', prompt: 'p', depends_on: ['a'] },
        { id: 'c', prompt: 'p', depends_on: ['a', 'b', 'missing'], when: "$a.output == 'yes'" }
      ]
    })
    assert.deepEqual(read.edges, [
      { from: 0, to: 1 },
      { from: 0, to: 2 },
      { from: 1, to: 2 }
    ])
    assert.deepEqual(read.nodes.map((node) => node.conditional), [false, false, true])
  })
})

describe('the issues', () => {
  test('hold what opening found and what the local rules find, each with its severity in a word and the node it names', () => {
    const read = facts({ name: 'x', nodes: [{ id: 'a', prompt: 'p', depends_on: ['nope'] }, { id: 'odd', include: 'x.yaml' }] })
    const shown = read.issues.map((issue) => `${issue.severity} ${issue.rule} ${issue.nodeId ?? '-'}`)
    assert.ok(shown.includes('Error graph.ref.unknown a'), shown.join('; '))
    assert.ok(shown.includes('Info structural.node.read-only odd'), shown.join('; '))
    assert.deepEqual(shown, [...shown].sort((first, second) => rank(first) - rank(second)))
  })
})

const rank = (line: string): number => ['Error', 'Warning', 'Info'].indexOf(line.split(' ')[0] ?? '')

describe('the YAML', () => {
  test('is what a save would write', () => {
    const read = facts({ name: 'small', description: 'One step', nodes: [{ id: 'plan', prompt: 'Plan it' }], inputs: { goal: { required: true } } })
    assert.equal(read.yaml, 'name: small\ndescription: One step\ninputs:\n  goal:\n    required: true\n\nnodes:\n  - id: plan\n    prompt: Plan it\n')
  })
})

describe('a recorded bundled workflow', () => {
  test("archon-deliver of Archon 0.14.0 lists every node, with its loop groups read-only", () => {
    const recording = JSON.parse(readRepoText('fixtures/0.14.0/workflows/archon-deliver.json')) as { log: { body: { authored: { nodes: { id: string }[] } } }[] }
    const authored = recording.log[0]?.body.authored
    if (authored === undefined) throw new Error('The recording has no authored form.')
    const read = facts(authored)
    assert.deepEqual(read.nodes.map((node) => node.id), authored.nodes.map((node) => node.id))
    const kinds = new Set(read.nodes.filter((node) => node.readOnly).map((node) => node.kind))
    assert.ok(kinds.has('loop group'), [...kinds].join(', '))
    for (const node of read.nodes) assert.equal(node.readOnly, node.reason !== null)
  })
})

describe('a definition the copied logic cannot read', () => {
  test('is null', () => {
    assert.equal(workflowFacts({ name: 'x', nodes: 'none' }), null)
  })
})
