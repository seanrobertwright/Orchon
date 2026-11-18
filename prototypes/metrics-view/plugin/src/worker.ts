// PROTOTYPE. Stand-in worker returning fixture data and relaying proto.set for shots.

import type { Orca } from 'orca-worker'
import { getMetricDetail, getMetricsView } from './fixtures'
import type { Remote } from './protocol'

let lastRemote: Remote | null = null

export default function activate(orca: Orca) {
  orca.panels.handle('metrics.view', async ({ scenario, window }) => {
    return getMetricsView(scenario, window)
  })

  orca.panels.handle('metrics.detail', async ({ name }) => {
    return getMetricDetail(name)
  })

  orca.panels.handle('proto.set', async (remote) => {
    lastRemote = remote
    orca.panels.post('proto.set', remote)
    return { posted: true as const }
  })

  orca.panels.handle('proto.get', async () => {
    return lastRemote
  })
}
