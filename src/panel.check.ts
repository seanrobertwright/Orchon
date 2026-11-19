// `orca plugin check` renders the panel once per scenario. Orca itself never loads this file.
//
// Every scenario scripts the worker's connection answer. Check also starts the real worker, which
// looks for Archon on the machine it runs on: without a scripted answer, what a scenario drew
// would depend on whether an Archon happens to be running there.
import { defineCheck } from 'orca/testing'
import {
  answering,
  connected,
  connectedWithMetrics,
  noHome,
  notRunning,
  oneBadSetting,
  searching,
  systemRead,
  twoBadSettings,
  unsupported
} from '../scripts/connection-samples.ts'
import { formsWithEdits } from '../scripts/forms-samples.ts'
import { answeringRuns, busyRuns } from '../scripts/runs-samples.ts'

const onSettings = { persisted: { workspace: { section: 'settings' } } }
const onMetrics = { persisted: { workspace: { section: 'metrics' } } }

export default defineCheck({
  connected: answering(connected),
  'runs, empty': answering(connected),
  'runs, busy': answeringRuns((request) => busyRuns(140, request, 2)),
  'connected, reopened on settings': { ...answering(connected), ...onSettings },
  'searching with nothing loaded': answering(searching),
  'not found, Archon is not running': answering(notRunning),
  'not found, no Archon home folder': answering(noHome),
  'bad setting, one refused': answering(oneBadSetting),
  'bad setting, two refused': answering(twoBadSettings),
  unsupported: answering(unsupported),
  'metrics without the metrics paths': { ...answering(connected), ...onMetrics },
  'metrics with the metrics paths': { ...answering(connectedWithMetrics), ...onMetrics },
  'settings while searching, with data': { ...answering(searching, systemRead), ...onSettings },
  'settings with unsaved edits and an outside change': { ...answering(connected, systemRead, formsWithEdits), ...onSettings },
  'settings while not found': { ...answering(notRunning), ...onSettings },
  'settings while unsupported': { ...answering(unsupported), ...onSettings },
  'settings with two refused settings': { ...answering(twoBadSettings), ...onSettings }
})
