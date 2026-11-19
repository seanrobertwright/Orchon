// Pure logic: the connection as the run graph tab draws it, one state screen at a time, in the
// words of the panel's own state screens.
import { assert, describe, test } from 'orca/testing'
import { connected, noHome, notRunning, oneBadSetting, searching, twoBadSettings, unsupported } from '../scripts/connection-samples.ts'
import { tabConnection } from './tab-screen'

describe('the tab connection', () => {
  test('Connected says whether live updates are on', () => {
    assert.deepEqual(tabConnection(connected, 'en-US'), { kind: 'connected', live: connected.live })
    assert.deepEqual(tabConnection({ ...connected, live: false }, 'en-US'), { kind: 'connected', live: false })
  })

  test('Searching gives the banner over data and the label without it', () => {
    const view = tabConnection(searching, 'en-US')
    assert.ok(view.kind === 'searching')
    assert.match(view.banner, /^Archon stopped answering at .+\. Reconnecting…$/)
    assert.equal(view.label, 'Looking for Archon…')
  })

  test('Not found has its two wordings; only "could not find" links the installation guide', () => {
    const running = tabConnection(notRunning, 'en-US')
    assert.ok(running.kind === 'screen')
    assert.equal(running.screen.title, 'Archon is not running.')
    assert.equal(running.screen.command, 'archon serve')
    assert.equal(running.screen.install, null)
    assert.equal(running.screen.tryAgain, true)
    const missing = tabConnection(noHome, 'en-US')
    assert.ok(missing.kind === 'screen')
    assert.equal(missing.screen.title, 'Orchon could not find Archon.')
    assert.equal(missing.screen.install, 'https://archon.diy/getting-started/installation/')
  })

  test('Bad setting gives a line per refused setting and no Try again', () => {
    for (const [view, lines] of [
      [oneBadSetting, 2],
      [twoBadSettings, 3]
    ] as const) {
      const tab = tabConnection(view, 'en-US')
      assert.ok(tab.kind === 'screen')
      assert.equal(tab.screen.title, 'A connection setting is not valid.')
      assert.equal(tab.screen.lines.length, lines)
      assert.equal(tab.screen.tryAgain, false)
    }
  })

  test('Unsupported never says too old', () => {
    const tab = tabConnection(unsupported, 'en-US')
    assert.ok(tab.kind === 'screen')
    assert.equal(tab.screen.title, 'This Archon is not supported.')
    assert.ok(!/too old/.test(tab.screen.lines.join(' ')))
  })
})
