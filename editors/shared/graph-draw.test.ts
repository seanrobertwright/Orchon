// The frame seam for the shared graph drawing: a laid-out graph drawn as the plugin's own SVG into
// a stand-in DOM. These tests cover what is drawn: a box per step with its state in words, a frame
// per loop group, an edge along its routed points, dashed into a conditional step.
import { assert, describe, test } from 'orca/testing'
import { fakeDocument, find, findAll, markupWritten, withClass, type FakeElement } from '../../scripts/fake-dom.ts'
import { drawGraph, NAME_CAP, type DrawStep } from './graph-draw.ts'
import { layoutGraph, type LayoutStep } from './graph-layout.ts'

const layoutSteps: LayoutStep[] = [
  { id: 'forge', group: null, isGroup: false, conditional: false },
  { id: 'rounds', group: null, isGroup: true, conditional: false },
  { id: 'rounds.implement', group: 'rounds', isGroup: false, conditional: false },
  { id: 'rounds.pr', group: 'rounds', isGroup: false, conditional: true }
]
const edges = [
  { from: 'forge', to: 'rounds' },
  { from: 'rounds.implement', to: 'rounds.pr' }
]

const facts = (id: string, name: string, state: string, text: string, extra: Partial<DrawStep> = {}): [string, DrawStep] => [
  id,
  { name, kind: 'exec', state, stateText: text, note: null, ...extra }
]

const drawSteps = new Map<string, DrawStep>([
  facts('forge', 'forge', 'completed', '✓ Completed'),
  facts('rounds', 'rounds', 'running', '● Running', { kind: 'loop_group' }),
  facts('rounds.implement', 'implement', 'waiting', '‖ Waiting', { note: 'Answered in the Orchon panel.' }),
  facts('rounds.pr', '<b>pr</b>', 'not-reached', '○ Not reached')
])

function drawn(): { svg: FakeElement; laid: ReturnType<typeof layoutGraph> } {
  const doc = fakeDocument()
  const laid = layoutGraph(layoutSteps, edges)
  const svg = drawGraph(doc as unknown as Document, laid, drawSteps, { label: 'Steps of archon-deliver-block', idPrefix: 'g1' }) as unknown as FakeElement
  return { svg, laid }
}

describe('the graph drawing', () => {
  test('is an SVG sized to the layout and named for its workflow', () => {
    const { svg, laid } = drawn()
    assert.equal(svg.tagName, 'svg')
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg')
    assert.equal(svg.getAttribute('viewBox'), `0 0 ${String(laid.width)} ${String(laid.height)}`)
    assert.equal(svg.getAttribute('role'), 'group')
    assert.equal(svg.getAttribute('aria-label'), 'Steps of archon-deliver-block')
  })

  test('draws a box per step, its state as a glyph and a word as well as a colour, named for assistive technology', () => {
    const { svg } = drawn()
    const boxes = withClass(svg, 'step')
    assert.deepEqual(
      boxes.map((box) => box.getAttribute('aria-label')),
      ['forge, exec, ✓ Completed', 'implement, exec, ‖ Waiting', '<b>pr</b>, exec, ○ Not reached']
    )
    assert.deepEqual(
      boxes.map((box) => box.getAttribute('class')),
      ['step state-completed', 'step state-waiting', 'step state-not-reached']
    )
    const waiting = boxes[1]
    assert.ok(waiting !== undefined)
    assert.match(waiting.textContent, /implement/)
    assert.match(waiting.textContent, /‖ Waiting/)
    assert.match(waiting.textContent, /Answered in the Orchon panel\./)
  })

  test('a step is a focusable button that names its step, and a collapsed loop group says how many steps it holds', () => {
    const doc = fakeDocument()
    const laid = layoutGraph([{ id: 'rounds', group: null, isGroup: true, conditional: false }, layoutSteps[0] as LayoutStep], [])
    const steps = new Map([facts('forge', 'forge', 'completed', '✓ Completed'), facts('rounds', 'rounds', 'running', '● Running', { kind: 'loop_group', holds: 3 })])
    const svg = drawGraph(doc as unknown as Document, laid, steps, { label: 'g', idPrefix: 'g3' }) as unknown as FakeElement
    const boxes = withClass(svg, 'step')
    for (const box of boxes) {
      assert.equal(box.getAttribute('role'), 'button')
      assert.equal(box.getAttribute('tabindex'), '0')
    }
    assert.deepEqual(boxes.map((box) => box.getAttribute('data-step')), ['rounds', 'forge'])
    const rounds = boxes[0]
    assert.equal(rounds?.getAttribute('aria-label'), 'rounds, loop_group, ● Running, holds 3 steps')
    assert.match(rounds?.textContent ?? '', /Holds 3 steps/)
  })

  test("sets Archon's text as text, never as markup", () => {
    const { svg } = drawn()
    assert.ok(find(svg, (element) => element.tagName === 'text' && element.textContent === '<b>pr</b>'))
    assert.equal(markupWritten(svg), false)
  })

  test('cuts a long name on the box and keeps the whole name in its label and title', () => {
    const doc = fakeDocument()
    const long = 'a'.repeat(NAME_CAP + 10)
    const laid = layoutGraph([{ id: 'x', group: null, isGroup: false, conditional: false }], [])
    const svg = drawGraph(doc as unknown as Document, laid, new Map([facts('x', long, 'completed', '✓ Completed')]), { label: 'g', idPrefix: 'g2' }) as unknown as FakeElement
    const [box] = withClass(svg, 'step')
    assert.ok(box !== undefined)
    assert.ok(find(box, (element) => element.tagName === 'text' && element.textContent === `${'a'.repeat(NAME_CAP - 1)}…`))
    assert.equal(find(box, (element) => element.tagName === 'title')?.textContent, long)
    assert.equal(box.getAttribute('aria-label'), `${long}, exec, ✓ Completed`)
  })

  test('frames a loop group with its name', () => {
    const { svg } = drawn()
    const [group] = withClass(svg, 'group')
    assert.ok(group !== undefined)
    assert.ok(find(group, (element) => element.tagName === 'rect'))
    assert.match(group.textContent, /rounds/)
  })

  test("draws each edge along dagre's routed points, dashed into a conditional step, with an arrowhead of this drawing's own id", () => {
    const { svg, laid } = drawn()
    const paths = withClass(svg, 'edge')
    assert.equal(paths.length, laid.edges.length)
    laid.edges.forEach((edge, index) => {
      const path = paths[index]
      assert.ok(path !== undefined)
      const expected = edge.points.map((point, at) => `${at === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`).join(' ')
      assert.equal(path.getAttribute('d'), expected)
      assert.equal((path.getAttribute('class') ?? '').includes('dashed'), edge.to === 'rounds.pr')
      assert.equal(path.getAttribute('marker-end'), 'url(#g1-arrow)')
    })
    assert.equal(findAll(svg, (element) => element.id === 'g1-arrow').length, 1)
  })
})

describe('a read-only step', () => {
  test('is marked by its class, a lock glyph and a "read-only" line, and is named read-only', () => {
    const doc = fakeDocument()
    const laid = layoutGraph([{ id: 'odd', group: null, isGroup: false, conditional: false }], [])
    const steps = new Map<string, DrawStep>([['odd', { name: 'odd', kind: 'include', state: 'draft', stateText: 'include', note: null, readOnly: true }]])
    const svg = drawGraph(doc as unknown as Document, laid, steps, { label: 'Nodes of x', idPrefix: 'g2' }) as unknown as FakeElement
    const [box] = withClass(svg, 'step')
    assert.equal(box?.getAttribute('class'), 'step state-draft read-only')
    assert.equal(box?.getAttribute('aria-label'), 'odd, include, read-only')
    const texts = findAll(svg, (element) => element.tagName === 'text').map((element) => element.textContent)
    assert.deepEqual(texts, ['odd', '🔒 include', 'read-only'])
  })
})
