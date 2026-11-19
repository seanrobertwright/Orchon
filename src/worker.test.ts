// The worker's request protocol seam: src/worker.ts mounted on a stand-in host.
// Archon, the clock and the disk are scripted: no test reaches what runs on the machine.
import { assert, test } from 'orca/testing'
import { readRepoText } from '../scripts/repo-files.ts'
import { scene } from '../scripts/scripted-archon.ts'
import * as main from './worker'

test('activates and answers the status bar press with the status sentence and a show-runs hint', async () => {
  const stage = scene()
  const { worker } = await stage.mount()
  assert.equal(await worker.command('show-runs'), 'Looking for Archon.')
  assert.deepEqual(
    worker.posts.filter((post) => post.event === 'show-runs'),
    [{ event: 'show-runs', payload: { at: stage.clock.now(), needsYou: false } }]
  )
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('exports what Orca calls: a default activate and a deactivate', () => {
  assert.equal(typeof main.default, 'function')
  assert.equal(typeof main.deactivate, 'function')
})

test('registers a handler for every command the manifest declares', async () => {
  const manifest = JSON.parse(readRepoText('orca-plugin.json')) as {
    contributes: { commands: { id: string }[] }
  }
  const { worker } = await scene().mount()
  // A command with no handler rejects, which fails the test.
  for (const command of manifest.contributes.commands) await worker.command(command.id)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
