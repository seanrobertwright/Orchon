// The frame seam for the panel: src/panel.tsx mounted with Orca's runtime and checks.
// The worker is scripted to answer Connected, so each section shows its own content.
import { afterEach, assert, describe, mockHost, mount as mountOn, test, type MountOptions, type TestPanel } from 'orca/testing'
import { answering, connected, connectedWithMetrics } from '../scripts/connection-samples.ts'
import * as panelModule from './panel'

const mount = (module: typeof panelModule, options: MountOptions = {}): Promise<TestPanel> =>
  mountOn(module, { host: mockHost(answering(connected)), ...options })

const SECTION_BAR = { label: 'Orchon sections' }
const SECTIONS = [
  ['runs', 'Runs'],
  ['launch', 'Launch'],
  ['workflows', 'Workflows'],
  ['chat', 'Chat'],
  ['metrics', 'Metrics'],
  ['settings', 'Settings']
] as const

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

/** What a person notices first: the selected tab and the placeholder under it. */
function showing(view: TestPanel, label: string): void {
  assert.deepEqual(view.summary(), [
    `Tabs "Orchon sections": "${label}" selected`,
    `EmptyState "${label}"`
  ])
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

test('opens on Runs with the six sections in order, in words only', async () => {
  panel = await mount(panelModule)
  const tabs = panel.findAll({ type: 'Tab' })
  assert.deepEqual(
    tabs.map((tab) => [tab.props.value, tab.props.label]),
    SECTIONS
  )
  for (const tab of tabs) assert.equal(tab.props.icon, undefined)
  showing(panel, 'Runs')
  clean(panel)
})

test('switches between the section placeholders', async () => {
  panel = await mount(panelModule)
  for (const [id, label] of [...SECTIONS].reverse()) {
    await panel.select(SECTION_BAR, id)
    assert.equal(panel.valueOf(SECTION_BAR), id)
    showing(panel, label)
  }
  clean(panel)
})

test('reopens on the section last shown in the workspace', async () => {
  panel = await mount(panelModule)
  await panel.select(SECTION_BAR, 'chat')
  assert.equal(panel.persisted.workspace.section, 'chat')
  await panel.unmount()

  panel = await mount(panelModule, { persisted: { workspace: { section: 'metrics' } } })
  showing(panel, 'Metrics')
  clean(panel)
})

test('opens on Runs when the stored section is not one it knows', async () => {
  panel = await mount(panelModule, { persisted: { workspace: { section: { id: 'runs' } } } })
  showing(panel, 'Runs')
  clean(panel)
})

test('shows Runs when the worker posts the show-runs hint', async () => {
  panel = await mount(panelModule, { persisted: { workspace: { section: 'settings' } } })
  showing(panel, 'Settings')
  await panel.post('show-runs', null)
  showing(panel, 'Runs')
  clean(panel)
})

describe('the Metrics section', () => {
  const requests = (view: TestPanel): unknown[] =>
    view.host.callsOf('plugin.request').map((params) => (params as { name: string }).name)

  test('without the metrics paths, says which release it needs and the version, and sends no request', async () => {
    panel = await mount(panelModule, { persisted: { workspace: { section: 'metrics' } } })
    assert.deepEqual(panel.summary(), [
      'Tabs "Orchon sections": "Metrics" selected',
      'EmptyState "Metrics"'
    ])
    assert.equal(
      panel.find({ type: 'EmptyState' })?.text,
      'Metrics Metrics needs Archon 0.14.0 or newer. This server reports 0.12.1.'
    )
    assert.deepEqual(requests(panel), ['connection.read'])
    clean(panel)
  })

  test('says so when the server reported no version', async () => {
    panel = await mount(panelModule, {
      host: mockHost(answering({ ...connected, version: null })),
      persisted: { workspace: { section: 'metrics' } }
    })
    assert.equal(
      panel.find({ type: 'EmptyState' })?.text,
      'Metrics Metrics needs Archon 0.14.0 or newer. This server does not report its version.'
    )
  })

  test('with the metrics paths, shows the section itself', async () => {
    panel = await mount(panelModule, {
      host: mockHost(answering(connectedWithMetrics)),
      persisted: { workspace: { section: 'metrics' } }
    })
    showing(panel, 'Metrics')
    assert.equal(panel.find({ type: 'EmptyState' })?.text, 'Metrics This section is not built yet.')
    clean(panel)
  })

  test('the other sections do not depend on the metrics paths', async () => {
    panel = await mount(panelModule)
    for (const [id, label] of SECTIONS.filter(([id]) => id !== 'metrics')) {
      await panel.select(SECTION_BAR, id)
      showing(panel, label)
    }
  })
})
