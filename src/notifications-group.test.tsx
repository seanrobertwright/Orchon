// The frame seam for the panel: src/panel.tsx mounted on a scripted worker. These tests cover the
// read-only Notifications group of the Settings section.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { answering, connected, notRunning, systemRead } from '../scripts/connection-samples.ts'
import { repoRoot } from '../scripts/repo-files.ts'
import type { ConnectionView } from './connection-view'
import type { NotificationsTestAnswer, NotificationsView } from './notifications-view'
import * as panelModule from './panel'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

/** The value labels as the manifest declares them for Orca's Settings, read from the manifest itself. */
function manifestLabels(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'orca-plugin.json'), 'utf8')) as {
    contributes: { settings: { key: string; enum?: string[]; enumLabels?: string[] }[] }
  }
  const setting = manifest.contributes.settings.find((entry) => entry.key === 'notifications')
  const values = setting?.enum ?? []
  return Object.fromEntries(values.map((value, index) => [value, setting?.enumLabels?.[index] ?? '']))
}

/** Mounts the panel on Settings, with the worker answering the setting and the test as given. */
async function mountOn(
  notifications: NotificationsView,
  test: () => NotificationsTestAnswer | Promise<NotificationsTestAnswer> = () => ({ kind: 'delivered' }),
  state: ConnectionView = connected
): Promise<TestPanel> {
  const base = answering(state, systemRead)
  panel = await mount(panelModule, {
    host: mockHost({ requests: { ...base.requests, 'notifications.read': notifications, 'notifications.test': test } }),
    persisted: { workspace: { section: 'settings' } }
  })
  await panel.toggle({ type: 'Collapsible', label: 'Notifications' })
  return panel
}

/** The texts drawn inside the Notifications group, in order. */
function texts(view: TestPanel): string[] {
  const group = view.find({ type: 'Collapsible', label: 'Notifications' })
  assert.ok(group, 'no Notifications group')
  return view
    .findAll({ type: 'Text' })
    .filter((element) => element.path.startsWith(`${group.path}/`))
    .map((element) => element.text.replace(/\s+/g, ' ').trim())
}

const requests = (view: TestPanel): string[] => view.host.callsOf('plugin.request').map((params) => (params as { name: string }).name)

describe('the Notifications group', () => {
  for (const [level, label] of Object.entries(manifestLabels())) {
    test(`shows the value "${label}" with the manifest's label, and where to change it`, async () => {
      const view = await mountOn({ level: level as NotificationsView['level'], recognised: true })
      assert.equal(view.find({ type: 'Collapsible', label: 'Notifications' })?.props.description, label)
      const drawn = texts(view)
      assert.equal(drawn[0], `Sends: ${label}.`)
      assert.ok(drawn.includes("Change it under Orchon in Orca's Settings."), drawn.join(' | '))
      assert.deepEqual(view.errors, [])
      assert.deepEqual(view.refusals, [])
    })
  }

  test('says when the stored value is not one Orchon knows, and what it uses instead', async () => {
    const view = await mountOn({ level: 'needs-you', recognised: false })
    assert.ok(texts(view).includes('The stored value is not one Orchon knows, so it uses "Runs that need you".'))
  })

  test('shows in a state other than Connected too, since it asks Archon nothing', async () => {
    const view = await mountOn({ level: 'off', recognised: true }, undefined, notRunning)
    assert.equal(texts(view)[0], 'Sends: Off.')
  })

  test('Send test notification asks the worker once and says when Orca delivered it', async () => {
    const view = await mountOn({ level: 'needs-you', recognised: true })
    await view.press({ type: 'Button', text: 'Send test notification' })
    assert.deepEqual(
      requests(view).filter((name) => name === 'notifications.test'),
      ['notifications.test']
    )
    assert.ok(texts(view).includes('Orca delivered the test notification.'))
  })

  test("says the system is blocking Orca's notifications when Orca answers that it was not delivered", async () => {
    const view = await mountOn({ level: 'needs-you', recognised: true }, () => ({ kind: 'blocked' }))
    await view.press({ type: 'Button', text: 'Send test notification' })
    const callout = view.find({ type: 'Callout' })
    assert.ok(callout, 'no callout')
    assert.match(callout.text, /The system is blocking Orca's notifications\./)
  })

  test('says when the test could not be sent', async () => {
    const view = await mountOn({ level: 'needs-you', recognised: true }, () => ({ kind: 'failed' }))
    await view.press({ type: 'Button', text: 'Send test notification' })
    assert.ok(texts(view).includes('Orchon could not send the test notification.'))
  })

  test('the button is disabled while a test is on its way', async () => {
    let during: unknown
    const view = await mountOn({ level: 'needs-you', recognised: true }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      during = panel?.find({ type: 'Button', text: 'Send test notification' })?.props.disabled
      return { kind: 'delivered' }
    })
    await view.press({ type: 'Button', text: 'Send test notification' })
    assert.equal(during, true)
    assert.equal(view.find({ type: 'Button', text: 'Send test notification' })?.props.disabled, false)
  })
})
