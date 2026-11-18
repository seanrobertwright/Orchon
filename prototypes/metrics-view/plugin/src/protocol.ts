// PROTOTYPE. Panel <-> worker contract for the Orchon Metrics section (#31).

export type Variant = 'A' | 'B'

export type Scenario = 'normal' | 'states' | 'loading-initial' | 'loading-window' | 'empty-packs'

export type MetricsTab = 'overview' | 'details'

export type WindowDays = '7d' | '30d' | '90d'

export type Focus = 'all' | 'lower'

export type CalibrationBadge =
  | { state: 'ok'; label: string; text: string }
  | { state: 'rough'; text: string }
  | { state: 'not_calibrated' }
  | { state: 'loading' }
  | { state: 'unavailable' }

export type CardViewModel =
  | {
      id: string
      shape: 'count'
      title: string
      metric: string
      figure: string
      noRecords: boolean
      breakdown: { text: string; muted: boolean }[]
    }
  | {
      id: string
      shape: 'ratio'
      title: string
      metric: string
      figure: string
      percent: number | null
      stateText: string | null
      line: string
      calibration: CalibrationBadge | null
    }
  | {
      id: string
      shape: 'cost_per'
      title: string
      metric: string
      figure: string
      coverageLine: string
    }
  | {
      id: string
      shape: 'unknown'
      title: string
    }

export type PackOverview = {
  pack: string
  cards: CardViewModel[]
}

export type UnreadablePack = {
  pack: string
  source: string
  error: string
}

export type RefusalItem = {
  runId: string
  workflow: string
  node: string
  reason: string
}

export type DetailsRow = {
  name: string
  plainName: string
  valueText: string
  recordsText: string
  knownCostText: string
  latestText: string
  selectable: boolean
}

export type ByDayRow = {
  day: string
  valueText: string
  records: number
}

export type MetricDetailView = {
  name: string
  plainName: string
  judgeVersion: string | null
  valueAndInterval: string
  records: number
  knownCostSummary: string
  costGaps: string | null
  tokensSummary: string | null
  latestSummary: string
  olderVersions: string[]
  olderVersionsMore: number
  calibrations: string[]
  calibrationsMore: number
  roughExplanation: string | null
  byDay: ByDayRow[]
}

export type MetricsViewPayload = {
  scenario: Scenario
  window: WindowDays
  windowLabel: string
  dateRange: string
  updatedAt: number
  loadingInitial: boolean
  loadingWindow: { loadingLabel: string; showingLabel: string } | null
  packs: PackOverview[]
  packsMore: number
  refusedCount: number
  refusals: RefusalItem[]
  refusalsMore: number
  unreadablePacks: UnreadablePack[]
  unreadablePacksMore: number
  rows: DetailsRow[]
  rowsMore: number
  unattributedCalibrations: { name: string; status: string }[]
}

export type Remote = {
  variant?: Variant
  scenario?: Scenario
  tab?: MetricsTab
  window?: WindowDays
  metric?: string
  byDayOpen?: boolean
  focus?: Focus
}

declare module 'orca' {
  interface PluginRequests {
    'metrics.view': { input: { scenario: Scenario; window: WindowDays }; output: MetricsViewPayload }
    'metrics.detail': { input: { scenario: Scenario; window: WindowDays; name: string }; output: MetricDetailView | null }
    'proto.set': { input: Remote; output: { posted: true } }
    'proto.get': { output: Remote | null }
  }
  interface PluginPanelEvents {
    'proto.set': Remote
  }
}
