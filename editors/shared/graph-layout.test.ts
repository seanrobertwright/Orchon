// Pure logic: the graph layout on dagre's copied build. It places every step, frames each loop
// group around its own steps, routes each edge along dagre's points, attaches an edge to a loop
// group at its first or last steps, and dashes an edge into a conditional step.
import { assert, describe, test } from 'orca/testing'
import { layoutGraph, layoutInOrder, STEP_HEIGHT, STEP_WIDTH, type LayoutStep } from './graph-layout.ts'

const step = (id: string, extra: Partial<LayoutStep> = {}): LayoutStep => ({ id, group: null, isGroup: false, conditional: false, ...extra })

/** forge → rounds (implement → pr → review) → report, with pr behind a `when`. */
const steps: LayoutStep[] = [
  step('forge'),
  step('rounds', { isGroup: true }),
  step('rounds.implement', { group: 'rounds' }),
  step('rounds.pr', { group: 'rounds', conditional: true }),
  step('rounds.review', { group: 'rounds' }),
  step('report', { conditional: true })
]
const edges = [
  { from: 'forge', to: 'rounds' },
  { from: 'rounds.implement', to: 'rounds.pr' },
  { from: 'rounds.pr', to: 'rounds.review' },
  { from: 'rounds', to: 'report' }
]

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('the graph layout', () => {
  test('places every step that is not a group as a box of the step size, none on another', () => {
    const laid = layoutGraph(steps, edges, 'TB')
    assert.deepEqual(laid.steps.map((box) => box.id).sort(), ['forge', 'report', 'rounds.implement', 'rounds.pr', 'rounds.review'])
    for (const box of laid.steps) assert.deepEqual([box.width, box.height], [STEP_WIDTH, STEP_HEIGHT])
    for (const a of laid.steps) for (const b of laid.steps) if (a !== b) assert.ok(!overlap(a, b), `${a.id} lies on ${b.id}`)
    for (const box of laid.steps) assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= laid.width && box.y + box.height <= laid.height)
  })

  test('frames a loop group around its own steps', () => {
    const laid = layoutGraph(steps, edges, 'TB')
    const [group] = laid.groups
    assert.equal(group?.id, 'rounds')
    for (const id of ['rounds.implement', 'rounds.pr', 'rounds.review']) {
      const box = laid.steps.find((one) => one.id === id)
      assert.ok(group !== undefined && box !== undefined)
      assert.ok(box.x >= group.x && box.y >= group.y && box.x + box.width <= group.x + group.width && box.y + box.height <= group.y + group.height, id)
    }
  })

  test("an edge into a loop group attaches to its first steps and an edge out of it leaves from its last; dagre's routed points are kept", () => {
    const laid = layoutGraph(steps, edges, 'TB')
    assert.deepEqual(
      laid.edges.map((edge) => `${edge.from} → ${edge.to}`),
      ['forge → rounds.implement', 'rounds.implement → rounds.pr', 'rounds.pr → rounds.review', 'rounds.review → report']
    )
    for (const edge of laid.edges) {
      assert.ok(edge.points.length >= 2, `${edge.from} → ${edge.to} has no route`)
      for (const point of edge.points) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
    }
    // Top to bottom: each edge starts above where it ends.
    const forge = laid.edges[0]
    assert.ok(forge !== undefined && (forge.points[0]?.y ?? 0) < (forge.points.at(-1)?.y ?? 0))
  })

  test('an edge into a conditional step is dashed, and only such an edge', () => {
    const laid = layoutGraph(steps, edges, 'TB')
    assert.deepEqual(
      laid.edges.filter((edge) => edge.dashed).map((edge) => edge.to),
      ['rounds.pr', 'report']
    )
  })

  test('an edge into a conditional loop group is dashed at each of its first steps', () => {
    const conditionalGroup = steps.map((one) => (one.id === 'rounds' ? { ...one, conditional: true } : one))
    const laid = layoutGraph(conditionalGroup, edges, 'TB')
    assert.equal(laid.edges.find((edge) => edge.from === 'forge')?.dashed, true)
  })

  test('an empty loop group is drawn as a step, so an edge to it still has an end', () => {
    const laid = layoutGraph([step('a'), step('empty', { isGroup: true })], [{ from: 'a', to: 'empty' }], 'LR')
    assert.deepEqual(laid.steps.map((box) => box.id).sort(), ['a', 'empty'])
    assert.deepEqual(laid.groups, [])
    assert.deepEqual(laid.edges.map((edge) => `${edge.from} → ${edge.to}`), ['a → empty'])
  })

  test('an edge to a step it does not know is left out', () => {
    const laid = layoutGraph([step('a')], [{ from: 'a', to: 'nowhere' }], 'TB')
    assert.deepEqual(laid.edges, [])
  })
})

describe('the layout in run order', () => {
  test('places the steps one under another in the order given, with no edges', () => {
    const laid = layoutInOrder(['c', 'a', 'b'])
    assert.deepEqual(laid.steps.map((box) => box.id), ['c', 'a', 'b'])
    const [first, second, third] = laid.steps
    assert.ok(first !== undefined && second !== undefined && third !== undefined)
    assert.ok(first.y + first.height < second.y && second.y + second.height < third.y)
    assert.deepEqual(laid.edges, [])
    assert.deepEqual(laid.groups, [])
  })
})
