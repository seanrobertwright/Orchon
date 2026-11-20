// The pure-logic seam for the Overview cards: the recorded card declarations and reports of
// Archon 0.14.0, read and finished into the view model the panel draws. The expected figures
// were worked by hand from the console's rules (`countCard`, `ratioCard` and `costPerCard` in
// `packages/web/src/experiments/console/routes/metrics/model.ts` of Archon at commit
// 8def159a6b2c23e832a5283b4131cfffd9af9344), not from this module.
//
// The spend-mode recording (`fixtures/0.14.0/spend/metrics/metrics.json`) is SYNTHETIC: every
// record and every `orchon-synthetic` card in it was made up by the recorder's own pack. It
// measures nothing.
import { assert, describe, test } from 'orca/testing'
import { METRICS_AT as AT, METRICS_SPEND as SPEND, recorded } from '../scripts/scripted-archon.ts'
import { parseNames, parseReport } from './metrics'
import { cardReportOf, overviewOf, parseCardDeclarations } from './overview-cards'

type Body = Record<string, unknown>
function body(scenario: string, index: number): Body {
  const answer = recorded('0.14.0', scenario, index)
  if (answer.kind !== 'json') throw new Error(`The recorded answer ${String(index)} is not JSON.`)
  return structuredClone(answer.value) as Body
}

function declarations(value: unknown) {
  const parsed = parseCardDeclarations(value)
  if (parsed === null) throw new Error('The declarations could not be read.')
  return parsed
}
function report(value: unknown) {
  const parsed = parseReport(value)
  if (parsed === null) throw new Error('The report could not be read.')
  return cardReportOf(parsed)
}

const NONE = { figure: '—', line: 'no records in this window' }

describe('the recorded project declarations and report', () => {
  test("each pack's cards by the console's rules: the bundled pack has no records, the synthetic pack's count, ratio and withheld cost", () => {
    const overview = overviewOf(declarations(body(SPEND, AT.projectViews)), report(body(SPEND, AT.projectYear)), new Map())
    assert.equal(overview.morePacks, 0)
    assert.deepEqual(
      overview.packs.map((pack) => [pack.key, pack.name, pack.more]),
      [
        ['bundled:sdlc', 'sdlc', 0],
        ['project:orchon-synthetic', 'orchon-synthetic', 0]
      ]
    )
    const [sdlc, synthetic] = overview.packs
    assert.deepEqual(
      sdlc?.cards.map((card) => (card.kind === 'figure' ? [card.title, card.shape, card.metric, card.figure, card.line, card.percent] : card)),
      [
        ['PRs merged', 'count', 'sdlc.prs_merged', NONE.figure, NONE.line, undefined],
        ['Useless tests', 'ratio', 'sdlc.tests_unprotective', NONE.figure, NONE.line, undefined],
        ['Cost per PR', 'cost_per', 'sdlc.prs_merged', NONE.figure, NONE.line, undefined]
      ]
    )
    assert.deepEqual(
      synthetic?.cards.map((card) => (card.kind === 'figure' ? [card.title, card.shape, card.metric, card.figure, card.line, card.percent] : card)),
      [
        // 2 merged; the breakdown reads opened 4 and abandoned 1 at the same identity.
        ['Synthetic items merged', 'count', 'orchon_synthetic.items_merged', '2', '4 opened · 1 abandoned', undefined],
        // 2 useless of 8 added is 25%.
        ['Synthetic useless tests', 'ratio', 'orchon_synthetic.tests_useless', '25%', '2 of 8 new tests', 25],
        // The one run that opened the items recorded no cost, so no figure per item is given.
        ['Synthetic cost per item', 'cost_per', 'orchon_synthetic.items_merged', '—', '0 of 1 runs record cost', undefined]
      ]
    )
  })
})

/** The recorded week for "All projects", as a value a test can change. */
const week = (): Body => body(SPEND, AT.week)
const weekMetric = (value: Body, name: string): Body => {
  const found = (value.metrics as Body[]).find((metric) => metric.name === `orchon_synthetic.${name}`)
  if (found === undefined) throw new Error(`The recorded week has no ${name}.`)
  return found
}
const headlineOf = (metric: Body): Body => (metric.instruments as Body[])[0] as Body

/** The synthetic pack's cards, by title, over a report changed by `change`. */
function syntheticCards(change: (report: Body) => void = () => {}): Map<string, unknown> {
  const value = week()
  change(value)
  const project = declarations(body(SPEND, AT.projectViews))
  const pack = overviewOf(project, report(value), parseNames(body(SPEND, AT.projectViews)) ?? new Map()).packs[1]
  return new Map(pack?.cards.map((card) => [card.title, card.kind === 'figure' ? [card.figure, card.line, card.percent] : card.kind]))
}

describe("the console's rules", () => {
  test('a breakdown metric with no records at the main figure\'s judge version reads "no records of" and its plain name', () => {
    const cards = syntheticCards((value) => {
      weekMetric(value, 'items_abandoned').headline_instrument = 'judge-v2'
      headlineOf(weekMetric(value, 'items_abandoned')).instrument = 'judge-v2'
    })
    assert.deepEqual(cards.get('Synthetic items merged'), ['2', '4 opened · no records of Synthetic items abandoned', undefined])
  })
})

describe('a cost per item', () => {
  const costs = (usd: number | null, runs: number, runsWithoutCost: number) => (value: Body) => {
    const cost = headlineOf(weekMetric(value, 'items_opened')).cost as Body
    Object.assign(cost, { usd, runs, runs_without_cost: runsWithoutCost })
  }

  test('is withheld when half of the producing runs recorded a cost, and the coverage line still shows', () => {
    assert.deepEqual(syntheticCards(costs(2.84, 4, 2)).get('Synthetic cost per item'), ['—', '2 of 4 runs record cost', undefined])
  })

  test('is the known cost of the producing runs over the items counted when more than half recorded one', () => {
    // 2.84 over the 2 items merged is 1.42.
    assert.deepEqual(syntheticCards(costs(2.84, 3, 1)).get('Synthetic cost per item'), ['≥ $1.42', '2 of 3 runs record cost', undefined])
  })

  test('reads "nothing counted" when the counted metric is 0', () => {
    const cards = syntheticCards((value) => (headlineOf(weekMetric(value, 'items_merged')).value = 0))
    assert.deepEqual(cards.get('Synthetic cost per item'), ['—', 'nothing counted', undefined])
  })

  test('reads "no records in this window" when the metric whose runs carry the cost has no records', () => {
    const cards = syntheticCards((value) => (value.metrics = (value.metrics as Body[]).filter((metric) => metric.name !== 'orchon_synthetic.items_opened')))
    assert.deepEqual(cards.get('Synthetic cost per item'), ['—', 'no records in this window', undefined])
  })
})

describe('a ratio', () => {
  test('with a denominator of 0 shows no share and no bar, and the denominator', () => {
    const cards = syntheticCards((value) => (headlineOf(weekMetric(value, 'tests_added')).value = 0))
    assert.deepEqual(cards.get('Synthetic useless tests'), ['—', '0 new tests', undefined])
  })

  test('past 100% draws a full bar, and a small share keeps two significant digits', () => {
    const over = syntheticCards((value) => (headlineOf(weekMetric(value, 'tests_useless')).value = 12))
    assert.deepEqual(over.get('Synthetic useless tests'), ['150%', '12 of 8 new tests', 100])
    const small = syntheticCards((value) => (headlineOf(weekMetric(value, 'tests_added')).value = 1000))
    assert.deepEqual(small.get('Synthetic useless tests'), ['0.2%', '2 of 1,000 new tests', 0])
  })
})

describe('what Orchon does not know', () => {
  test('a metric of an unknown kind is left out of every card: a card reading it has no records', () => {
    const cards = syntheticCards((value) => (weekMetric(value, 'items_merged').kind = 'histogram'))
    assert.deepEqual(cards.get('Synthetic items merged'), ['—', 'no records in this window', undefined])
    assert.deepEqual(cards.get('Synthetic cost per item'), ['—', 'no records in this window', undefined])
    const value = week()
    weekMetric(value, 'items_merged').kind = 'histogram'
    assert.equal(report(value).unknownKinds, 1)
  })

  test('a score is never counted, though it is a kind Orchon knows', () => {
    const cards = syntheticCards((value) => (weekMetric(value, 'tests_useless').kind = 'score'))
    assert.deepEqual(cards.get('Synthetic useless tests'), ['—', 'no records in this window', undefined])
  })

  test('a card of an unknown shape keeps its place with its title, and its other fields are not read', () => {
    const views = body(SPEND, AT.projectViews)
    const synthetic = (views.packs as Body[])[1] as Body
    ;(synthetic.cards as Body[]).splice(1, 0, { shape: 'histogram', title: 'Synthetic spread', bins: 'many' })
    const read = declarations(views)
    assert.equal(read.unknownShapes, 1)
    const cards = overviewOf(read, report(week()), new Map()).packs[1]?.cards
    assert.deepEqual(
      cards?.map((card) => [card.kind, card.title]),
      [
        ['figure', 'Synthetic items merged'],
        ['unknown-shape', 'Synthetic spread'],
        ['figure', 'Synthetic useless tests'],
        ['figure', 'Synthetic cost per item']
      ]
    )
  })
})

describe("the declarations' validator", () => {
  const unreadable: [string, (views: Body) => void][] = [
    ['no list of packs', (views) => delete views.packs],
    ['a pack without its name', (views) => delete ((views.packs as Body[])[1] as Body).pack],
    ['a pack without a list of cards', (views) => delete ((views.packs as Body[])[1] as Body).cards],
    ['a count card without its metric', (views) => delete (((views.packs as Body[])[1] as Body).cards as Body[])[0]!.metric],
    ['a ratio card whose numerator is not a metric name', (views) => ((((views.packs as Body[])[1] as Body).cards as Body[])[1]!.numerator = 'Useless tests')],
    ['a card of any shape without its title', (views) => ((((views.packs as Body[])[1] as Body).cards as Body[])[2]!.title = '')]
  ]
  for (const [what, change] of unreadable) {
    test(`${what} makes the whole answer unreadable`, () => {
      const views = body(SPEND, AT.projectViews)
      change(views)
      assert.equal(parseCardDeclarations(views), null)
    })
  }
})

describe('the caps', () => {
  test('at most 10 packs that declare cards, packs without cards left out, and how many more there are', () => {
    const views = body(SPEND, AT.projectViews)
    const [sdlc] = views.packs as Body[]
    views.packs = [
      { ...sdlc, pack: 'empty', cards: [] },
      ...Array.from({ length: 13 }, (_, index) => ({ ...sdlc, pack: `pack-${String(index).padStart(2, '0')}` }))
    ]
    const overview = overviewOf(declarations(views), report(week()), new Map())
    assert.equal(overview.packs.length, 10)
    assert.equal(overview.packs[0]?.name, 'pack-00')
    assert.equal(overview.morePacks, 3)
  })

  test("at most 6 cards a pack, Archon's own cap on a pack file, with how many more, and each card's id unique", () => {
    const views = body(SPEND, AT.projectViews)
    const synthetic = (views.packs as Body[])[1] as Body
    const cards = synthetic.cards as Body[]
    synthetic.cards = [...cards, ...cards, ...cards]
    const pack = overviewOf(declarations(views), report(week()), new Map()).packs[1]
    assert.equal(pack?.cards.length, 6)
    assert.equal(pack?.more, 3)
    assert.equal(new Set(pack?.cards.map((card) => card.id)).size, 6)
  })
})
