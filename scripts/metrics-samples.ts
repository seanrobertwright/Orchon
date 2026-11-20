// The Metrics section as the worker would answer it, for the panel's tests and for the scenarios
// of `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { MockHostOptions } from 'orca/testing'
import type { ConnectionView } from '../src/connection-view.ts'
import { WINDOW_DAYS, type MetricRow, type MetricsAnswer, type MetricsRequest, type MetricsView, type MetricsWindow } from '../src/metrics-view.ts'
import type { OverviewView } from '../src/overview-view.ts'
import type { ScopeView } from '../src/scope-view.ts'
import { connectedWithMetrics } from './connection-samples.ts'
import { busyRuns } from './runs-samples.ts'
import { answeringScope, matchedWeb } from './scope-samples.ts'

/** Noon UTC on 18 November 2026, when the sample reports end. */
export const REPORT_END = Date.UTC(2026, 10, 18, 12, 0, 0)

/** A metric's row with figures. */
export function shownRow(name: string, value: string, records: number, label = name, change: { knownCost?: string; latest?: string } = {}): MetricRow {
  return { name, label, state: 'shown', value, records, knownCost: change.knownCost ?? 'none recorded', latest: change.latest ?? '1' }
}

/** The rows the samples carry: a count, a share and one of a kind Orchon does not know. */
export const SAMPLE_ROWS: MetricRow[] = [
  shownRow('sdlc.prs_merged', '12 PRs', 12, 'PRs merged'),
  shownRow('sdlc.review_score', '70%', 3, 'Review score', { knownCost: '≥ $1.42', latest: '90%' }),
  { name: 'sdlc.test_histogram', label: 'Test histogram', state: 'unknown-kind' }
]

/** The cards the samples carry: one pack with a count, a ratio, a cost per item and a shape Orchon does not know. */
export const SAMPLE_OVERVIEW: OverviewView = {
  packs: [
    {
      key: 'bundled:sdlc',
      name: 'sdlc',
      cards: [
        { id: 'count:sdlc.prs_merged', title: 'PRs merged', kind: 'figure', shape: 'count', metric: 'sdlc.prs_merged', figure: '12', line: '14 opened · 2 abandoned' },
        {
          id: 'ratio:sdlc.tests_unprotective',
          title: 'Useless tests',
          kind: 'figure',
          shape: 'ratio',
          metric: 'sdlc.tests_unprotective',
          figure: '38%',
          percent: 38,
          line: '5 of 13 new tests'
        },
        { id: 'cost_per:sdlc.prs_merged', title: 'Cost per PR', kind: 'figure', shape: 'cost_per', metric: 'sdlc.prs_merged', figure: '≥ $1.42', line: '8 of 10 runs record cost' },
        { id: 'unknown:Spread', title: 'Spread', kind: 'unknown-shape' }
      ],
      more: 0
    }
  ],
  morePacks: 0
}

/** A report over `window`, fetched `ageMs` before its end, with the rows given. */
export function sampleReport(
  window: MetricsWindow = '7d',
  rows: MetricRow[] = SAMPLE_ROWS,
  options: { more?: number; ageMs?: number; codebaseId?: string; overview?: OverviewView } = {}
): Extract<MetricsView, { kind: 'ready' }> {
  const view: Extract<MetricsView, { kind: 'ready' }> = {
    kind: 'ready',
    window,
    since: REPORT_END - WINDOW_DAYS[window] * 86_400_000,
    until: REPORT_END,
    fetchedAt: REPORT_END - (options.ageMs ?? 120_000),
    rows,
    more: options.more ?? 0,
    refused: [],
    refusedTotal: 0,
    overview: options.overview ?? SAMPLE_OVERVIEW
  }
  if (options.codebaseId !== undefined) view.codebaseId = options.codebaseId
  return view
}

/**
 * A stand-in for the worker that answers the Metrics section with `metrics(request)` as it stands
 * at each request, stamped with the request's project id as the worker stamps its report, the
 * window it names or `7d`, the scope with `scope()`, and the runs table as
 * `answeringScope` does.
 */
export function answeringMetrics(
  metrics: (request: MetricsRequest) => MetricsView | Promise<MetricsView>,
  options: { scope?: () => ScopeView; connection?: ConnectionView; kept?: MetricsWindow } = {}
): MockHostOptions {
  const connection = options.connection ?? connectedWithMetrics
  const base = answeringScope(options.scope ?? (() => matchedWeb), (request) => busyRuns(3, request), { connection })
  let kept = options.kept ?? '7d'
  return {
    requests: {
      ...base.requests,
      'metrics.read': async (request: MetricsRequest): Promise<MetricsAnswer> => {
        if (request.window !== undefined) kept = request.window
        const window = kept
        const view = await metrics(request)
        // The worker's report names the scope it covers, as `startMetrics` does.
        if (view.kind !== 'ready') return { connection, window, metrics: view }
        const stamped = { ...view }
        delete stamped.codebaseId
        if (request.codebaseId !== undefined) stamped.codebaseId = request.codebaseId
        return { connection, window, metrics: stamped }
      }
    }
  }
}
