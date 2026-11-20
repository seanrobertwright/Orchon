// A metric's view as the worker would answer it, for the panel's tests and for the scenarios of
// `orca plugin check`. These are view models, the worker's output, never Archon's JSON. It is
// development tooling: Orca never loads it.
import type { MockHostOptions } from 'orca/testing'
import type { MetricAnswer, MetricDetail, MetricRequest, MetricView } from '../src/metric-view.ts'
import type { MetricsRequest, MetricsView } from '../src/metrics-view.ts'
import { connectedWithMetrics } from './connection-samples.ts'
import { answeringMetrics } from './metrics-samples.ts'

/** 14:32 UTC on 17 November 2026, when the sample's latest record was made. */
export const LATEST_AT = Date.UTC(2026, 10, 17, 14, 32, 0)

/** The review score of the sample report, at a judge version that hides two older ones. */
export function sampleMetric(change: Partial<MetricDetail> = {}): MetricDetail {
  return {
    name: 'sdlc.review_score',
    judgeVersion: 'judge-v2 on claude-opus',
    value: '70%',
    interval: '20% – 100%',
    records: 3,
    knownCost: '≥ $1.42',
    runs: 4,
    gaps: { withoutCost: 1, withoutTokens: 2, partialCost: 0, missing: 1 },
    tokens: '12,000 in / 3,400 out tokens',
    latest: { value: '90%', at: LATEST_AT, subject: 'pull request 42' },
    olderVersions: ['judge-v1', 'judge-v1 on claude-sonnet'],
    olderMore: 0,
    byDay: [
      { day: '2026-11-17', value: '90%', records: 1 },
      { day: '2026-11-15', value: '60%', records: 2 }
    ],
    byDayMore: 0,
    ...change
  }
}

/**
 * A stand-in for the worker that answers the Metrics section as `answeringMetrics` does, and a
 * metric's view with `metric(request)` as it stands at each request.
 */
export function answeringMetric(
  metrics: (request: MetricsRequest) => MetricsView | Promise<MetricsView>,
  metric: (request: MetricRequest) => MetricView | Promise<MetricView>,
  options: Parameters<typeof answeringMetrics>[1] = {}
): MockHostOptions {
  const base = answeringMetrics(metrics, options)
  const connection = options.connection ?? connectedWithMetrics
  return {
    ...base,
    requests: {
      ...base.requests,
      'metric.read': async (request: MetricRequest): Promise<MetricAnswer> => ({ connection, metric: await metric(request) })
    }
  }
}
