// PROTOTYPE. Stands in for the real worker: it answers the panel from a made-up run and never
// calls Archon. The 150 ms wait makes loading states visible.
import type { OrcaWorkerApi } from 'orca/worker'
import { getActivityPage, getItem, getRun, getStep, listArtifacts, readArtifact } from './fixtures'
import type { Remote } from './protocol'
import './protocol'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('run.get', async ({ scenario }) => {
    await wait(150)
    return getRun(scenario)
  })
  orca.panels.handle('step.get', async ({ scenario, step }) => {
    await wait(150)
    return getStep(scenario, step)
  })
  orca.panels.handle('activity.page', async ({ scenario, step, before }) => {
    await wait(150)
    return getActivityPage(scenario, step, before)
  })
  orca.panels.handle('activity.item', async ({ scenario, step, key }) => {
    await wait(150)
    return getItem(scenario, step, key)
  })
  orca.panels.handle('artifacts.list', async ({ scenario, filter }) => {
    await wait(150)
    return listArtifacts(scenario, filter)
  })
  orca.panels.handle('artifact.read', async ({ scenario, path, split }) => {
    await wait(150)
    return readArtifact(scenario, path, split)
  })
  // The sidebar is shared with other sessions, so the panel may be off screen when a capture is
  // set up. The last request is kept here and a panel asks for it when it mounts.
  let last: Remote | null = null
  orca.panels.handle('proto.set', async (input) => {
    last = Object.keys(input).length > 0 ? input : null
    orca.panels.post('proto.set', input)
    return { posted: true as const }
  })
  orca.panels.handle('proto.get', async () => last)
}
