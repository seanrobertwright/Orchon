// PROTOTYPE. Fixture data shaped from Archon v0.14.0 schemas and sdlc/metric-views.json.

import type {
  ByDayRow,
  DetailsRow,
  MetricDetailView,
  MetricsViewPayload,
  PackOverview,
  RefusalItem,
  Scenario,
  UnreadablePack,
  WindowDays,
} from './protocol'

const NOW = Date.now()
const TWO_MIN_AGO = NOW - 2 * 60 * 1000

const WINDOW_META: Record<WindowDays, { label: string; dateRange: string }> = {
  '7d': { label: 'Last 7 days', dateRange: 'Nov 11 – Nov 18' },
  '30d': { label: 'Last 30 days', dateRange: 'Oct 19 – Nov 18' },
  '90d': { label: 'Last 90 days', dateRange: 'Aug 20 – Nov 18' },
}

const NORMAL_PACKS: PackOverview[] = [
  {
    pack: 'sdlc',
    cards: [
      {
        id: 'sdlc-prs-merged',
        shape: 'count',
        title: 'PRs merged',
        metric: 'sdlc.prs_merged',
        figure: '14',
        noRecords: false,
        breakdown: [
          { text: '18 opened', muted: false },
          { text: '2 abandoned', muted: false },
        ],
      },
      {
        id: 'sdlc-useless-tests',
        shape: 'ratio',
        title: 'Useless tests',
        metric: 'sdlc.tests_unprotective',
        figure: '38%',
        percent: 38,
        stateText: null,
        line: '5 of 13 new tests · judge catches 7 of 10',
        calibration: { state: 'rough', text: 'rough' },
      },
      {
        id: 'sdlc-cost-per-pr',
        shape: 'cost_per',
        title: 'Cost per PR',
        metric: 'sdlc.prs_merged',
        figure: '≥ $1.42',
        coverageLine: '8 of 10 runs record cost',
      },
    ],
  },
]

const STATES_PACKS: PackOverview[] = [
  {
    pack: 'sdlc',
    cards: [
      {
        id: 'state-no-records',
        shape: 'count',
        title: 'PRs closed',
        metric: 'sdlc.prs_closed',
        figure: '—',
        noRecords: true,
        breakdown: [],
      },
      {
        id: 'state-nothing-counted',
        shape: 'ratio',
        title: 'Flaky specs',
        metric: 'sdlc.tests_flaky',
        figure: '—',
        percent: null,
        stateText: 'nothing counted',
        line: '0 of 0 new tests',
        calibration: { state: 'not_calibrated' },
      },
      {
        id: 'state-cost-withheld',
        shape: 'cost_per',
        title: 'Cost per PR',
        metric: 'sdlc.prs_merged',
        figure: '—',
        coverageLine: '4 of 10 runs record cost',
      },
      {
        id: 'state-cal-loading',
        shape: 'ratio',
        title: 'Useless tests',
        metric: 'sdlc.tests_unprotective',
        figure: '38%',
        percent: 38,
        stateText: null,
        line: '5 of 13 new tests',
        calibration: { state: 'loading' },
      },
      {
        id: 'state-cal-unavailable',
        shape: 'ratio',
        title: 'Slow migrations',
        metric: 'sdlc.migrations_slow',
        figure: '12%',
        percent: 12,
        stateText: null,
        line: '2 of 17 migrations',
        calibration: { state: 'unavailable' },
      },
      {
        id: 'state-unknown-shape',
        shape: 'unknown',
        title: 'Weekly trend',
      },
    ],
  },
  {
    pack: 'docs-audit',
    cards: [
      {
        id: 'docs-checked',
        shape: 'count',
        title: 'Pages audited',
        metric: 'docs.pages_audited',
        figure: '42',
        noRecords: false,
        breakdown: [
          { text: '6 updated', muted: false },
          { text: 'no records of Docs flagged', muted: true },
        ],
      },
    ],
  },
]

const NORMAL_ROWS: DetailsRow[] = [
  {
    name: 'sdlc.prs_abandoned',
    plainName: 'PRs abandoned',
    valueText: '2 count',
    recordsText: '2',
    knownCostText: '≥ $1.10',
    latestText: '1 · Nov 16, 4:05 PM',
    selectable: true,
  },
  {
    name: 'sdlc.prs_merged',
    plainName: 'PRs merged',
    valueText: '14 count',
    recordsText: '14',
    knownCostText: '≥ $19.88',
    latestText: '1 · Nov 18, 2:14 PM',
    selectable: true,
  },
  {
    name: 'sdlc.prs_opened',
    plainName: 'PRs opened',
    valueText: '18 count',
    recordsText: '18',
    knownCostText: '≥ $24.50',
    latestText: '1 · Nov 18, 2:55 PM',
    selectable: true,
  },
  {
    name: 'sdlc.tests_added',
    plainName: 'New tests',
    valueText: '13 count',
    recordsText: '13',
    knownCostText: '≥ $8.40',
    latestText: '3 · Nov 18, 1:40 PM',
    selectable: true,
  },
  {
    name: 'sdlc.tests_unprotective',
    plainName: 'Useless tests',
    valueText: '5 count',
    recordsText: '5',
    knownCostText: '≥ $5.12',
    latestText: '1 · Nov 18, 1:42 PM',
    selectable: true,
  },
]

const STATES_EXTRA_ROWS: DetailsRow[] = [
  {
    name: 'docs.pages_audited',
    plainName: 'Pages audited',
    valueText: '42 count',
    recordsText: '42',
    knownCostText: '≥ $3.20',
    latestText: '4 · Nov 17, 11:20 AM',
    selectable: true,
  },
  {
    name: 'sdlc.custom_histogram',
    plainName: 'sdlc.custom_histogram',
    valueText: 'a kind this version of Orchon does not show',
    recordsText: '—',
    knownCostText: '—',
    latestText: '—',
    selectable: false,
  },
  {
    name: 'sdlc.prs_closed',
    plainName: 'PRs closed',
    valueText: 'no records in this window',
    recordsText: '0',
    knownCostText: '—',
    latestText: '—',
    selectable: false,
  },
]

const REFUSALS: RefusalItem[] = Array.from({ length: 20 }, (_, i) => ({
  runId: `run-refusal-${i + 1}`,
  workflow: i % 2 === 0 ? 'sdlc-review' : 'docs-audit',
  node: i % 2 === 0 ? 'judge_tests' : 'check_links',
  reason:
    i % 3 === 0
      ? 'Definition conflict on sdlc.tests_unprotective: expected count, got score'
      : 'Invalid metric record: unit must be 1-32 characters of [a-z0-9_%/.-]',
}))

const UNREADABLE_PACKS: UnreadablePack[] = [
  {
    pack: 'legacy-qa',
    source: 'project (.archon/workflows/legacy-qa)',
    error: 'cards: Array must contain at most 6 element(s)',
  },
  {
    pack: 'sean/experimental-metrics',
    source: 'installed (~/.archon/packs/sean/experimental-metrics)',
    error: 'Unexpected token } in JSON at position 184',
  },
]

function buildByDay(days: number): ByDayRow[] {
  const rows: ByDayRow[] = []
  const base = Date.UTC(2026, 10, 18) // 2026-11-18
  for (let i = 0; i < days; i++) {
    const d = new Date(base - i * 86_400_000)
    const iso = d.toISOString().slice(0, 10)
    rows.push({
      day: iso,
      valueText: i % 4 === 0 ? '2' : i % 3 === 0 ? '1' : '0',
      records: i % 4 === 0 ? 2 : i % 3 === 0 ? 1 : 1,
    })
  }
  return rows
}

const BY_DAY_90 = buildByDay(90)

export function getMetricsView(scenario: Scenario, window: WindowDays): MetricsViewPayload {
  const meta = WINDOW_META[window]

  if (scenario === 'loading-initial') {
    return {
      scenario,
      window,
      windowLabel: meta.label,
      dateRange: meta.dateRange,
      updatedAt: TWO_MIN_AGO,
      loadingInitial: true,
      loadingWindow: null,
      packs: NORMAL_PACKS,
      packsMore: 0,
      refusedCount: 0,
      refusals: [],
      refusalsMore: 0,
      unreadablePacks: [],
      unreadablePacksMore: 0,
      rows: [],
      rowsMore: 0,
      unattributedCalibrations: [],
    }
  }

  if (scenario === 'loading-window') {
    return {
      scenario,
      window: '7d',
      windowLabel: WINDOW_META['7d'].label,
      dateRange: WINDOW_META['7d'].dateRange,
      updatedAt: TWO_MIN_AGO,
      loadingInitial: false,
      loadingWindow: {
        loadingLabel: `Loading ${meta.label.toLowerCase()}…`,
        showingLabel: 'Showing last 7 days',
      },
      packs: NORMAL_PACKS,
      packsMore: 0,
      refusedCount: 0,
      refusals: [],
      refusalsMore: 0,
      unreadablePacks: [],
      unreadablePacksMore: 0,
      rows: NORMAL_ROWS,
      rowsMore: 0,
      unattributedCalibrations: [
        { name: 'sdlc.tests_unprotective_judge_agreement', status: 'no records in this window' },
      ],
    }
  }

  if (scenario === 'empty-packs') {
    return {
      scenario,
      window,
      windowLabel: meta.label,
      dateRange: meta.dateRange,
      updatedAt: TWO_MIN_AGO,
      loadingInitial: false,
      loadingWindow: null,
      packs: [],
      packsMore: 0,
      refusedCount: 0,
      refusals: [],
      refusalsMore: 0,
      unreadablePacks: [],
      unreadablePacksMore: 0,
      rows: NORMAL_ROWS,
      rowsMore: 0,
      unattributedCalibrations: [],
    }
  }

  if (scenario === 'states') {
    return {
      scenario,
      window,
      windowLabel: meta.label,
      dateRange: meta.dateRange,
      updatedAt: TWO_MIN_AGO,
      loadingInitial: false,
      loadingWindow: null,
      packs: STATES_PACKS,
      packsMore: 2,
      refusedCount: 23,
      refusals: REFUSALS,
      refusalsMore: 3,
      unreadablePacks: UNREADABLE_PACKS,
      unreadablePacksMore: 0,
      rows: [...NORMAL_ROWS, ...STATES_EXTRA_ROWS].sort((a, b) => a.name.localeCompare(b.name)),
      rowsMore: 12,
      unattributedCalibrations: [
        { name: 'sdlc.tests_unprotective_judge_agreement', status: 'no records in this window' },
      ],
    }
  }

  return {
    scenario,
    window,
    windowLabel: meta.label,
    dateRange: meta.dateRange,
    updatedAt: TWO_MIN_AGO,
    loadingInitial: false,
    loadingWindow: null,
    packs: NORMAL_PACKS,
    packsMore: 0,
    refusedCount: 0,
    refusals: [],
    refusalsMore: 0,
    unreadablePacks: [],
    unreadablePacksMore: 0,
    rows: NORMAL_ROWS,
    rowsMore: 0,
    unattributedCalibrations: [
      { name: 'sdlc.tests_unprotective_judge_agreement', status: 'no records in this window' },
    ],
  }
}

export function getMetricDetail(name: string): MetricDetailView | null {
  if (name === 'sdlc.tests_unprotective') {
    return {
      name: 'sdlc.tests_unprotective',
      plainName: 'Useless tests',
      judgeVersion: 'judge-v3 · claude-sonnet-4-6',
      valueAndInterval: '5 count (no interval for count)',
      records: 5,
      knownCostSummary: '≥ $5.12 · 8 of 10 runs record cost',
      costGaps: '2 without cost · 1 without tokens · 1 partial cost · 1 missing run',
      tokensSummary: '142,400 in / 38,120 out',
      latestSummary: '1 · Nov 18, 2026, 1:42 PM · PR #412',
      olderVersions: [
        'judge-v2 · claude-sonnet-4-5: 3 count (4 records)',
        'judge-v1 · claude-haiku-4-5: 1 count (2 records)',
        'judge-v0 · gpt-4o: 2 count (2 records)',
        'legacy-ast · none: 1 count (1 record)',
        'baseline · none: 0 count (1 record)',
      ],
      olderVersionsMore: 2,
      calibrations: [
        'Judge catch rate on hand-labelled useless tests: 7 of 10 (70%, 95% CI 40%–89%)',
        'Judge agreement with hand labels: 16 of 20 (80%, 95% CI 58%–92%)',
      ],
      calibrationsMore: 0,
      roughExplanation: 'Rough: judge catches 7 of 10 (70%), which is below the 80% threshold.',
      byDay: BY_DAY_90,
    }
  }

  const row = [...NORMAL_ROWS, ...STATES_EXTRA_ROWS].find((r) => r.name === name && r.selectable)
  if (!row) return null

  return {
    name: row.name,
    plainName: row.plainName,
    judgeVersion: null,
    valueAndInterval: row.valueText,
    records: Number(row.recordsText) || 0,
    knownCostSummary: `${row.knownCostText} · all producing runs recorded cost`,
    costGaps: null,
    tokensSummary: '218,000 in / 54,900 out',
    latestSummary: `${row.latestText} · PR #415`,
    olderVersions: [],
    olderVersionsMore: 0,
    calibrations: [],
    calibrationsMore: 0,
    roughExplanation: null,
    byDay: BY_DAY_90,
  }
}
