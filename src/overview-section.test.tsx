// The frame seam for the Overview cards: src/panel.tsx mounted on a scripted worker that answers
// the metrics read, the scope and the runs table, and posts the card titles as the worker does.
// These tests cover what Overview draws: the landing tab, each card shape, the pack headings and
// caps, the titles over skeletons before the report answers, and each card's Details link.
import { mock } from 'node:test'
import { afterEach, assert, beforeEach, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answeringMetrics, REPORT_END, SAMPLE_OVERVIEW, sampleReport } from '../scripts/metrics-samples.ts'
import type { MetricsRequest, MetricsView } from './metrics-view'
import type { OverviewPack, OverviewView } from './overview-view'
import * as panelModule from './panel'

let panel: TestPanel | undefined
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: REPORT_END })
})
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
  mock.timers.reset()
})

async function mountMetrics(metrics: (request: MetricsRequest) => MetricsView | Promise<MetricsView>): Promise<TestPanel> {
  panel = await mount(panelModule, { host: mockHost(answeringMetrics(metrics)), persisted: { workspace: { section: 'metrics' } } })
  return panel
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

const TABS = { type: 'Tabs', label: 'Metrics views' }

describe('the landing view', () => {
  test('the section opens on Overview, a grid of cards one column at 220 px and three at 480 px', async () => {
    const view = await mountMetrics(() => sampleReport())
    assert.equal(view.valueOf(TABS), 'overview')
    assert.equal(view.find({ type: 'Grid' })?.props.minItemWidth, 'sm')
    assert.deepEqual(
      view.findAll({ type: 'Card' }).map((card) => card.label),
      ['PRs merged', 'Useless tests', 'Cost per PR', 'Spread']
    )
    clean(view)
  })
})

const cardNamed = (view: TestPanel, title: string) => {
  const found = view.find({ type: 'Card', label: title })
  if (found === null) throw new Error(`No card ${title}.`)
  return found
}
/** Elements of one type inside a card. */
const inside = (view: TestPanel, title: string, type: string) => {
  const root = cardNamed(view, title)
  return view.findAll({ type }).filter((each) => each.path.startsWith(root.path) && each.path !== root.path)
}

describe('the cards', () => {
  test('a count: its figure as a level 2 heading and a muted breakdown line', async () => {
    const view = await mountMetrics(() => sampleReport())
    const [figure] = inside(view, 'PRs merged', 'Heading')
    assert.equal(figure?.props.level, 2)
    assert.equal(figure?.text, '12')
    assert.deepEqual(
      inside(view, 'PRs merged', 'Text').map((text) => [text.text, text.props.muted]),
      [['14 opened · 2 abandoned', true]]
    )
    assert.equal(inside(view, 'PRs merged', 'Progress').length, 0)
    clean(view)
  })

  test('a ratio: the share, a progress bar with its label hidden, and "5 of 13 new tests"', async () => {
    const view = await mountMetrics(() => sampleReport())
    assert.equal(inside(view, 'Useless tests', 'Heading')[0]?.text, '38%')
    const [bar] = inside(view, 'Useless tests', 'Progress')
    assert.deepEqual([bar?.props.label, bar?.props.labelHidden, bar?.props.value], ['Useless tests', true, 38])
    assert.ok(inside(view, 'Useless tests', 'Text').some((text) => text.text === '5 of 13 new tests'))
    clean(view)
  })

  test('a cost per item: "≥ $1.42" and its coverage line', async () => {
    const view = await mountMetrics(() => sampleReport())
    assert.equal(inside(view, 'Cost per PR', 'Heading')[0]?.text, '≥ $1.42')
    assert.ok(inside(view, 'Cost per PR', 'Text').some((text) => text.text === '8 of 10 runs record cost'))
    clean(view)
  })

  test('a card of an unknown shape keeps its place with its title and says it needs a newer Orchon, with no Details link', async () => {
    const view = await mountMetrics(() => sampleReport())
    assert.equal(cardNamed(view, 'Spread').text, 'Spread This card needs a newer version of Orchon.')
    assert.deepEqual(inside(view, 'Spread', 'Link'), [])
    assert.deepEqual(
      ['PRs merged', 'Useless tests', 'Cost per PR'].map((title) => inside(view, title, 'Link').map((link) => link.text)),
      [['Details'], ['Details'], ['Details']]
    )
    clean(view)
  })

  test('the states keep the console\'s words: "—" with "no records in this window", and "nothing counted"', async () => {
    const overview: OverviewView = {
      packs: [
        {
          key: 'bundled:sdlc',
          name: 'sdlc',
          more: 0,
          cards: [
            { id: 'count:a', title: 'PRs merged', kind: 'figure', shape: 'count', metric: 'sdlc.prs_merged', figure: '—', line: 'no records in this window' },
            { id: 'cost_per:a', title: 'Cost per PR', kind: 'figure', shape: 'cost_per', metric: 'sdlc.prs_merged', figure: '—', line: 'nothing counted' }
          ]
        }
      ],
      morePacks: 0
    }
    const view = await mountMetrics(() => sampleReport('7d', undefined, { overview }))
    assert.equal(cardNamed(view, 'PRs merged').text, 'PRs merged — no records in this window Details')
    assert.equal(cardNamed(view, 'Cost per PR').text, 'Cost per PR — nothing counted Details')
    clean(view)
  })
})

const pack = (name: string): OverviewPack => ({ ...(SAMPLE_OVERVIEW.packs[0] as OverviewPack), key: `bundled:${name}`, name })

describe('the packs', () => {
  test('one pack has no heading of its name', async () => {
    const view = await mountMetrics(() => sampleReport())
    assert.equal(view.find({ type: 'Heading', text: 'sdlc' }), null)
    clean(view)
  })

  test("with more than one pack each name is a heading, and past 10 packs a line says how many more are in Archon's console", async () => {
    const names = Array.from({ length: 10 }, (_, index) => `pack-${String(index)}`)
    const view = await mountMetrics(() => sampleReport('7d', undefined, { overview: { packs: names.map(pack), morePacks: 4 } }))
    assert.deepEqual(
      view
        .findAll({ type: 'Heading' })
        .filter((heading) => heading.props.level === 3 && heading.text.startsWith('pack-'))
        .map((heading) => heading.text),
      names
    )
    assert.ok(view.find({ text: "and 4 more in Archon's console" }))
    clean(view)
  })

  test('no pack declares cards: Overview says so with a link to Details, which opens Details', async () => {
    const view = await mountMetrics(() => sampleReport('7d', undefined, { overview: { packs: [], morePacks: 0 } }))
    assert.ok(view.find({ type: 'EmptyState', label: 'No pack declares overview cards.' }))
    await view.press({ type: 'Link', text: 'Details' })
    assert.equal(view.valueOf(TABS), 'details')
    assert.deepEqual(view.valueOf({ type: 'Table', label: 'Metrics' }), [])
    clean(view)
  })
})

describe("a card's Details link", () => {
  test('opens Details at the metric the card reads', async () => {
    const view = await mountMetrics(() => sampleReport())
    const [link] = inside(view, 'PRs merged', 'Link')
    assert.ok(link)
    await view.press(link)
    assert.equal(view.valueOf(TABS), 'details')
    assert.deepEqual(view.valueOf({ type: 'Table', label: 'Metrics' }), ['sdlc.prs_merged'])
    clean(view)
  })
})

/** Lets the panel draw what a post set off, without waiting for a request still held. */
const drawn = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('before the report answers', () => {
  test('the titles the worker posts for the scope and window show over skeletons, and the figures replace them', async () => {
    let release: (view: MetricsView) => void = () => {}
    const held = new Promise<MetricsView>((resolve) => (release = resolve))
    // The project's report shows first; "All projects" is then held, so its first report loads.
    const view = await mountMetrics((request) => (request.codebaseId === undefined ? held : sampleReport()))
    const selecting = view.select({ type: 'RadioGroup', label: 'Scope' }, 'all')
    await drawn()
    assert.ok(view.find({ type: 'Spinner', label: 'Loading metrics…' }))
    assert.equal(view.find({ type: 'Card' }), null)
    const pending: OverviewView = {
      packs: [{ key: 'bundled:sdlc', name: 'sdlc', more: 0, cards: [{ id: 'count:a', title: 'PRs merged', kind: 'pending', metric: 'sdlc.prs_merged' }] }],
      morePacks: 0
    }
    // A post settles only once the held read does, so the posts are not awaited.
    // Titles for another project or window are not this read's.
    void view.post('metrics.cards', { window: '30d', overview: pending })
    await drawn()
    assert.equal(view.find({ type: 'Card' }), null)
    void view.post('metrics.cards', { codebaseId: 'cb-web', window: '7d', overview: pending })
    await drawn()
    assert.equal(view.find({ type: 'Card' }), null)
    void view.post('metrics.cards', { window: '7d', overview: pending })
    await drawn()
    assert.deepEqual(
      view.findAll({ type: 'Card' }).map((card) => card.label),
      ['PRs merged']
    )
    assert.equal(inside(view, 'PRs merged', 'Skeleton')[0]?.props.label, 'Loading PRs merged')
    release(sampleReport())
    await selecting
    assert.equal(view.find({ type: 'Skeleton' }), null)
    assert.equal(inside(view, 'PRs merged', 'Heading')[0]?.text, '12')
    clean(view)
  })
})
