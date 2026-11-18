// The frame seam for the panel: src/panel.tsx mounted with Orca's runtime and checks.
import { afterEach, assert, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'

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
