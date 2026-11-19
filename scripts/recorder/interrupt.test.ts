// Ctrl+C during a recording: the first one ends the recording early, and no later one may end
// the recorder before it has stopped the release and deleted the throwaway folder.
import { EventEmitter } from 'node:events'
import { assert, describe, test } from 'orca/testing'
import { Interrupted, untilInterrupted, watchInterrupts } from './interrupt.ts'

/** A stand-in for the process: it only takes and sends signals. */
function fakeProcess(): EventEmitter & { said: string[] } {
  return Object.assign(new EventEmitter(), { said: [] as string[] })
}

describe('watching for Ctrl+C', () => {
  test('the first Ctrl+C aborts the signal with an Interrupted reason', () => {
    const target = fakeProcess()
    const watch = watchInterrupts(target, (line) => target.said.push(line))
    assert.equal(watch.signal.aborted, false)
    target.emit('SIGINT')
    assert.equal(watch.signal.aborted, true)
    assert.ok(watch.signal.reason instanceof Interrupted)
    watch.dispose()
  })

  test('a termination signal aborts it the same way', () => {
    const target = fakeProcess()
    const watch = watchInterrupts(target, (line) => target.said.push(line))
    target.emit('SIGTERM')
    assert.ok(watch.signal.reason instanceof Interrupted)
    watch.dispose()
  })

  test('a second Ctrl+C is held, so the process is not ended before the cleanup', () => {
    const target = fakeProcess()
    const watch = watchInterrupts(target, (line) => target.said.push(line))
    target.emit('SIGINT')
    const reason: unknown = watch.signal.reason
    target.emit('SIGINT')
    target.emit('SIGINT')
    // Node ends a process on SIGINT only when no listener is left: the watcher stays.
    assert.equal(target.listenerCount('SIGINT'), 1)
    assert.equal(watch.signal.reason, reason)
    assert.equal(target.said.length, 3)
    assert.match(target.said[1] ?? '', /still stopping/i)
    watch.dispose()
  })

  test('letting go removes its listeners', () => {
    const target = fakeProcess()
    const watch = watchInterrupts(target, () => undefined)
    watch.dispose()
    assert.equal(target.listenerCount('SIGINT'), 0)
    assert.equal(target.listenerCount('SIGTERM'), 0)
  })

  test('a wait on the signal rejects with the interruption, and stays pending without one', async () => {
    const target = fakeProcess()
    const watch = watchInterrupts(target, () => undefined)
    const waited = untilInterrupted(watch.signal)
    let settled = false
    void waited.catch(() => (settled = true))
    await new Promise((done) => setTimeout(done, 20))
    assert.equal(settled, false)
    target.emit('SIGINT')
    await assert.rejects(waited, (error: unknown) => error instanceof Interrupted)
    watch.dispose()
  })
})
