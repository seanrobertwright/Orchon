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
  SYNTHETIC_METRIC_RECORDS,
  SYNTHETIC_METRICS,
  syntheticPackFiles,
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

// The record schema below is a short excerpt of Archon 0.14.0's own, from
// `packages/docs-web/src/content/docs/guides/metrics.md` ("The record schema") of
// coleam00/Archon at 8def159a6b2c23e832a5283b4131cfffd9af9344. A record holds only these keys.
const RECORD_KEYS = ['name', 'unit', 'subject', 'at', 'runs', 'instrument', 'instrument_node', 'kind', 'value', 'calibrates']
const NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/
// Built from a string: Orca's transpiler reads a `/` inside a regex literal's class as its end.
const UNIT = new RegExp('^[a-z0-9_%/.-]{1,32}$')

/** The reasons Archon 0.14.0 would refuse `record` at the node's completion, or none. */
function recordProblems(record: Record<string, unknown>): string[] {
  const problems = Object.keys(record).filter((key) => !RECORD_KEYS.includes(key)).map((key) => `unknown key ${key}`)
  for (const key of ['name', 'unit', 'subject', 'kind', 'value']) if (!Object.hasOwn(record, key)) problems.push(`no ${key}`)
  if (typeof record.name !== 'string' || record.name.length > 128 || !NAME.test(record.name)) problems.push('bad name')
  if (typeof record.unit !== 'string' || !UNIT.test(record.unit)) problems.push('bad unit')
  if (record.subject !== null && (typeof record.subject !== 'string' || record.subject.length > 256)) problems.push('bad subject')
  if (record.kind === 'count' && !(typeof record.value === 'number' && record.value >= 0)) problems.push('bad count')
  if (record.kind === 'score' && typeof record.value !== 'number') problems.push('bad score')
  if (record.kind !== 'count' && record.kind !== 'score') problems.push('bad kind')
  if (record.kind === 'count' && Object.hasOwn(record, 'calibrates')) problems.push('a count calibrates nothing')
  return problems
}

describe("the recorder's synthetic metrics pack", () => {
  test('is one shell step that prints fixed records and does nothing else: no agent, no network, no script runtime', () => {
    const workflow = SYNTHETIC_METRICS
    assert.equal(workflow.name, 'orchon-recorder-synthetic-metrics')
    assertNoAgent(workflow)
    assert.deepEqual(workflow.worktree, { enabled: false })
    assert.equal(workflow.nodes.length, 1)
    const [node] = workflow.nodes
    assert.deepEqual(Object.keys(node ?? {}).sort(), ['bash', 'id', 'output_format'])
    // A single `echo` of one quoted JSON document: nothing else runs, so nothing reaches a network.
    const script = String(node?.bash)
    const printed = /^echo '([^'$\\`]*)'$/.exec(script)
    assert.ok(printed, script)
    assert.deepEqual(JSON.parse(printed[1] ?? ''), { metrics: SYNTHETIC_METRIC_RECORDS })
    assert.deepEqual(node?.output_format, { type: 'object', required: ['metrics'], properties: { metrics: { type: 'array' } } })
  })

  test('its records are ones Archon 0.14.0 accepts, every name marked synthetic and every value a fixed number', () => {
    assert.ok(SYNTHETIC_METRIC_RECORDS.length >= 5)
    for (const record of SYNTHETIC_METRIC_RECORDS) {
      assert.deepEqual(recordProblems(record), [], JSON.stringify(record))
      assert.ok(String(record.name).startsWith('orchon_synthetic.'), String(record.name))
      assert.equal(typeof record.value, 'number')
      // No `at` and no `runs`: each record falls in a window by its completion and belongs to the run that returned it.
      assert.ok(!Object.hasOwn(record, 'at') && !Object.hasOwn(record, 'runs'))
    }
    // The worked numbers: four items opened, two merged, one abandoned; eight new tests, two useless; three of four cases caught.
    const sum = (name: string): number =>
      SYNTHETIC_METRIC_RECORDS.filter((record) => record.name === `orchon_synthetic.${name}` && record.kind === 'count').reduce((total, record) => total + Number(record.value), 0)
    assert.deepEqual([sum('items_opened'), sum('items_merged'), sum('items_abandoned'), sum('tests_added'), sum('tests_useless')], [4, 2, 1, 8, 2])
    const caught = SYNTHETIC_METRIC_RECORDS.filter((record) => record.name === 'orchon_synthetic.useless_tests_caught').map((record) => record.value)
    assert.deepEqual(caught, [1, 1, 0, 1])
  })

  test('ends with one record that redefines a name, so Archon reports a refusal', () => {
    const last = SYNTHETIC_METRIC_RECORDS.at(-1)
    const first = SYNTHETIC_METRIC_RECORDS.find((record) => record.name === last?.name)
    assert.notEqual(first, last)
    assert.notDeepEqual([first?.kind, first?.unit], [last?.kind, last?.unit])
  })

  test('declares overview cards that name only metrics it emits, a count in every counted slot (as Archon 0.14.0 checks its own pack)', () => {
    const files = syntheticPackFiles()
    const declaration = JSON.parse(files.find((file) => file.path === 'orchon-synthetic/.shared/metric-views.json')?.text ?? 'null') as {
      names: Record<string, string>
      cards: Record<string, unknown>[]
    }
    const kinds = new Map<string, { kind: unknown; calibrates: unknown }>()
    for (const record of SYNTHETIC_METRIC_RECORDS) if (!kinds.has(String(record.name))) kinds.set(String(record.name), { kind: record.kind, calibrates: record.calibrates })
    assert.deepEqual(Object.keys(declaration.names).filter((name) => !kinds.has(name)), [])
    assert.deepEqual(declaration.cards.map((card) => card.shape), ['count', 'ratio', 'cost_per'])
    const counted = declaration.cards.flatMap((card) => [
      card.metric,
      card.numerator,
      card.denominator,
      card.cost_of,
      ...((card.breakdown as { metric: string }[] | undefined) ?? []).map((item) => item.metric)
    ])
    assert.deepEqual(counted.filter((name) => name !== undefined && kinds.get(String(name))?.kind !== 'count'), [])
    const ratio = declaration.cards.find((card) => card.shape === 'ratio')
    const calibration = ratio?.calibration as { metric: string; rough_below: number } | undefined
    assert.deepEqual(kinds.get(calibration?.metric ?? ''), { kind: 'score', calibrates: ratio?.numerator })
    for (const title of declaration.cards.map((card) => String(card.title))) assert.match(title, /^Synthetic /)
  })

  test('writes the workflow, its declaration and one unreadable declaration, all inside the project workflow folder', () => {
    const files = syntheticPackFiles()
    assert.deepEqual(files.map((file) => file.path), [
      'orchon-recorder-synthetic-metrics.yaml',
      'orchon-synthetic/.shared/metric-views.json',
      'orchon-synthetic-unreadable/.shared/metric-views.json'
    ])
    assert.deepEqual(JSON.parse(files[0]?.text ?? ''), SYNTHETIC_METRICS)
    // Archon 0.14.0 requires one to six cards, so a declaration with none is listed under `errors`.
    assert.deepEqual(JSON.parse(files[2]?.text ?? ''), { cards: [] })
  })
})
