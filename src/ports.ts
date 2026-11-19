// The real things the worker reaches outside itself in Orca: the network through the client's
// `fetch`, the files through the disk module, the clock through the date helper.
import { homedir } from 'node:os'
import { realFetch, type Timers } from './client'
import type { WorkerPorts } from './connection'
import { now } from './dates'
import { openDisk } from './disk'

/**
 * Orca keeps the worker running, so a waiting timer does not have to: it is unreferenced, and a
 * process that has nothing else to do (`orca plugin check`) ends without waiting for it.
 */
const timers: Timers = {
  set(run, ms) {
    const timer = setTimeout(run, ms)
    timer.unref()
    return timer
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

export function realPorts(): WorkerPorts {
  return { fetch: realFetch, openDisk, homeDir: homedir(), now, timers }
}
