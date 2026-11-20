// What the Metrics section's worker modules share about Archon's metrics: the metric-name check
// and the number formats of Archon's console (`formatNumber` and `formatShare` in the console's
// metrics `model.ts` of Archon 0.14.0, commit 8def159a6b2c23e832a5283b4131cfffd9af9344).

/** Archon's metric-name pattern and length, from `metricNameSchema`. */
const METRIC_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/
const METRIC_NAME_CAP = 128

export const isMetricName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= METRIC_NAME_CAP && METRIC_NAME.test(value)

/** Two decimals, except a nonzero value below 0.01 keeps two significant digits rather than showing 0. */
export function formatNumber(value: number): string {
  return value !== 0 && Math.abs(value) < 0.01
    ? value.toLocaleString('en-US', { maximumSignificantDigits: 2 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** Two significant digits, so a small nonzero share never shows as 0%. */
export const formatShare = (share: number): string => share.toLocaleString('en-US', { style: 'percent', maximumSignificantDigits: 2 })
