// The worker's request protocol seam for the Overview cards: the worker mounted on a scripted
// Archon that replays the recorded 0.14.0 metrics answers, and a stand-in Orca host. These tests
// cover the order of the reads, the titles posted before the report answers, the finished cards
// the read answers, and what the worker logs of what it does not know.
//
// The spend-mode recording (`fixtures/0.14.0/spend/metrics/metrics.json`) is SYNTHETIC: every
// record and every `orchon-synthetic` card in it was made up by the recorder's own pack. It
// measures nothing.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  HANG,
  health,
  json,
  METRICS_AT as AT,
  METRICS_PROJECT as PROJECT,
  METRICS_SPEND as SPEND,
  recorded,
  scene,
  settle,
  type MountedScene,
  type Scene
} from '../scripts/scripted-archon.ts'
import type { MetricsAnswer, MetricsView } from './metrics-view'
import type { MetricsCardsPost } from './overview-view'

const VIEWS = `${DEFAULT}/api/metric-views`
const PROJECT_VIEWS = `${VIEWS}?codebaseId=${PROJECT}`
const report = (since: string, codebaseId?: string): string =>
  `${DEFAULT}/api/metrics?since=${since}${codebaseId === undefined ? '' : `&codebaseId=${codebaseId}`}`

function metricsScene(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
  stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
  return stage
}

async function read(mounted: MountedScene, input: Record<string, unknown> = {}): Promise<MetricsAnswer> {
  return (await mounted.worker.request('metrics.read', input)) as MetricsAnswer
}
const ready = (view: MetricsView): Extract<MetricsView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The metrics view is ${view.kind}.`)
  return view
}
const cardPosts = (mounted: MountedScene): MetricsCardsPost[] =>
  mounted.worker.posts.filter((post) => post.event === 'metrics.cards').map((post) => post.payload as MetricsCardsPost)
const metricCalls = (stage: Scene): string[] => stage.archon.calls.filter((call) => call.url.includes('/api/metric')).map((call) => call.url)

describe('under "This project"', () => {
  test('the declarations are read first with the project id, their titles are posted before the report answers, and the read answers the finished cards', async () => {
    const stage = metricsScene()
    stage.archon.answer(PROJECT_VIEWS, recorded('0.14.0', SPEND, AT.projectViews))
    stage.archon.answer(report('7d', PROJECT), HANG)
    const mounted = await stage.mount({ storage: {} })
    void read(mounted, { codebaseId: PROJECT })
    await settle()
    assert.deepEqual(metricCalls(stage), [PROJECT_VIEWS, report('7d', PROJECT)])
    const [posted] = cardPosts(mounted)
    assert.equal(cardPosts(mounted).length, 1)
    assert.equal(posted?.codebaseId, PROJECT)
    assert.equal(posted?.window, '7d')
    assert.deepEqual(
      posted?.overview.packs.map((pack) => [pack.name, pack.cards.map((card) => [card.kind, card.title])]),
      [
        [
          'sdlc',
          [
            ['pending', 'PRs merged'],
            ['pending', 'Useless tests'],
            ['pending', 'Cost per PR']
          ]
        ],
        [
          'orchon-synthetic',
          [
            ['pending', 'Synthetic items merged'],
            ['pending', 'Synthetic useless tests'],
            ['pending', 'Synthetic cost per item']
          ]
        ]
      ]
    )
    await mounted.worker.deactivate()

    // Only the year was recorded for the project, so it stands in for the project's week.
    const again = metricsScene()
    again.archon.answer(PROJECT_VIEWS, recorded('0.14.0', SPEND, AT.projectViews))
    again.archon.answer(report('7d', PROJECT), recorded('0.14.0', SPEND, AT.projectYear))
    const answered = await again.mount({ storage: {} })
    const view = ready((await read(answered, { codebaseId: PROJECT })).metrics)
    const synthetic = view.overview.packs[1]
    assert.deepEqual(
      synthetic?.cards.map((card) => (card.kind === 'figure' ? [card.title, card.figure, card.line] : card.kind)),
      [
        ['Synthetic items merged', '2', '4 opened · 1 abandoned'],
        ['Synthetic useless tests', '25%', '2 of 8 new tests'],
        ['Synthetic cost per item', '—', '0 of 1 runs record cost']
      ]
    )
    await answered.worker.deactivate()
  })
})

describe('the declarations', () => {
  test('wait 10 seconds, then read as a timeout; the report is not asked and nothing is sent again', async () => {
    const stage = metricsScene()
    stage.archon.answer(VIEWS, HANG)
    stage.archon.answer(report('7d'), recorded('0.14.0', SPEND, AT.week))
    const mounted = await stage.mount({ storage: {} })
    const answers: MetricsAnswer[] = []
    void read(mounted).then((value) => answers.push(value))
    await stage.clock.advance(10_000 - 1)
    assert.equal(answers.length, 0)
    await stage.clock.advance(1)
    assert.deepEqual(answers[0]?.metrics, { kind: 'timeout' })
    await stage.clock.advance(120_000)
    assert.deepEqual(metricCalls(stage), [VIEWS])
    assert.deepEqual(cardPosts(mounted), [])
    await mounted.worker.deactivate()
  })

  test('a known shape missing a field it needs makes the whole answer unreadable, and no titles are posted', async () => {
    const views = recorded('0.14.0', SPEND, AT.projectViews)
    if (views.kind !== 'json') throw new Error('The recorded declarations are not JSON.')
    const changed = structuredClone(views.value) as { packs: { cards: Record<string, unknown>[] }[] }
    delete changed.packs[1]?.cards[1]?.denominator
    const stage = metricsScene()
    stage.archon.answer(PROJECT_VIEWS, json(changed))
    stage.archon.answer(report('7d', PROJECT), recorded('0.14.0', SPEND, AT.projectYear))
    const mounted = await stage.mount({ storage: {} })
    assert.deepEqual((await read(mounted, { codebaseId: PROJECT })).metrics, { kind: 'unreadable' })
    assert.deepEqual(cardPosts(mounted), [])
    assert.deepEqual(metricCalls(stage), [PROJECT_VIEWS])
    await mounted.worker.deactivate()
  })
})

describe('under "All projects"', () => {
  test("the project's own pack declares no cards here, as expected: only the bundled pack's cards, without records in the synthetic week", async () => {
    const stage = metricsScene()
    stage.archon.answer(VIEWS, recorded('0.14.0', SPEND, AT.views))
    stage.archon.answer(report('7d'), recorded('0.14.0', SPEND, AT.week))
    const mounted = await stage.mount({ storage: {} })
    const view = ready((await read(mounted)).metrics)
    assert.deepEqual(
      view.overview.packs.map((pack) => [pack.name, pack.cards.map((card) => (card.kind === 'figure' ? [card.title, card.figure, card.line] : card.kind))]),
      [
        [
          'sdlc',
          [
            ['PRs merged', '—', 'no records in this window'],
            ['Useless tests', '—', 'no records in this window'],
            ['Cost per PR', '—', 'no records in this window']
          ]
        ]
      ]
    )
    assert.equal(cardPosts(mounted)[0]?.codebaseId, undefined)
    await mounted.worker.deactivate()
  })

  test('the recorded empty install: the bundled pack declares cards and no metric has records', async () => {
    const stage = metricsScene()
    stage.archon.answer(VIEWS, recorded('0.14.0', 'metrics', 0))
    stage.archon.answer(report('7d'), recorded('0.14.0', 'metrics', 1))
    const mounted = await stage.mount({ storage: {} })
    const view = ready((await read(mounted)).metrics)
    assert.deepEqual(
      view.overview.packs.flatMap((pack) => pack.cards.map((card) => (card.kind === 'figure' ? card.line : card.kind))),
      ['no records in this window', 'no records in this window', 'no records in this window']
    )
    await mounted.worker.deactivate()
  })
})

describe('what Orchon does not know', () => {
  test('the worker logs how many cards of an unknown shape and metrics of an unknown kind it saw, and sends that nowhere', async () => {
    const views = recorded('0.14.0', SPEND, AT.projectViews)
    const week = recorded('0.14.0', SPEND, AT.projectYear)
    if (views.kind !== 'json' || week.kind !== 'json') throw new Error('The recorded answers are not JSON.')
    const declared = structuredClone(views.value) as { packs: { cards: Record<string, unknown>[] }[] }
    declared.packs[1]?.cards.push({ shape: 'histogram', title: 'Synthetic spread' }, { shape: 'sparkline', title: 'Synthetic trend' })
    const body = structuredClone(week.value) as { metrics: Record<string, unknown>[] }
    body.metrics.push({ name: 'orchon_synthetic.a_histogram', kind: 'histogram', calibrates: null })
    const stage = metricsScene()
    stage.archon.answer(PROJECT_VIEWS, json(declared))
    stage.archon.answer(report('7d', PROJECT), json(body))
    const mounted = await stage.mount({ storage: {} })
    const answer = await read(mounted, { codebaseId: PROJECT })
    const line = 'Orchon saw 2 overview cards of a shape and 1 metrics of a kind it does not know.'
    assert.deepEqual(
      mounted.worker.logs.filter((each) => each.includes('does not know')),
      [line]
    )
    assert.ok(!JSON.stringify(answer).includes('does not know'))
    assert.ok(!JSON.stringify(mounted.worker.posts).includes('does not know'))
    assert.ok(!stage.archon.calls.some((call) => call.method !== 'GET'))
    const cards = ready(answer.metrics).overview.packs[1]?.cards
    assert.deepEqual(cards?.slice(3).map((card) => [card.kind, card.title]), [
      ['unknown-shape', 'Synthetic spread'],
      ['unknown-shape', 'Synthetic trend']
    ])
    await mounted.worker.deactivate()
  })
})
