// The run graph tab's entry: it wires the tab to Orca's frame API. Everything it draws and every
// request it sends is in tab.ts.
import { readPointer, startTab } from "./tab.js";
/** The frame API's typed requests and posts, called by name. */
const request = orca.plugin.request;
const on = orca.plugin.on;
const app = document.getElementById('app');
if (app !== null) {
    const tab = startTab({
        doc: document,
        app,
        readPointer,
        request: (name, input) => request(name, input),
        on: (event, handler) => on(event, handler),
        locale: orca.locale,
        timers: {
            set: (run, ms) => setTimeout(run, ms),
            clear: (handle) => clearTimeout(handle)
        },
        openExternal: (url) => orca.shell?.openExternal(url) ?? Promise.resolve()
    });
    // Orca unmounts a hidden tab: nothing outlives it.
    window.addEventListener('pagehide', () => tab.stop(), { once: true });
}
