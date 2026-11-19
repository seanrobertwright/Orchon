// Pure logic: what the status bar item reads in every connection state, with and without the
// snapshot of runs that need you. The expected readings are the table of the attention decision
// (#21, part 2) and the status bar sentences of the wording decision (#22, part 10).
import { assert, describe, test } from 'orca/testing'
import {
  oneBadSetting,
  connected,
  noHome,
  notRunning,
  searching,
  twoBadSettings,
  unsupported
} from '../scripts/connection-samples.ts'
import { showRunsSentence, statusItem } from './status-bar'

const bot = (text: string, tooltip: string): unknown => ({ text, icon: 'bot', tone: 'neutral', tooltip })
const at = 'Archon 0.12.1 at http://127.0.0.1:3090'

describe('the status bar item in each connection state', () => {
  test('reads "Archon…" while Searching and "Archon off" for both Not found wordings', () => {
    assert.deepEqual(statusItem(searching), bot('Archon…', 'Looking for Archon.'))
    assert.deepEqual(statusItem(notRunning), bot('Archon off', 'Archon is not running at http://127.0.0.1:3090.'))
    assert.deepEqual(statusItem(noHome), bot('Archon off', 'No Archon home folder at /home/ada/.archon.'))
  })

  test('reads "Archon setup" with the warning icon and tone for Bad setting and Unsupported', () => {
    const warns = (tooltip: string): unknown => ({ text: 'Archon setup', icon: 'warning', tone: 'warning', tooltip })
    assert.deepEqual(statusItem(oneBadSetting), warns('The Base URL setting is not valid.'))
    assert.deepEqual(statusItem(twoBadSettings), warns('Two connection settings are not valid.'))
    assert.deepEqual(
      statusItem(unsupported),
      warns('The Archon at http://127.0.0.1:3090 is not supported. Orchon needs 0.12.1 or newer.')
    )
  })

  test('the snapshot changes nothing outside Connected', () => {
    const counts = { kind: 'counted', needsYou: 2, running: 3, unread: 0 } as const
    assert.deepEqual(statusItem(notRunning, counts), statusItem(notRunning))
    assert.deepEqual(statusItem(searching, { kind: 'unavailable' }), statusItem(searching))
  })
})

describe('the status bar item while Connected', () => {
  test('reads "Archon" when nothing runs and nothing needs you, and before the first count', () => {
    assert.deepEqual(statusItem(connected), bot('Archon', `Connected to ${at}.`))
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 0, running: 0, unread: 0 }), bot('Archon', `Connected to ${at}.`))
  })

  test('shows the running count when runs run and none need you', () => {
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 0, running: 3, unread: 0 }), bot('3 running', `3 runs are running on ${at}.`))
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 0, running: 1, unread: 0 }), bot('1 running', `1 run is running on ${at}.`))
  })

  test('shows one figure: the runs that need you, with the bell and the warning tone, and the running count in the tooltip', () => {
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 2, running: 3, unread: 0 }), {
      text: '2 need you',
      icon: 'bell',
      tone: 'warning',
      tooltip: `2 runs need you and 3 are running on ${at}.`
    })
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 1, running: 0, unread: 0 }), {
      text: '1 needs you',
      icon: 'bell',
      tone: 'warning',
      tooltip: `1 run needs you on ${at}.`
    })
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 1, running: 1, unread: 0 }).tooltip, `1 run needs you and 1 is running on ${at}.`)
  })

  test('reads "99+" past 99, and the tooltip keeps the real counts', () => {
    const many = statusItem(connected, { kind: 'counted', needsYou: 120, running: 0, unread: 0 })
    assert.equal(many.text, '99+ need you')
    assert.equal(many.tooltip, `120 runs need you on ${at}.`)
    assert.equal(statusItem(connected, { kind: 'counted', needsYou: 99, running: 0, unread: 0 }).text, '99 need you')
    assert.equal(statusItem(connected, { kind: 'counted', needsYou: 0, running: 100, unread: 0 }).text, '99+ running')
  })

  test('reads "Archon" with a tooltip saying the count is unavailable when the waiting runs could not be read', () => {
    assert.deepEqual(
      statusItem(connected, { kind: 'unavailable' }),
      bot('Archon', `The count of runs that need you is unavailable from ${at}.`)
    )
  })

  test('says in the same sentence how many waiting runs could not be read, and when the running count is unavailable', () => {
    assert.equal(statusItem(connected, { kind: 'counted', needsYou: 2, running: 3, unread: 1 }).tooltip, `2 runs need you and 3 are running on ${at}; 1 waiting run could not be read.`)
    assert.equal(
      statusItem(connected, { kind: 'counted', needsYou: 1, running: null, unread: 2 }).tooltip,
      `1 run needs you on ${at}; the running count is unavailable and 2 waiting runs could not be read.`
    )
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 0, running: 0, unread: 1 }), bot('Archon', `No run needs you on ${at}; 1 waiting run could not be read.`))
    assert.deepEqual(statusItem(connected, { kind: 'counted', needsYou: 0, running: null, unread: 0 }), bot('Archon', `The running count is unavailable from ${at}.`))
  })

  test('says "Archon" with no version when health reports none', () => {
    const unversioned = { ...connected, version: null }
    assert.equal(statusItem(unversioned, { kind: 'counted', needsYou: 0, running: 2, unread: 0 }).tooltip, '2 runs are running on Archon at http://127.0.0.1:3090.')
  })
})

describe('what the "Orchon: Show runs" command returns', () => {
  test('while Connected: the status sentence and where to go', () => {
    assert.equal(
      showRunsSentence(connected, { kind: 'counted', needsYou: 2, running: 3, unread: 0 }),
      `2 runs need you and 3 are running on ${at}. Open the Orchon panel in the right sidebar.`
    )
    assert.equal(showRunsSentence(connected), `Connected to ${at}. Open the Orchon panel in the right sidebar.`)
  })

  test("in any other state: that state's sentence", () => {
    assert.equal(showRunsSentence(notRunning, { kind: 'counted', needsYou: 2, running: 0, unread: 0 }), 'Archon is not running at http://127.0.0.1:3090.')
    assert.equal(showRunsSentence(searching), 'Looking for Archon.')
  })
})
