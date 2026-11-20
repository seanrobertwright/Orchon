// The worker's request protocol seam: the worker mounted on a scripted Archon that replays the
// recorded 0.14.0 metrics answers. These tests cover the refusals and the packs whose card
// declarations could not be read, as `metrics.read` answers them: the console's words, the caps
// and Archon's free text cut at 500 characters.
//
// The spend-mode recording (`fixtures/0.14.0/spend/metrics/metrics.json`) is SYNTHETIC: every
// record in it, its one `definition_conflict` refusal and its unreadable pack
// `orchon-synthetic-unreadable` were made up by the recorder's own pack. They measure nothing.
import { assert, describe, test } from 'orca/testing'
import {
  DEFAULT,
  DEFAULT_HEALTH,
  DEFAULT_OPENAPI,
  health,
  json,
  METRICS_AT as AT,
  METRICS_PROJECT as PROJECT,
  METRICS_SPEND as SPEND,
  recorded,
  scene,
  type Scene
} from '../scripts/scripted-archon.ts'
import type { MetricsAnswer, MetricsView } from './metrics-view'

const VIEWS = `${DEFAULT}/api/metric-views`
const WEEK = `${DEFAULT}/api/metrics?since=7d`
const PROJECT_VIEWS = `${VIEWS}?codebaseId=${PROJECT}`
const PROJECT_WEEK = `${WEEK}&codebaseId=${PROJECT}`

function metricsScene(): Scene {
  const stage = scene()
  stage.archon.answer(DEFAULT_HEALTH, health({ version: '0.14.0' }))
  stage.archon.answer(DEFAULT_OPENAPI, recorded('0.14.0', 'openapi'))
  return stage
}

/** A recorded answer of the spend recording, as a value a test can change. */
function body(index: number): Record<string, unknown> {
  const answer = recorded('0.14.0', SPEND, index)
  if (answer.kind !== 'json') throw new Error(`The recorded answer ${String(index)} is not JSON.`)
  return structuredClone(answer.value) as Record<string, unknown>
}

/** The recorded project, its declarations and its year standing in for its week, with changes. */
async function readProject(change: { views?: (views: Record<string, unknown>) => void; week?: (week: Record<string, unknown>) => void } = {}) {
  const views = body(AT.projectViews)
  const week = body(AT.projectYear)
  change.views?.(views)
  change.week?.(week)
  const stage = metricsScene()
  stage.archon.answer(PROJECT_VIEWS, json(views))
  stage.archon.answer(PROJECT_WEEK, json(week))
  const mounted = await stage.mount({ storage: {} })
  const answer = (await mounted.worker.request('metrics.read', { codebaseId: PROJECT })) as MetricsAnswer
  await mounted.worker.deactivate()
  return ready(answer.metrics)
}

const ready = (view: MetricsView): Extract<MetricsView, { kind: 'ready' }> => {
  if (view.kind !== 'ready') throw new Error(`The metrics view is ${view.kind}.`)
  return view
}

const RECORDED_ERROR = '.shared/metric-views.json is invalid: cards: Too small: expected array to have >=1 items'

describe('the packs whose card declarations could not be read', () => {
  test("the recorded unreadable pack is answered with its name, its source and Archon's message", async () => {
    const view = await readProject()
    assert.deepEqual(view.unreadablePacks, [
      { key: 'project:orchon-synthetic-unreadable', pack: 'orchon-synthetic-unreadable', source: 'project', message: RECORDED_ERROR }
    ])
    assert.equal(view.moreUnreadablePacks, 0)
  })
})

describe('the caps and the cut', () => {
  test('at most 10 packs are listed in Archon\'s order, with how many more, and a message is cut at 500 characters', async () => {
    const long = 'm'.repeat(600)
    const view = await readProject({
      views: (views) => {
        const [recordedPack] = views.errors as Record<string, unknown>[]
        views.errors = Array.from({ length: 12 }, (_, at) => ({ ...recordedPack, pack: `pack-${String(at)}`, error: long }))
      }
    })
    assert.deepEqual(
      view.unreadablePacks.map((pack) => pack.pack),
      Array.from({ length: 10 }, (_, at) => `pack-${String(at)}`)
    )
    assert.equal(view.moreUnreadablePacks, 2)
    assert.equal(view.unreadablePacks[0]?.message, 'm'.repeat(500))
  })

  test('a declarations answer whose list of unreadable packs is not a list cannot be read', async () => {
    const stage = metricsScene()
    const views = body(AT.projectViews)
    views.errors = 'none'
    stage.archon.answer(PROJECT_VIEWS, json(views))
    const mounted = await stage.mount({ storage: {} })
    const answer = (await mounted.worker.request('metrics.read', { codebaseId: PROJECT })) as MetricsAnswer
    assert.deepEqual(answer.metrics, { kind: 'unreadable' })
    await mounted.worker.deactivate()
  })

  test('a refusal of invalid records reads "emitted invalid records:" and Archon\'s messages, joined and cut at 500 characters', async () => {
    const view = await readProject({
      week: (week) => {
        const [refusal] = week.refused as Record<string, unknown>[]
        week.refused = [
          { reason: 'invalid', run_id: refusal?.run_id, workflow_name: 'wf', node_id: 'score', completed_at: refusal?.completed_at, errors: ['value: expected number', 'unit: required'] },
          { reason: 'invalid', run_id: refusal?.run_id, workflow_name: 'wf', node_id: 'score', completed_at: refusal?.completed_at, errors: ['e'.repeat(600)] }
        ]
      }
    })
    assert.deepEqual(
      view.refused.map((row) => [row.key, row.text]),
      [
        ['a877b80b-6cec-449f-9ad9-41007963d5d3/score', 'emitted invalid records: value: expected number; unit: required.'],
        ['a877b80b-6cec-449f-9ad9-41007963d5d3/score#2', `emitted invalid records: ${'e'.repeat(500)}.`]
      ]
    )
  })

  test('the recorded refusal under "This project" reads in the console\'s words', async () => {
    const view = await readProject()
    assert.deepEqual(
      view.refused.map((row) => [row.workflowName, row.nodeId, row.text, row.runId]),
      [
        [
          'orchon-recorder-synthetic-metrics',
          'emit',
          'offered orchon_synthetic.items_opened as score in ratio, but it is defined as count in items.',
          'a877b80b-6cec-449f-9ad9-41007963d5d3'
        ]
      ]
    )
    assert.equal(view.refusedTotal, 1)
  })
})
