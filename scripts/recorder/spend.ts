// Spend mode: the recorder's scenarios that only a live model can give, each run alone, by
// name, with a token ceiling and a wall-clock ceiling. Nothing here starts a release.

export type SpendScenarioName = 'agent-step' | 'chat-turn' | 'metrics'

export interface SpendScenario {
  /** What it records, for the usage and the log. */
  records: string
  /**
   * The highest token ceiling the owner agreed to for it. A run names its own, no higher. A
   * scenario whose ceiling is 0 calls no model, and the release never sees the login.
   */
  maxTokenCeiling: number
  /** How long it may run, from the first request to the last, before it is cancelled. */
  wallClockMs: number
  /** The one release it runs on, or null for every supported release. */
  onlyRelease: string | null
}

/** The scenarios, by the name `--scenario` takes. */
export const SPEND_SCENARIOS: Readonly<Record<SpendScenarioName, SpendScenario>> = {
  'agent-step': {
    records: 'one agent step that lists the files of the throwaway project, with its tool calls and provider events',
    maxTokenCeiling: 150_000,
    wallClockMs: 5 * 60_000,
    onlyRelease: null
  },
  'chat-turn': {
    records: "one web chat turn that asks Archon to run the recorder's shell-step workflow",
    maxTokenCeiling: 100_000,
    wallClockMs: 5 * 60_000,
    onlyRelease: null
  },
  metrics: {
    records: 'the metrics reports and the metric views, with the time each query took',
    maxTokenCeiling: 0,
    wallClockMs: 2 * 60_000,
    onlyRelease: '0.14.0'
  }
}

export const SPEND_SCENARIO_NAMES = Object.keys(SPEND_SCENARIOS) as SpendScenarioName[]

export const isSpendScenarioName = (name: string): name is SpendScenarioName => Object.hasOwn(SPEND_SCENARIOS, name)

/** Whether a scenario calls a model, so that it needs the login and the spend flag. */
export const spendsTokens = (name: SpendScenarioName): boolean => SPEND_SCENARIOS[name].maxTokenCeiling > 0
