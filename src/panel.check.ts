// `orca plugin check` renders the panel once per scenario, with the worker on a fresh stand-in
// host. Orca itself never loads this file.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  empty: {},
  'reopened on settings': { persisted: { workspace: { section: 'settings' } } }
})
