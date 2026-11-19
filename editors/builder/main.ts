// The builder tab's entry: it wires the tab to Orca's frame API. Everything it draws and every
// request it sends is in tab.ts.
import { readPointer } from '../run-graph/tab.ts'
import { startBuilderTab } from './tab.ts'

/** The frame API's typed requests and posts, called by name. */
const request = orca.plugin.request as (name: string, input?: unknown) => Promise<unknown>
const on = orca.plugin.on as (event: string, handler: (payload: unknown) => void) => { dispose(): void }

const app = document.getElementById('app')
if (app !== null) {
  const tab = startBuilderTab({
    doc: document,
    app,
    readPointer,
    request: (name, input) => request(name, input),
    on: (event, handler) => on(event, handler),
    locale: orca.locale,
    timers: {
      set: (run, ms) => setTimeout(run, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    openExternal: (url) => orca.shell?.openExternal(url) ?? Promise.resolve(),
    onShown(listener) {
      const told = (): void => {
        if (document.visibilityState === 'visible') listener()
      }
      document.addEventListener('visibilitychange', told)
      return { dispose: () => document.removeEventListener('visibilitychange', told) }
    },
    observeSize(element, told) {
      const observer = new ResizeObserver(() => told(element.clientWidth, element.clientHeight))
      observer.observe(element)
      told(element.clientWidth, element.clientHeight)
      return { dispose: () => observer.disconnect() }
    }
  })
  // Orca unmounts a hidden tab: nothing outlives it.
  window.addEventListener('pagehide', () => tab.stop(), { once: true })
}
