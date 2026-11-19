// The frame seam for outages: src/panel.tsx mounted on a scripted worker. These tests cover what
// the panel draws while Archon is away or its own worker does not answer, and what survives it.
import { afterEach, assert, describe, hostError, mockHost, mount, test, type MockRequests, type TestPanel } from 'orca/testing'
import { answeringRuns, connected, notRunning, searching } from '../scripts/connection-samples.ts'
import { busyRuns } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'

const UNREACHABLE = "Orchon's background process is not answering."
const TURN_OFF_AND_ON = "Turn the Orchon plugin off and on again in Orca's Settings."
const CONSENT = "Orchon is turned off or needs approval in Orca's Settings."
const TRY_AGAIN = { type: 'Button', text: 'Try again' }
const TABLE = { type: 'Table', label: 'Runs' }
const REFRESH = { type: 'IconButton', label: 'Refresh runs' }
const FILTER = { type: 'Select', label: 'Status' }

/** How many runs reads the panel sent. */
const runsRequests = (view: TestPanel): number =>
  view.host.callsOf('plugin.request').filter((params) => (params as { name: string }).name === 'runs.read').length

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

/** The scripted worker of `answeringRuns`, with some requests answered otherwise. */
async function mountWith(requests: MockRequests): Promise<TestPanel> {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { ...answeringRuns((request) => busyRuns(3, request)).requests, ...requests } })
  })
  return panel
}

describe('Worker unreachable', () => {
  test('a first connection read that fails says so with "Try again", and the third adds how to turn the plugin off and on', async () => {
    let down = true
    const view = await mountWith({
      'connection.read': () => {
        if (down) throw hostError('unavailable')
        return { connection: connected }
      }
    })
    const callout = (): string => view.find({ type: 'Callout' })?.text ?? ''
    assert.match(callout(), new RegExp(`^${UNREACHABLE}`))
    assert.equal(callout().includes(TURN_OFF_AND_ON), false)
    // Nothing claims to be looking for Archon: the worker has not said so.
    assert.equal(view.findAll({ type: 'Spinner' }).length, 0)
    await view.press(TRY_AGAIN)
    assert.equal(callout().includes(TURN_OFF_AND_ON), false)
    await view.press(TRY_AGAIN)
    assert.ok(callout().includes(TURN_OFF_AND_ON))

    down = false
    await view.press(TRY_AGAIN)
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
    assert.equal(view.rowsOf(TABLE).length, 3)
  })

  test('on Runs behind a state screen, a worker that stops answering is said above the screen', async () => {
    const view = await mountWith({
      'connection.read': () => ({ connection: notRunning }),
      'connection.retry': () => {
        throw hostError('unavailable')
      }
    })
    assert.match(view.find({ type: 'EmptyState' })?.label ?? '', /^Archon is not running\./)
    await view.press(TRY_AGAIN)
    assert.match(view.find({ type: 'Callout' })?.text ?? '', new RegExp(`^${UNREACHABLE}`))
    assert.match(view.find({ type: 'EmptyState' })?.label ?? '', /^Archon is not running\./)
  })

  test('on Runs while Searching with nothing loaded, a worker that stops answering is said above the spinner', async () => {
    const view = await mountWith({
      'connection.read': () => {
        throw hostError('unavailable')
      }
    })
    await view.post('connection.changed', searching)
    assert.match(view.find({ type: 'Callout' })?.text ?? '', new RegExp(`^${UNREACHABLE}`))
    assert.equal(view.find({ type: 'Spinner' })?.label, 'Looking for Archon…')
  })

  test('consent_required says the plugin is off or needs approval, with no "Try again"', async () => {
    const view = await mountWith({
      'connection.read': () => {
        throw hostError('consent_required')
      }
    })
    assert.match(view.find({ type: 'Callout' })?.text ?? '', new RegExp(`^${CONSENT}`))
    assert.equal(view.findAll(TRY_AGAIN).length, 0)
  })

  test('a view with data keeps it when its own reads fail, and adds the sentence after three in a row', async () => {
    let down = false
    const view = await mountWith({
      'runs.read': (request) => {
        if (down) throw hostError('timeout')
        return { connection: connected, runs: busyRuns(3, request) }
      }
    })
    down = true
    await view.press(REFRESH)
    assert.equal(view.rowsOf(TABLE).length, 3)
    assert.equal(view.findAll({ type: 'Callout' }).length, 1)
    assert.match(view.find({ type: 'Callout' })?.text ?? '', new RegExp(`^${UNREACHABLE} Last good answer at`))
    await view.press(TRY_AGAIN)
    assert.equal((view.find({ type: 'Callout' })?.text ?? '').includes(TURN_OFF_AND_ON), false)
    await view.press(TRY_AGAIN)
    assert.ok((view.find({ type: 'Callout' })?.text ?? '').includes(TURN_OFF_AND_ON))
    assert.equal(view.rowsOf(TABLE).length, 3)
    down = false
    await view.press(TRY_AGAIN)
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
  })

  test('a view whose reads need consent says so with no "Try again"', async () => {
    const view = await mountWith({
      'runs.read': () => {
        throw hostError('consent_required')
      }
    })
    assert.match(view.find({ type: 'Callout' })?.text ?? '', new RegExp(`^${CONSENT}`))
    assert.equal(view.findAll(TRY_AGAIN).length, 0)
    assert.equal(view.findAll({ type: 'Spinner' }).length, 0)
  })
})

describe('a rate-limited read', () => {
  test('is sent once more after retryAfterMs, with no message', async () => {
    let limited = 1
    const view = await mountWith({
      'runs.read': (request) => {
        if (limited > 0) {
          limited -= 1
          throw hostError('rate_limited', 'Too many requests.', 20)
        }
        return { connection: connected, runs: busyRuns(3, request) }
      }
    })
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await view.settled()
    assert.equal(view.rowsOf(TABLE).length, 3)
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
    assert.equal(runsRequests(view), 2)
  })
})

describe('Searching', () => {
  test('with data keeps it under the banner, with the time Archon stopped answering', async () => {
    const view = await mountWith({})
    await view.post('connection.changed', { ...searching, since: Date.UTC(2026, 10, 18, 14, 32) })
    assert.equal(view.rowsOf(TABLE).length, 3)
    assert.equal(view.findAll({ type: 'Spinner' }).length, 0)
    const banner = view.find({ type: 'Callout' })
    assert.equal(banner?.props.tone, 'warning')
    assert.match(
      banner?.text ?? '',
      /^Archon stopped answering at \d{1,2}:\d{2}(?:\s?[AP]M)?\. Reconnecting… Changes are turned off until it answers\.$/
    )
    // Back to Connected: the banner goes and the view reads again.
    const before = runsRequests(view)
    await view.post('connection.changed', { ...connected, since: Date.UTC(2026, 10, 18, 14, 33) })
    assert.equal(view.findAll({ type: 'Callout' }).length, 0)
    assert.equal(runsRequests(view), before + 1)
  })

  test('with nothing loaded shows the spinner and no banner', async () => {
    panel = await mount(panelModule, { host: mockHost(answeringRuns((request) => busyRuns(3, request), searching)) })
    assert.equal(panel.find({ type: 'Spinner' })?.label, 'Looking for Archon…')
    assert.equal(panel.findAll({ type: 'Callout' }).length, 0)
  })
})

describe('a state screen', () => {
  /** Mounts on Runs, narrows to running runs and opens one. */
  async function narrowed(): Promise<TestPanel> {
    const view = await mountWith({})
    await view.select(FILTER, 'running')
    await view.selectRows(TABLE, ['run-0'])
    assert.ok(view.find({ type: 'Card' }))
    return view
  }

  test('replaces the section, and the filter and the open run survive it', async () => {
    const view = await narrowed()
    await view.post('connection.changed', { ...notRunning, since: 100 })
    assert.equal(view.findAll(TABLE).length, 0)
    assert.match(view.find({ type: 'EmptyState' })?.label ?? '', /^Archon is not running\./)
    await view.post('connection.changed', { ...connected, since: 200 })
    assert.equal(view.valueOf(FILTER), 'running')
    assert.equal(view.find({ type: 'Card' })?.props.title, 'workflow-0')
  })

  test('a changed store id on return clears the filter and the open run', async () => {
    const view = await narrowed()
    await view.post('connection.changed', { ...notRunning, since: 100 })
    await view.post('connection.changed', { ...connected, since: 200, storeId: 'another-store' })
    assert.equal(view.valueOf(FILTER), 'all')
    assert.equal(view.findAll({ type: 'Card' }).length, 0)
  })
})

