// The frame seam for the panel: src/panel.tsx mounted on a scripted worker. These tests cover
// what every section shows in place of its content while Orchon is not connected, and the
// Settings section's Connection group.
import { afterEach, assert, describe, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import {
  answering,
  connected,
  connectedFromRecord,
  HOME,
  noHome,
  noHomeFromSetting,
  notRunning,
  notRunningAtRecord,
  notRunningAtSetting,
  oneBadSetting,
  OTHER_HOME,
  searching,
  twoBadSettings,
  unsupported,
  unsupportedAtSetting
} from '../scripts/connection-samples.ts'
import type { ConnectionView } from './connection-view'
import * as panelModule from './panel'

const SECTION_BAR = { label: 'Orchon sections' }
const DATA_SECTIONS = ['runs', 'launch', 'workflows', 'chat', 'metrics'] as const

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

/** A worker that gives the panel no connection state: its request is rejected. */
const noAnswer = {
  requests: {
    'connection.read': () => {
      throw hostError('unavailable')
    }
  }
}

async function mountIn(state: ConnectionView, section?: string): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost(answering(state)),
    ...(section === undefined ? {} : { persisted: { workspace: { section } } })
  })
  return panel
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/**
 * An element's words as a person reads them. The test kit joins the pieces of a line with
 * spaces, so a mark that follows a piece of code is pulled back against it.
 */
const prose = (text: string): string => text.replace(/\s+([.,:;)])/g, '$1').replace(/\(\s+/g, '(')

/** The words of the one element of this type. */
function words(view: TestPanel, type: string): string {
  const found = view.findAll({ type })
  assert.equal(found.length, 1, `${found.length} ${type} elements`)
  return prose(found[0]?.text ?? '')
}

const labels = (view: TestPanel, type: string): string[] => view.findAll({ type }).map((element) => element.text)
const requests = (view: TestPanel): unknown[] =>
  view.host.callsOf('plugin.request').map((params) => (params as { name: string }).name)

describe('the state screens', () => {
  test('asks the worker for the connection state when it opens', async () => {
    const view = await mountIn(connected)
    assert.deepEqual(requests(view), ['connection.read'])
    clean(view)
  })

  test('shows the spinner, and nothing else, while it has no state from the worker', async () => {
    panel = await mount(panelModule, { host: mockHost(noAnswer) })
    assert.deepEqual(panel.summary(), ['Tabs "Orchon sections": "Runs" selected', 'Spinner "Looking for Archon…"'])
    assert.equal(panel.findAll({ type: 'Button' }).length, 0)
    assert.deepEqual(panel.errors, [])
  })

  test('Searching with nothing loaded is the spinner in every section, with no action', async () => {
    const view = await mountIn(searching)
    for (const section of DATA_SECTIONS) {
      await view.select(SECTION_BAR, section)
      assert.equal(view.find({ type: 'Spinner' })?.label, 'Looking for Archon…', section)
      assert.equal(view.findAll({ type: 'EmptyState' }).length, 0, section)
      assert.equal(view.findAll({ type: 'Button' }).length, 0, section)
    }
    clean(view)
  })

  test('Not found with a home folder says Archon is not running and how to start it', async () => {
    const view = await mountIn(notRunning)
    assert.equal(
      words(view, 'EmptyState'),
      'Archon is not running. Nothing answered at http://127.0.0.1:3090 (the default address). ' +
        'Start it in a terminal: archon serve Orchon checks again by itself, at least every 30 seconds. ' +
        'Try again Connection settings'
    )
    assert.ok(view.find({ type: 'EmptyState' })?.props.icon)
    assert.deepEqual(labels(view, 'Button'), ['Try again', 'Connection settings'])
    assert.equal(view.findAll({ type: 'Link' }).length, 0)
    clean(view)
  })

  test('shows `archon serve` as code, with no copy button', async () => {
    const view = await mountIn(notRunning)
    const command = view.findAll({ type: 'Code' }).find((code) => code.text === 'archon serve')
    assert.equal(command?.props.block, true)
    assert.equal(view.findAll({ type: 'IconButton' }).length, 0)
    assert.deepEqual(labels(view, 'Button'), ['Try again', 'Connection settings'])
  })

  test('says where the address that did not answer came from', async () => {
    const atSetting = await mountIn(notRunningAtSetting)
    assert.ok(
      words(atSetting, 'EmptyState').startsWith(
        'Archon is not running. Nothing answered at http://localhost:4000 (from the Base URL setting). Start it'
      ),
      words(atSetting, 'EmptyState')
    )
    await atSetting.unmount()

    const atRecord = await mountIn(notRunningAtRecord)
    assert.ok(
      words(atRecord, 'EmptyState').startsWith(
        `Archon is not running. Nothing answered at http://127.0.0.1:4100 (from server.json in ${HOME}). Start it`
      ),
      words(atRecord, 'EmptyState')
    )
    clean(atRecord)
  })

  test('Not found with no home folder says Orchon could not find Archon, and links the install guide', async () => {
    const view = await mountIn(noHome)
    assert.equal(
      words(view, 'EmptyState'),
      `Orchon could not find Archon. There is no Archon home folder at ${HOME}. ` +
        'Archon may not be installed, or it may keep its home somewhere else. ' +
        'Try again Connection settings Install Archon'
    )
    assert.ok(view.find({ type: 'EmptyState' })?.props.icon)
    assert.deepEqual(labels(view, 'Button'), ['Try again', 'Connection settings'])
    assert.deepEqual(labels(view, 'Link'), ['Install Archon'])
    clean(view)
  })

  test('says so when the missing home folder comes from the setting', async () => {
    const view = await mountIn(noHomeFromSetting)
    assert.ok(
      words(view, 'EmptyState').startsWith(
        `Orchon could not find Archon. There is no Archon home folder at ${OTHER_HOME} ` +
          '(from the Archon home folder setting). Archon may not be installed'
      ),
      words(view, 'EmptyState')
    )
    clean(view)
  })

  test('"Install Archon" opens the installation guide in the system browser', async () => {
    const view = await mountIn(noHome)
    await view.press({ type: 'Link', text: 'Install Archon' })
    assert.deepEqual(view.host.callsOf('shell.openExternal'), [
      { url: 'https://archon.diy/getting-started/installation/' }
    ])
    clean(view)
  })

  test('Bad setting with one refused setting lists it with its value and reason', async () => {
    const view = await mountIn(oneBadSetting)
    assert.equal(
      words(view, 'EmptyState'),
      'A connection setting is not valid. ' +
        'Base URL: https://archon.example.com:3090 The address must start with http://. ' +
        "Change it in Orca's Settings, under Orchon. Orchon checks again as soon as the setting changes. " +
        'Connection settings'
    )
    assert.ok(view.find({ type: 'EmptyState' })?.props.icon)
    assert.deepEqual(labels(view, 'Button'), ['Connection settings'])
    clean(view)
  })

  test('Bad setting with two refused settings lists both', async () => {
    const view = await mountIn(twoBadSettings)
    assert.equal(
      words(view, 'EmptyState'),
      'A connection setting is not valid. ' +
        'Base URL: http://192.168.1.20:3090 Orchon works only with an Archon on this computer. ' +
        'Use 127.0.0.1, localhost or [::1]. ' +
        'Archon home folder: archon The folder must be a full path. ' +
        "Change it in Orca's Settings, under Orchon. Orchon checks again as soon as the setting changes. " +
        'Connection settings'
    )
    // Nothing can change until the setting does, so there is no "Try again".
    assert.deepEqual(labels(view, 'Button'), ['Connection settings'])
    clean(view)
  })

  test('Unsupported says the server is not supported, with its version, and never "too old"', async () => {
    const view = await mountIn(unsupported)
    assert.equal(
      words(view, 'EmptyState'),
      'This Archon is not supported. The server at http://127.0.0.1:3090 (the default address) reports ' +
        "Archon 0.11.1 and lacks parts of Archon's API that Orchon needs. Orchon works with Archon 0.12.1 " +
        'or newer. Checking again every 30 seconds. Try again Connection settings'
    )
    assert.ok(view.find({ type: 'EmptyState' })?.props.icon)
    assert.deepEqual(labels(view, 'Button'), ['Try again', 'Connection settings'])
    assert.ok(labels(view, 'Code').includes('http://127.0.0.1:3090'))
    assert.ok(!/too old/i.test(words(view, 'EmptyState')))
    clean(view)
  })

  test('Unsupported says where the address came from, and leaves out a version the server did not report', async () => {
    const view = await mountIn(unsupportedAtSetting)
    assert.equal(
      words(view, 'EmptyState'),
      'This Archon is not supported. The server at http://localhost:4000 (from the Base URL setting) ' +
        "lacks parts of Archon's API that Orchon needs. Orchon works with Archon 0.12.1 or newer. " +
        'Checking again every 30 seconds. Try again Connection settings'
    )
    await view.unmount()

    const atRecord = await mountIn({ ...unsupported, baseUrl: 'http://127.0.0.1:4100', source: 'server-json' })
    assert.ok(
      words(atRecord, 'EmptyState').startsWith(
        `This Archon is not supported. The server at http://127.0.0.1:4100 (from server.json in ${HOME}) reports`
      ),
      words(atRecord, 'EmptyState')
    )
    clean(atRecord)
  })

  test('shows the version Archon reported as text, whatever it holds', async () => {
    const view = await mountIn({ ...unsupported, version: '<b>0.11.1</b>' })
    assert.match(words(view, 'EmptyState'), /reports Archon <b>0\.11\.1<\/b> and lacks/)
    clean(view)
  })

  test('shows the words a reason marks as code as code', async () => {
    const view = await mountIn(twoBadSettings)
    const code = labels(view, 'Code')
    for (const word of ['http://192.168.1.20:3090', '127.0.0.1', 'localhost', '[::1]', 'archon']) {
      assert.ok(code.includes(word), `${word} is not shown as code`)
    }
  })

  test('every data section shows the same state screen below the section bar', async () => {
    for (const state of [notRunning, noHome, oneBadSetting, twoBadSettings, unsupported]) {
      const view = await mountIn(state)
      const first = words(view, 'EmptyState')
      for (const section of DATA_SECTIONS) {
        await view.select(SECTION_BAR, section)
        assert.equal(view.valueOf(SECTION_BAR), section)
        assert.equal(words(view, 'EmptyState'), first, `${state.kind} in ${section}`)
      }
      clean(view)
      await view.unmount()
    }
  })

  test('the section bar stays enabled in every state', async () => {
    for (const state of [searching, notRunning, noHome, oneBadSetting, unsupported, connected]) {
      const view = await mountIn(state)
      assert.deepEqual(
        view.findAll({ type: 'Tab' }).map((tab) => tab.disabled),
        [false, false, false, false, false, false],
        state.kind
      )
      await view.unmount()
    }
  })

  test('"Connection settings" opens the Settings section', async () => {
    for (const state of [notRunning, noHome, oneBadSetting, unsupported]) {
      const view = await mountIn(state, 'chat')
      await view.press({ type: 'Button', text: 'Connection settings' })
      assert.equal(view.valueOf(SECTION_BAR), 'settings', state.kind)
      assert.equal(view.persisted.workspace.section, 'settings')
      assert.ok(view.find({ type: 'Collapsible', label: 'Connection' }))
      clean(view)
      await view.unmount()
    }
  })

  test('"Try again" asks the worker to look at once and shows what it answers', async () => {
    let retried = 0
    panel = await mount(panelModule, {
      host: mockHost({
        requests: {
          'connection.read': { connection: notRunning },
          'connection.retry': () => {
            retried += 1
            return { connection: { ...searching, since: notRunning.since + 1 } }
          }
        }
      })
    })
    await panel.press({ type: 'Button', text: 'Try again' })
    assert.equal(retried, 1)
    assert.deepEqual(requests(panel), ['connection.read', 'connection.retry'])
    assert.equal(panel.find({ type: 'Spinner' })?.label, 'Looking for Archon…')
    assert.equal(panel.findAll({ type: 'EmptyState' }).length, 0)
    clean(panel)
  })

  test('shows each state the worker posts, and the section content once Connected', async () => {
    const view = await mountIn(searching)
    await view.post('connection.changed', { ...notRunning, since: 100 })
    assert.match(words(view, 'EmptyState'), /^Archon is not running\./)
    await view.post('connection.changed', { ...connected, since: 200 })
    assert.deepEqual(view.summary(), ['Tabs "Orchon sections": "Runs" selected', 'EmptyState "Runs"'])
    assert.equal(view.findAll({ type: 'Spinner' }).length, 0)
    clean(view)
  })

  test('keeps the newest state: one stamped earlier than the one showing is dropped', async () => {
    const view = await mountIn({ ...noHome, since: 500 })
    await view.post('connection.changed', { ...connected, since: 499 })
    assert.match(words(view, 'EmptyState'), /^Orchon could not find Archon\./)
    await view.post('connection.changed', { ...connected, since: 500 })
    assert.match(words(view, 'EmptyState'), /^Orchon could not find Archon\./)
    await view.post('connection.changed', { ...connected, since: 501 })
    assert.equal(words(view, 'EmptyState'), 'Runs This section is not built yet.')
    clean(view)
  })

  test('shows a state the worker posts to a panel that had none', async () => {
    panel = await mount(panelModule, { host: mockHost(noAnswer) })
    await panel.post('connection.changed', { ...notRunning, since: 900 })
    assert.match(words(panel, 'EmptyState'), /^Archon is not running\./)
  })

  test('keeps the chosen section through a state screen', async () => {
    const view = await mountIn(notRunning, 'metrics')
    assert.equal(view.valueOf(SECTION_BAR), 'metrics')
    await view.post('connection.changed', { ...connected, since: 100 })
    assert.deepEqual(view.summary(), ['Tabs "Orchon sections": "Metrics" selected', 'EmptyState "Metrics"'])
  })
})

describe('the Connection group of the Settings section', () => {
  /** The group's rows, as "label: value". */
  function rows(view: TestPanel): string[] {
    const list = view.find({ type: 'KeyValue', label: 'Connection' })
    assert.ok(list, 'no Connection list')
    return (list.props.items as { label: string; value: string }[]).map((item) => `${item.label}: ${item.value}`)
  }
  const groupText = (view: TestPanel): string =>
    prose(view.find({ type: 'Collapsible', label: 'Connection' })?.text ?? '')
  const WHERE = "Change these in Orca's Settings, under Plugins, Orchon."
  const NOT_CONNECTED = "Archon's settings appear here when Orchon is connected."

  test('is open and read-only in every state, and says where to change the settings', async () => {
    for (const state of [searching, connected, notRunning, noHome, oneBadSetting, twoBadSettings, unsupported]) {
      const view = await mountIn(state, 'settings')
      const group = view.find({ type: 'Collapsible', label: 'Connection' })
      assert.ok(group, state.kind)
      assert.ok(group.text.includes(WHERE), state.kind)
      assert.equal(rows(view).length, 4, state.kind)
      for (const type of ['Input', 'Textarea', 'Select', 'Switch', 'Checkbox', 'RadioGroup', 'Button']) {
        assert.equal(view.findAll({ type }).length, 0, `${type} in ${state.kind}`)
      }
      clean(view)
      await view.unmount()
    }
  })

  test('Connected: the state, the address with where it came from, and both settings', async () => {
    const view = await mountIn(connected, 'settings')
    assert.deepEqual(rows(view), [
      'State: Connected',
      'Connected address: http://127.0.0.1:3090 (the default address)',
      'Base URL: Automatic',
      'Archon home folder: ~/.archon'
    ])
    assert.equal(view.find({ type: 'Text', text: NOT_CONNECTED }), null)
    await view.unmount()

    const fromRecord = await mountIn(connectedFromRecord, 'settings')
    assert.equal(rows(fromRecord)[1], `Connected address: http://127.0.0.1:4100 (from server.json in ${HOME})`)
  })

  test('shows a setting as typed, and its default when unset', async () => {
    const view = await mountIn(
      {
        ...connected,
        source: 'setting',
        baseUrl: 'http://localhost:4000',
        settings: { baseUrl: 'http://localhost:4000', archonHome: '~/archon-two', homeFolder: '/home/ada/archon-two' }
      },
      'settings'
    )
    assert.deepEqual(rows(view), [
      'State: Connected',
      'Connected address: http://localhost:4000 (from the Base URL setting)',
      'Base URL: http://localhost:4000',
      'Archon home folder: ~/archon-two'
    ])
  })

  test('not Connected: the state in words, no address, and one line in place of the other groups', async () => {
    const expected: [ConnectionView, string][] = [
      [searching, 'State: Looking for Archon…'],
      [notRunning, 'State: Archon is not running.'],
      [noHome, 'State: Orchon could not find Archon.'],
      [oneBadSetting, 'State: A connection setting is not valid.'],
      [unsupported, 'State: This Archon is not supported.']
    ]
    for (const [state, row] of expected) {
      const view = await mountIn(state, 'settings')
      assert.deepEqual(rows(view).slice(0, 2), [row, 'Connected address: Not connected'], state.kind)
      assert.ok(view.find({ type: 'Text', text: NOT_CONNECTED }), state.kind)
      assert.equal(view.findAll({ type: 'EmptyState' }).length, 0, state.kind)
      assert.equal(view.findAll({ type: 'Spinner' }).length, 0, state.kind)
      clean(view)
      await view.unmount()
    }
  })

  test('shows the reason a value was refused beside the value', async () => {
    const one = await mountIn(oneBadSetting, 'settings')
    assert.deepEqual(rows(one).slice(2), ['Base URL: https://archon.example.com:3090', 'Archon home folder: ~/.archon'])
    assert.ok(groupText(one).includes('Base URL: The address must start with http://.'))
    assert.ok(!groupText(one).includes('Archon home folder: The folder'))
    await one.unmount()

    const two = await mountIn(twoBadSettings, 'settings')
    assert.deepEqual(rows(two).slice(2), ['Base URL: http://192.168.1.20:3090', 'Archon home folder: archon'])
    assert.ok(groupText(two).includes('Base URL: Orchon works only with an Archon on this computer.'))
    assert.ok(groupText(two).includes('Archon home folder: The folder must be a full path.'))
    clean(two)
  })

  test('with no state from the worker it shows the state row alone', async () => {
    panel = await mount(panelModule, {
      host: mockHost(noAnswer),
      persisted: { workspace: { section: 'settings' } }
    })
    const list = panel.find({ type: 'KeyValue', label: 'Connection' })
    assert.deepEqual(list?.props.items, [{ label: 'State', value: 'Looking for Archon…' }])
    assert.ok(panel.find({ type: 'Collapsible', label: 'Connection' })?.text.includes(WHERE))
  })
})
