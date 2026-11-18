// PROTOTYPE. `orca plugin check` renders the panel once per scenario, each with the worker on a
// fresh host: one per variant, plus the two notices.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  table: { persisted: { plugin: { 'proto.variant': 'A' } } },
  sections: { persisted: { plugin: { 'proto.variant': 'B' } } },
  tree: { persisted: { plugin: { 'proto.variant': 'C' } } },
  unmatched: { persisted: { plugin: { 'proto.variant': 'A', 'proto.scenario': 'unmatched' } } },
  empty: { persisted: { plugin: { 'proto.variant': 'B', 'proto.scenario': 'empty' } } }
})
