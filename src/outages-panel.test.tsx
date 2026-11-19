// The frame seam for outages: src/panel.tsx mounted on a scripted worker. These tests cover what
// the panel draws while Archon is away or its own worker does not answer, and what survives it.
import { afterEach, assert, describe, hostError, mockHost, mount, test, type MockRequests, type TestPanel } from 'orca/testing'
import { answeringRuns, connected } from '../scripts/connection-samples.ts'
import { busyRuns } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'

const UNREACHABLE = "Orchon's background process is not answering."
const TURN_OFF_AND_ON = "Turn the Orchon plugin off and on again in Orca's Settings."
const CONSENT = "Orchon is turned off or needs approval in Orca's Settings."
const TRY_AGAIN = { type: 'Button', text: 'Try again' }
const TABLE = { type: 'Table', label: 'Runs' }
const REFRESH = { type: 'IconButton', label: 'Refresh runs' }

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
