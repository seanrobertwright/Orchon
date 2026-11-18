// PROTOTYPE. `orca plugin check` renders the panel once per scenario, each with the worker on a
// fresh host: the runs table, then run detail and a step view in each variant.
import { defineCheck } from 'orca/testing'

const at = (variant: string, more: Record<string, unknown>) => ({ persisted: { plugin: { 'proto.variant': variant, ...more } } })
const step = { 'proto.run': 'completed', 'proto.step': 'implement.build', 'proto.item': 'i329' }
const files = { 'proto.run': 'completed', 'proto.tab': 'artifacts', 'proto.artifact': 'plan.md' }

export default defineCheck({
  runs: {},
  'a-run': at('A', { 'proto.run': 'paused' }),
  'b-run': at('B', { 'proto.run': 'paused' }),
  'c-run': at('C', { 'proto.run': 'paused' }),
  'a-step': at('A', step),
  'b-step': at('B', step),
  'c-step': at('C', step),
  'a-files': at('A', files),
  'b-files': at('B', files),
  'c-files': at('C', files),
  'a-big-output': at('A', { 'proto.run': 'completed', 'proto.step': 'security-review' })
})
