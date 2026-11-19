// The frame seam for the panel: src/panel.tsx mounted on a scripted worker. These tests cover
// the Settings section: its groups, the System group and the Access group.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import {
  answering,
  connected,
  notRunning,
  oneBadSetting,
  searching,
  systemRead,
  systemUnread,
  unsupported
} from '../scripts/connection-samples.ts'
import { repoRoot } from '../scripts/repo-files.ts'
import type { ConnectionView } from './connection-view'
import * as panelModule from './panel'
import type { HealthFacts, SystemView } from './system-view'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

async function mountOn(state: ConnectionView, system?: SystemView, section = 'settings'): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answering(state, system)),
    persisted: { workspace: { section } }
  })
  return panel
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/** Words with their spacing folded, as a person reads them. */
const folded = (text: string): string => text.replace(/\s+/g, ' ').trim()

const SECTION_BAR = { label: 'Orchon sections' }
const RELEASE_TAG = 'https://github.com/coleam00/Archon/releases/tag/v0.14.0'
const GROUPS = ['Connection', 'System', 'Defaults', 'Model tiers', 'Aliases', 'Notifications', 'Access']

/** The elements of a type drawn inside a group. */
function inside(view: TestPanel, title: string, type: string): ReturnType<TestPanel['findAll']> {
  const group = view.find({ type: 'Collapsible', label: title })
  assert.ok(group, `no ${title} group`)
  return view.findAll({ type }).filter((element) => element.path.startsWith(`${group.path}/`))
}

/** The System list's rows, as "label: value". */
function systemRows(view: TestPanel): string[] {
  const list = view.find({ type: 'KeyValue', label: 'System' })
  assert.ok(list, 'no System list')
  return (list.props.items as { label: string; value: string }[]).map((item) => `${item.label}: ${item.value}`)
}

/** The Updates row of the System list, as "label: value". */
function updatesRow(view: TestPanel): string {
  const row = systemRows(view).find((line) => line.startsWith('Updates:'))
  assert.ok(row, 'no Updates row')
  return row
}

const requests = (view: TestPanel): string[] =>
  view.host.callsOf('plugin.request').map((params) => (params as { name: string }).name)

/** The releases with recorded fixtures, oldest first, read from the fixtures folder itself. */
function fixtureReleases(): string[] {
  const parts = (release: string): number[] => release.split('.').map((part) => Number.parseInt(part, 10))
  return readdirSync(join(repoRoot, 'fixtures'))
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort((first, second) => {
      const [a, b] = [parts(first), parts(second)]
      for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0)
        if (difference !== 0) return difference
      }
      return 0
    })
}

describe('the Settings section', () => {
  test('shows its groups in order: Connection and System open, the forms closed, then Notifications and Access', async () => {
    const view = await mountOn(connected, systemRead)
    const groups = view.findAll({ type: 'Collapsible' }).map((group) => [group.label, group.props.defaultOpen === true])
    assert.deepEqual(groups, [
      ['Connection', true],
      ['System', true],
      ['Defaults', false],
      ['Model tiers', false],
      ['Aliases', false],
      ['Notifications', false],
      ['Access', true]
    ])
    clean(view)
  })

  test('says under its heading that its values are install-wide and a project can override them', async () => {
    const view = await mountOn(connected, systemRead)
    const first = view.findAll({ type: 'Text' })[0]
    assert.equal(
      folded(first?.text ?? ''),
      "These values are install-wide: they apply to every project on this computer. A project's own .archon/config.yaml can override them for that project."
    )
  })

  test('says where provider keys and logins are set up, in every state', async () => {
    for (const state of [connected, searching, notRunning]) {
      const view = await mountOn(state)
      assert.ok(view.find({ type: 'Text', text: 'Provider keys and logins are set up in Archon itself.' }), state.kind)
      await view.unmount()
    }
  })
})

describe('the System group', () => {
  test('is an open, read-only list of the server state, with the tested range and the updates row', async () => {
    const view = await mountOn(connected, systemRead)
    const releases = fixtureReleases()
    assert.deepEqual(systemRows(view), [
      'Status: ok',
      'Adapter: web',
      'Database: —',
      'Version: 0.12.1',
      `Tested range: Tested with Archon ${releases[0]} to ${releases.at(-1)}`,
      'Store id: 00000000-0000-4000-8000-000000000000',
      'Concurrency: 2 of 10 active',
      'Running workflows: 1',
      'Platforms: Web',
      'Updates: 0.14.0 available'
    ])
    const link = view.find({ type: 'Link' })
    assert.equal(link?.text, '0.14.0')
    assert.equal(link?.props.href, RELEASE_TAG)
    const controls = ['Input', 'Textarea', 'Select', 'Switch', 'Checkbox', 'RadioGroup', 'Button'].flatMap((type) =>
      inside(view, 'System', type)
    )
    assert.deepEqual(
      controls.map((control) => control.text),
      ['Refresh']
    )
    clean(view)
  })

  test('shows a dash for each value the server did not send', async () => {
    const health: HealthFacts = {
      status: 'ok',
      adapter: null,
      database: null,
      version: null,
      storeId: null,
      concurrency: null,
      runningWorkflows: null,
      platforms: null
    }
    const view = await mountOn(connected, { ...systemRead, health })
    assert.deepEqual(systemRows(view), [
      'Status: ok',
      'Adapter: —',
      'Database: —',
      'Version: —',
      'Tested range: Tested with Archon 0.12.1 to 0.14.0',
      'Store id: —',
      'Concurrency: —',
      'Running workflows: —',
      'Platforms: —',
      'Updates: 0.14.0 available'
    ])
    clean(view)
  })

  test('names the platforms the worker kept and then how many more', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `P${index + 1}`)
    const health = systemRead.health
    assert.ok(health)
    const view = await mountOn(connected, { ...systemRead, health: { ...health, platforms: { names, more: 4 } } })
    assert.equal(systemRows(view).at(-2), `Platforms: ${names.join(', ')} and 4 more`)
  })

  test('the updates row has four states, and the latest version is a link only when the worker kept one', async () => {
    const cases: [SystemView['updates'], string, string | null][] = [
      [{ kind: 'checking' }, 'Updates: Checking', null],
      [{ kind: 'up-to-date', version: '0.14.0' }, 'Updates: Up to date (0.14.0)', null],
      [{ kind: 'available', version: '0.15.0', releaseUrl: RELEASE_TAG }, 'Updates: 0.15.0 available', RELEASE_TAG],
      [{ kind: 'available', version: '0.15.0', releaseUrl: null }, 'Updates: 0.15.0 available', null],
      [{ kind: 'unavailable' }, 'Updates: Update check unavailable', null]
    ]
    for (const [updates, line, href] of cases) {
      const view = await mountOn(connected, { ...systemRead, updates })
      assert.equal(updatesRow(view), line)
      assert.equal(view.find({ type: 'Link' })?.props.href ?? null, href, line)
      clean(view)
      await view.unmount()
    }
  })

  test('asks the worker to read when the section shows, and to stop when it is left', async () => {
    // Opened on Runs, the panel also reads the runs table once connected.
    const view = await mountOn(connected, systemRead, 'runs')
    assert.deepEqual(requests(view), ['connection.read', 'runs.read'])
    await view.select(SECTION_BAR, 'settings')
    assert.deepEqual(requests(view), ['connection.read', 'runs.read', 'forms.read', 'system.open'])
    await view.select(SECTION_BAR, 'chat')
    assert.deepEqual(requests(view), ['connection.read', 'runs.read', 'forms.read', 'system.open', 'system.close'])
    await view.select(SECTION_BAR, 'metrics')
    assert.deepEqual(requests(view), ['connection.read', 'runs.read', 'forms.read', 'system.open', 'system.close'])
    clean(view)
  })

  test('opened on Settings, it asks at once, and closing the panel stops the reads', async () => {
    const view = await mountOn(connected, systemRead)
    assert.deepEqual(requests(view), ['connection.read', 'forms.read', 'system.open'])
    await view.unmount()
    panel = undefined
    assert.deepEqual(requests(view), ['connection.read', 'forms.read', 'system.open', 'system.close'])
  })

  test('the show-runs hint leaves Settings, and the reads stop', async () => {
    const view = await mountOn(connected, systemRead)
    await view.post('show-runs', null)
    // Coming to Runs reads the runs table.
    assert.deepEqual(requests(view), ['connection.read', 'forms.read', 'system.open', 'runs.read', 'system.close'])
  })

  test('Refresh asks the worker to read again, and a posted view replaces the one shown', async () => {
    const view = await mountOn(connected, systemRead)
    await view.press({ type: 'Button', text: 'Refresh' })
    // Refresh also reads the config and the providers of the editable groups.
    assert.deepEqual(requests(view), ['connection.read', 'forms.read', 'system.open', 'forms.read', 'system.refresh'])
    await view.post('system.changed', { ...systemRead, since: 100, updates: { kind: 'unavailable' } })
    assert.equal(updatesRow(view), 'Updates: Update check unavailable')
    // An older view arriving late changes nothing.
    await view.post('system.changed', { ...systemRead, since: 50 })
    assert.equal(updatesRow(view), 'Updates: Update check unavailable')
    clean(view)
  })

  test('before health has answered, a loading placeholder stands in for the list', async () => {
    const view = await mountOn(connected, systemUnread)
    assert.equal(view.find({ type: 'KeyValue', label: 'System' }), null)
    assert.ok(view.find({ type: 'Skeleton' }))
    clean(view)
  })

  test('a failed read keeps the list under one warning line with "Try again"', async () => {
    const view = await mountOn(connected, { ...systemRead, failure: 'Archon did not answer within 10 seconds.' })
    const warning = view.find({ type: 'Callout' })
    assert.equal(warning?.props.tone, 'warning')
    assert.match(folded(warning?.text ?? ''), /^Archon did not answer within 10 seconds\. These values are from .+\. Try again$/)
    assert.equal(systemRows(view).length, 10)
    await view.press({ type: 'Button', text: 'Try again' })
    assert.equal(requests(view).at(-1), 'system.refresh')
    clean(view)
  })

  test('a failed read with nothing loaded shows the error in place of the list', async () => {
    const view = await mountOn(connected, { ...systemUnread, failure: "Orchon could not read Archon's answer." })
    assert.equal(view.find({ type: 'KeyValue', label: 'System' }), null)
    assert.equal(folded(view.find({ type: 'Callout' })?.text ?? ''), "Orchon could not read Archon's answer. Try again")
    clean(view)
  })

  test('in Searching the groups keep their values under the banner, and Refresh is off', async () => {
    const view = await mountOn(searching, systemRead)
    const banner = view.find({ type: 'Callout' })
    assert.match(
      folded(banner?.text ?? ''),
      /^Archon stopped answering at .+\. Reconnecting… Changes are turned off until it answers\.$/
    )
    assert.equal(systemRows(view)[3], 'Version: 0.12.1')
    assert.equal(view.find({ type: 'Button', text: 'Refresh' })?.disabled, true)
    assert.deepEqual(
      view.findAll({ type: 'Collapsible' }).map((group) => group.label),
      GROUPS
    )
    clean(view)
  })

  test('in Not found, Bad setting and Unsupported it shows no System group', async () => {
    for (const state of [notRunning, oneBadSetting, unsupported]) {
      const view = await mountOn(state, systemRead)
      assert.equal(view.find({ type: 'Collapsible', label: 'System' }), null, state.kind)
      assert.ok(view.find({ type: 'Text', text: "Archon's settings appear here when Orchon is connected." }), state.kind)
      assert.ok(view.find({ type: 'Collapsible', label: 'Access' }), state.kind)
      await view.unmount()
    }
  })
})

describe('the Access group', () => {
  // The statements of the decision on what the plugin asks the user to approve, copied from it.
  const STATEMENTS = [
    'Orchon talks only to the Archon server on this computer. It sends nothing anywhere else and collects no usage data.',
    'Its worker runs for as long as the plugin is enabled, to keep runs and the status bar current.',
    'It changes Archon only when you press a control, with one exception: it deletes a conversation it created itself when Archon refuses the launch.',
    'Each launch makes Archon write a conversation title with its small model. That is one small model call per launch, and Orchon cannot turn it off.',
    'On disk it writes only to a .orchon folder in the workspace you are in, which Git ignores.',
    "Notifications hold the workflow name, its state and the project name. Orca also sends them to paired phones. They are changed under Orchon in Orca's Settings.",
    'It never reads or stores provider keys, and never starts another program.'
  ]

  test('carries the statements as plain text, with no control and no link', async () => {
    const view = await mountOn(connected, systemRead)
    assert.deepEqual(
      inside(view, 'Access', 'Text').map((text) => text.text),
      STATEMENTS
    )
    for (const type of ['Button', 'IconButton', 'Link', 'Input', 'Select', 'Switch', 'Checkbox', 'Code']) {
      assert.deepEqual(inside(view, 'Access', type), [], type)
    }
    clean(view)
  })
})
