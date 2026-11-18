// The worker's request protocol seam: src/worker.ts mounted on a stand-in host.
import { assert, mountWorker, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import * as main from './worker'

test('activates and answers the status bar press with a show-runs hint', async () => {
  const worker = await mountWorker(main)
  assert.equal(await worker.command('show-runs'), 'Orchon')
  assert.deepEqual(worker.posts, [{ event: 'show-runs', payload: null }])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('registers a handler for every command the manifest declares', async () => {
  const manifest = JSON.parse(readRepoText('orca-plugin.json')) as {
    contributes: { commands: { id: string }[] }
  }
  const worker = await mountWorker(main)
  // A command with no handler rejects, which fails the test.
  for (const command of manifest.contributes.commands) await worker.command(command.id)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
