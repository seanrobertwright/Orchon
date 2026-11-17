# Can an Orca plugin worker keep a live connection to Archon?

Research for ticket #4 (map: #1). Facts only; no product code.

## Short answer

Yes. A plugin worker is an ordinary, unsandboxed Node 24 process, so it can hold a
Server-Sent Events (SSE) stream to Archon open with `fetch`, spawn the `archon` CLI and
read `~/.archon`. Orca stops an idle worker after five minutes unless the manifest makes
the worker *resident*, which a `contributes.statusBarItems` entry (or a
`contributes.hooks` entry) does. The relay to panels is bounded and lossy by design, so
the panel must treat worker posts as hints and fetch state with `plugin.request`.
Paired and browser clients receive no worker posts at all and need a polling path.

## Sources and evidence levels

- **Orca source**: `stablyai/orca`, shallow clone at commit `ae3fe264` (2026-11-17).
  All file paths below are relative to that repository.
- **Orca docs**: `docs/reference/plugin-authoring.md`, `docs/reference/plugin-host-api.md`,
  `docs/reference/plugin-manifest.md`, `docs/development.md` in the same clone.
- **Installed app**: Orca desktop 1.4.261 on Windows. Only read: version strings in
  `Orca.exe` and message strings in `resources/app.asar`. Nothing was executed, loaded or
  enabled.
- **Node.js docs**: the v24 `child_process` and `globals` pages; the undici `Client`
  options page.

Evidence labels used below:

| Label | Meaning |
| --- | --- |
| code | Read in Orca's source at the commit above |
| docs | Stated in Orca's own reference docs |
| installed | Observed in the installed 1.4.261 binary or bundle without running it |
| node-docs | Stated in Node.js or undici documentation |
| inferred | A conclusion drawn from the above; not stated and not tested |

Nothing in this document was confirmed by running a plugin. The first implementation
spike should confirm the items marked *inferred*.

## 1. Runtime and Node version

| Fact | Evidence |
| --- | --- |
| A worker is a child process started with `child_process.fork` from Orca's Electron main process, not an Electron `utilityProcess`. | code: `src/main/plugins/workers/parent-process/plugin-host-process.ts` `startPluginWorker` |
| The child runs the Orca (Electron) binary as plain Node: the environment sets `ELECTRON_RUN_AS_NODE=1`. | code: `src/main/plugins/workers/parent-process/plugin-worker-env.ts` `buildPluginWorkerEnv`; `src/main/plugins/workers/plugin-host-entry.ts` header comment |
| The fork passes `execArgv: []`, so no Node flags reach the worker. `NODE_OPTIONS` is not in the environment allowlist. | code: `startPluginWorker`, `buildPluginWorkerEnv` |
| Orca pins Electron `43.8.10`; that Electron package depends on `@types/node` `24.19.2`. | code: `package.json`, `pnpm-lock.yaml` |
| The installed Orca 1.4.261 ships Electron `43.8.7` and its binary carries the Node version string `v24.22.1`. | installed |
| So workers run on Node 24 (the Node inside Electron 43). | inferred from the rows above |
| The entry is an ES module loaded with dynamic `import()`. `.ts` and `.mts` files are transpiled on load through `node:module` `registerHooks`. | code: `src/main/plugins/workers/child-runtime/plugin-host-runtime.ts` `createPluginWorkerRuntime`; `src/main/plugins/workers/child-runtime/plugin-worker-source-hooks.ts` `registerPluginWorkerSourceHooks` |
| `node:` builtins resolve "exactly as Node resolves it for a JavaScript worker". The environment filter "is not a sandbox. A worker runs as you and can read your files". | docs: `plugin-authoring.md`, worker section |
| `node:http`, `node:child_process` and `node:fs` are therefore available. | inferred (no restriction exists in the worker runtime code) |
| Global `fetch` and `Response` are stable since Node 21; `ReadableStream` and `TextDecoderStream` are stable. A streamed `Response.body` is enough to read SSE. | node-docs: `globals` |
| Global `EventSource` is experimental and needs `--experimental-eventsource`. With `execArgv: []` the worker has no `EventSource`. | node-docs + code (`startPluginWorker`); inferred combination |
| undici (which backs `fetch`) aborts a response after `bodyTimeout`, default 300 s between body chunks. Archon's 30 s heartbeat keeps a stream under that. | node-docs: undici `Client` options; inferred application |
| The worker model (Node version, lifecycle, channel) is experimental. The stability list promises only `activate(orca)`, `orca.api`, `orca.host`, `orca.commands`, `orca.events` and `orca.log`; `orca.panels` is not on it. | docs: `plugin-authoring.md`, Stability section |

Consequences for the plugin:

- Parse SSE by hand from `fetch(...).body`, or use `node:http`. Do not rely on `EventSource`.
- `process.execPath` inside the worker is the Orca binary, not `node`. (inferred)

## 2. Worker lifecycle

### Start

| Fact | Evidence |
| --- | --- |
| A worker starts on demand: a panel's `plugin.request`, a command without an `action`, an event listed in `contributes.events`, or a hook. | code: `src/main/plugins/panels/plugin-panel-bridge.ts` `PluginPanelBridge.request`; `src/main/plugins/events/plugin-event-delivery.ts` `deliverPluginEventToWorker`; docs |
| A plugin with `main` and at least one `contributes.hooks` or `contributes.statusBarItems` entry gets a resident worker: started when the plugin is enabled, flagged `keepWarm`. | code: `src/main/plugins/workers/worker-admission/plugin-resident-worker.ts` `pluginNeedsResidentWorker`, `createPluginResidentWorkerWarmer`; `worker-admission/plugin-worker-spawn-spec.ts` `buildPluginWorkerSpawnSpec`; docs: `plugin-host-api.md` `statusBar.update` and Hooks |
| Ready timeout is 10 s. Orca awaits `activate(orca)` before the worker reports ready; a worker that is not ready in time is killed and counted as a failed start. | code: `src/shared/plugins/workers/plugin-host-protocol.ts` `PLUGIN_WORKER_READY_TIMEOUT_MS`; `startPluginWorker`; `createPluginWorkerRuntime` `handleInit` |
| Non-resident workers share a pool of five running at once; extra activations queue. Resident workers use a separate, unbounded pool. | code: `PLUGIN_WORKER_MAX_ACTIVE_DEFAULT`; `src/main/plugins/workers/worker-supervision/plugin-worker-slot-pool.ts` `PluginWorkerSlots` |

### Idle stop

| Fact | Evidence |
| --- | --- |
| A sweep runs every 60 s and stops workers idle for more than 5 minutes. Production code does not override either value. | code: `PLUGIN_WORKER_REAP_INTERVAL_MS`, `PLUGIN_WORKER_IDLE_REAP_MS`; `src/main/plugins/development/plugin-service-housekeeping.ts` `PluginServiceHousekeeping.sync`; `src/main/startup/plugin-startup/main-process-plugins.ts` |
| A worker is stopped only when all of these hold: it is not `keepWarm`, it has nothing in flight, and its last activity is older than the idle window. Time the machine spent asleep is not counted. | code: `src/main/plugins/workers/worker-supervision/plugin-worker-idle-clock.ts` `PluginWorkerIdleClock.idleWorkers` |
| "In flight" counts host-to-worker requests awaiting an answer: commands, panel requests, hooks and event deliveries. | code: `startPluginWorker` (`inFlightCount`) |
| "Activity" is stamped when the worker answers a request, when the worker makes any host call (on receipt and on completion), when the worker posts to panels, and when Orca delivers an event to it. `orca.log` and storage-change notices do not count. | code: `startPluginWorker` (every `lastActivityAt = Date.now()` site) |
| Stopping sends a shutdown message; the worker awaits `deactivate()` and exits; Orca kills it after a 2 s grace period. | code: `startPluginWorker` `dispose`, `PLUGIN_WORKER_SHUTDOWN_GRACE_MS`; `createPluginWorkerRuntime` `shutdown` |

What keeps a worker alive, item by item:

| Candidate | Keeps the worker alive? | Evidence |
| --- | --- | --- |
| `contributes.statusBarItems` entry (with `main`) | Yes, for as long as the plugin is enabled | code + docs |
| `contributes.hooks` entry (with `main`) | Yes, same mechanism. It also puts the plugin on Orca's action path (Orca waits up to 2 s per hook), so it is the worse choice for keep-alive alone | code + docs |
| A pending `plugin.request` | Yes, while it is pending (at most 120 s per request) | code |
| An open panel by itself | No. The panel's push channel lives in the panel bridge and never touches the worker | code: `PluginPanelBridge.open`; inferred from the idle rule |
| An in-flight network connection or a timer inside the worker | No. Orca cannot see them | inferred from the idle rule |
| The worker calling the host or posting to panels at least once per idle window | Yes as the code stands, because each call or post stamps activity. Undocumented and part of the experimental lifecycle | code; do not depend on it |

### Crashes and restarts

| Fact | Evidence |
| --- | --- |
| An uncaught exception or unhandled promise rejection in the worker ends the process. | code: `src/main/plugins/workers/plugin-host-entry.ts` `dieFatally` |
| After a crash Orca restarts the worker up to three times with 500 ms, 2 s and 5 s delays. The next crash marks the plugin `errored`, and further starts are refused. The state clears when the worker is deactivated (a plugin change, a manual restart, disabling the plugin) or Orca restarts. The counter resets only on a fresh activation, not on a successful restart. | code: `src/main/plugins/workers/worker-supervision/plugin-supervisor.ts` `PluginSupervisor`; `src/main/plugins/workers/plugin-worker-manager.ts` `PluginWorkerManager.ensureActive`, `handleUnexpectedExit`, `deactivate` |
| The resident-worker warmer starts a worker once per approved revision. It does not start it again after an `errored` state or a manual stop; the next command, event, hook or panel request does. | code: `createPluginResidentWorkerWarmer` |
| An event handler that runs longer than 5 minutes gets the worker killed, and so does having 64 event deliveries still awaiting the worker's answer. | code: `startPluginWorker` `deliverEvent`, `PLUGIN_WORKER_EVENT_TIMEOUT_MS`, `PLUGIN_WORKER_MAX_PENDING_EVENTS` |
| A manifest change, an update or a development code edit stops the worker and, if it was running, starts it on the new code. | code: `src/main/plugins/workers/plugin-worker-controller.ts` `PluginWorkerController.reconcile` |
| The worker exits when its parent goes away. | code: `plugin-host-entry.ts` (`disconnect` handler) |

Consequences for the plugin:

- `activate` must return quickly. Open the Archon connection in the background, never
  `await` it inside `activate`: with Archon down, a slow connect would miss the 10 s
  ready timeout and burn a restart.
- Every promise chain in the worker needs a catch. A rejected `fetch` to a stopped Archon
  that nobody catches kills the worker, and the fourth such crash disables the plugin
  until someone restarts it.

### What a panel observes

| Fact | Evidence |
| --- | --- |
| Push channels are keyed by panel session and plugin, and are held by the panel bridge in the main process. They do not depend on the worker process. A restarted worker's posts reach the same open panels with no action by the panel. | code: `PluginPanelBridge.open`, `PluginPanelBridge.onWorkerPost`; `src/main/ipc/plugins/plugin-panel-push-ipc.ts` `registerPluginPanelPushHandlers` |
| The panel is not told that the worker stopped or restarted. The push envelope has only the kinds `message`, `event` and `changed`. Worker state changes go to Orca's own plugin list, not to the frame. | code: `src/shared/plugins/workers/plugin-panel-bridge-protocol.ts` `pluginPanelPushSchema`; `src/main/plugins/plugin-service.ts` (`onStateChanged`) |
| A `plugin.request` pending when the worker exits rejects with `unavailable`. The next `plugin.request` starts the worker again; it rejects with `unavailable` if the plugin is `errored`. | code: `startPluginWorker` `rejectAllPending`; `PluginPanelBridge.request`; `PluginWorkerManager.ensureActive` |
| Posts are not queued or replayed. A panel opened after a post never sees it. | code: `PluginPanelBridge.onWorkerPost` |
| The panel id a worker receives in a request context is stable only while that panel stays open; a restarted worker has forgotten the ids it knew. Broadcast posts need no id. | code: `pluginPanelCallerSchema` comment; inferred |
| The worker is not told when a panel opens or closes. The only signal is the `signal` of a pending request, which aborts when its panel closes. | code: `PluginPanelBridge.close`, `PluginPanelBridge.request` |

## 3. Spawning the `archon` CLI and reading `~/.archon`

| Fact | Evidence |
| --- | --- |
| The worker's environment is an allowlist: `PATH`, `HOME`, `USERPROFILE`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `TEMP`, `TMP`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`, and for Windows `SYSTEMROOT` (emitted as `SystemRoot`), `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `PATHEXT`, `PROCESSOR_ARCHITECTURE`, `NUMBER_OF_PROCESSORS`. Orca adds `GIT_TERMINAL_PROMPT=0` and `ELECTRON_RUN_AS_NODE=1`. | code: `buildPluginWorkerEnv`, `WORKER_ENV_ALLOWLIST` |
| On Windows the lookup is case-insensitive, so a `Path` variable arrives as `PATH`. | code: `buildPluginWorkerEnv` |
| Everything else is withheld. On Windows that includes `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `ProgramFiles`, `HOMEDRIVE`, `HOMEPATH` and `USERNAME`; on every platform it includes API keys, tokens, proxy variables and any Archon-specific variable set in the user's shell. | inferred from the allowlist |
| `PATH` is the main process's `PATH` at fork time. Orca's main process merges the login shell's `PATH` into its own, so tools installed by shell profile are normally found. | code: `buildPluginWorkerEnv` (reads `process.env`); `src/main/startup/shell-environment/hydrate-shell-path.ts`; timing relative to the first worker start is inferred |
| There is no sandbox, seccomp profile or file-system fence on the worker. | docs: `plugin-authoring.md`; code: nothing of the kind in `src/main/plugins/workers` |
| `os.homedir()` resolves through `USERPROFILE` on Windows and `HOME` elsewhere, both kept, so `~/.archon` is readable with `node:fs`. | inferred (Node behaviour plus the allowlist) |
| A child process inherits the worker's environment unless the worker passes `env`. | node-docs: `child_process.spawn` default `env` |
| On Windows, `.bat` and `.cmd` files cannot be launched with `execFile`; they need `spawn` with `shell`, `exec`, or `cmd.exe /c`. `COMSPEC` and `PATHEXT` are kept, so the shell route works. | node-docs: "Spawning .bat and .cmd files on Windows"; code: allowlist |
| On the Windows machine used for this research, `archon` on `PATH` resolves to `.exe` files: a Bun shim (`archon.exe` beside `archon.bunx`) under `~/.bun/bin`, and a compiled binary under `~/.archon/bin`. A plain `spawn('archon', args)` resolves an `.exe` without a shell. | observed locally; the spawn itself was not run from a worker |

Consequences for the plugin:

- Reading `~/.archon` and running short read-only `archon` commands is feasible on every
  platform. Handle both forms on Windows: try the `.exe` directly, and fall back to a
  shell only for a `.cmd` shim.
- Build the child's environment explicitly. Remove `ELECTRON_RUN_AS_NODE` and
  `GIT_TERMINAL_PROMPT` from it: an inherited `ELECTRON_RUN_AS_NODE=1` would make any
  Electron-based program started further down that process tree run as Node. (inferred)
- A CLI child started from the worker runs without the user's API keys and without
  `APPDATA` or `LOCALAPPDATA`. Starting or resuming workflow runs through the CLI from the
  worker is therefore doubtful; the Archon HTTP server runs in the user's own environment
  and is the safer route for run control. Whether the CLI works under the filtered
  environment is not tested. (inferred)
- A non-default Archon port or home directory set through the user's shell environment
  never reaches the worker. The plugin needs its own settings for the base URL and the
  Archon home directory. (inferred)
- Orca kills a stopping worker after 2 s and does not kill its children. The worker's
  `deactivate()` should end any child it started and abort its stream. (inferred)

## 4. Relay limits in practice

Sizes are an estimate of the structured value (UTF-8 bytes of strings and keys, 8 bytes
per number, small per-entry overheads), not the JSON text length. The same walk refuses
any value with more than 10,000 objects and arrays, deeper than 100 levels, or containing
a class instance, whatever its byte size.
(code: `src/shared/plugins/frames/plugin-panel-message-budget.ts` `structuredCloneMessageBytes`)

| Limit | Value | Enforced in | When exceeded | Evidence |
| --- | --- | --- | --- | --- |
| `plugin.request` answer | 1 MiB, JSON only | Main process, after the worker answers: `PluginPanelBridge.request` | The panel's call rejects with `too_large` ("answered with more than 1 MiB"); a non-JSON answer rejects with `action_failed` | code; docs |
| Panel host call, including `plugin.request` input | 64 KiB for the whole call envelope | The renderer frame host, then main `PluginPanelController.execute` through `admitPluginPanelCall`. The frame's preload applies a slightly looser pre-check first | Rejects with `too_large` | code: `PANEL_MESSAGE_MAX_BYTES`; `src/renderer/src/components/plugins/frames/plugin-frame-host.ts`; `src/preload/plugins/frames/plugin-frame-guest-send-budget.ts` `PRELOAD_PLUGIN_FRAME_LANES` |
| Panel host calls | 120 per 10 s, counting every method. Per frame in the renderer frame host; per plugin, across all its panels, in main | Renderer frame host and main `admitPluginPanelCall`. The preload pre-check allows 600 per 10 s | Rejects with `rate_limited` (retryable; the renderer and preload layers add `retryAfterMs`) | code: `PANEL_MESSAGE_RATE_LIMIT`; `src/shared/plugins/frames/plugin-panel-call-admission.ts` `createPluginPanelCallAdmission`; `PRELOAD_PLUGIN_FRAME_RATE` |
| Panel calls in flight per frame | 256 | Frame shell | Rejects with `rate_limited` | code: `src/shared/plugins/frames/plugin-panel-shell.ts` (`maxPending`) |
| `plugin.request` timeout | Default 30 s, maximum 120 s; a larger `timeoutMs` fails validation | Schema, then main process timer; the frame shell has its own 120 s deadline | Rejects with `timeout`; the handler's `signal` aborts | code: `PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS`, `PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS`; `src/main/plugins/workers/parent-process/plugin-worker-requests.ts` `sendPluginWorkerRequest`; docs |
| `orca.panels.post` payload | 256 KiB | Main process: `PluginPanelBridge.onWorkerPost` | Dropped. One warning line in the plugin log ("payload over 256 KiB"). The worker gets no error: `post` returns nothing | code; docs ("fire and forget") |
| `orca.panels.post` rate | 200 per 10 s per plugin, across its panels | Main process: `PluginPanelBridge.onWorkerPost` | Dropped with a log line ("too many posts"). Oversized posts and posts sent while no panel is open still spend the budget | code: `PLUGIN_PANEL_POST_RATE_LIMIT`, `createPanelMessageBudget` |
| Worker command | 30 s | Main process | Rejects with `timeout` | code: `PLUGIN_WORKER_INVOKE_TIMEOUT_MS` |
| Worker stdout or stderr line | 8192 characters | Main process | Truncated | code: `src/main/plugins/workers/parent-process/plugin-worker-output-buffer.ts` |

The installed 1.4.261 bundle contains the same refusal messages ("answered with more
than 1 MiB", "payload over 256 KiB", "too many panel requests"), so these limits are
live in the shipped build. (installed)

Consequences for the plugin:

- The worker cannot detect a dropped post. Treat posts as "something changed" hints and
  let the panel fetch the current state with `plugin.request`; fetch a snapshot when the
  panel mounts.
- Coalesce a burst of SSE events into a few posts per second; 200 per 10 s is easy to
  exceed during a busy run.
- The 10,000-object rule bites before 1 MiB for lists of small records. Page run lists
  and node lists rather than answering with everything.

## 5. Rate limits on host calls from a polling worker

| Fact | Evidence |
| --- | --- |
| Host calls from a worker pass through no rate limiter. The only `rate_limited` sources are the panel and frame budgets above, the confirmation dialog gate and the desktop frame actions. | code: `src/main/plugins/workers/host-api/plugin-host-methods.ts` `executePluginHostCall`; search for `rate_limited` across `src/main/plugins` |
| `statusBar.update`: no capability, no limit, not audited ("possibly many times a minute"). Each call replaces the override snapshot and notifies the windows. Desktop app only. | code: `src/shared/plugins/workers/plugin-host-api-status-bar.ts`; `src/main/plugins/status-bar/plugin-status-bar-state.ts` `PluginStatusBarState.update`; docs |
| `notifications.show`: needs `notifications:show`; no limit or de-duplication in the plugin path. Each call raises an OS notification titled with the plugin key, relays to mobile clients and writes an attempt line and an outcome line to the audit log. | code: `src/main/runtime/push/notifications/runtime-mobile-notification-controller.ts` `dispatchPlugin`; `src/main/host/electron-runtime-desktop-surface.ts` `showNotification`; `executePluginHostCall` |
| `storage.set`: needs `storage:own`; no rate limit. Caps: 256 KiB per value, 5 MiB per plugin, 1024 keys. Each call reads and rewrites the plugin's whole storage file synchronously in the main process, writes an attempt line and an outcome line to the audit log, and notifies every open panel and the worker. | code: `src/shared/plugins/workers/plugin-host-api-storage-schemas.ts`; `src/main/plugins/storage/plugin-storage-store.ts` `PluginKvStore.set`; `src/main/plugins/workers/host-api/plugin-host-method-bindings.ts` (`changed`) |
| The audit log is shared by all plugins and rotates at 10 MiB with one old file kept. | code: `src/main/plugins/logging/plugin-audit-log.ts` `PluginAuditLog` |

Consequences for the plugin: nothing will throttle a polling worker, so the plugin must
throttle itself. Update the status bar only when its text changes, notify once per run
transition, and do not write storage on every stream event.

## 6. Remote workspaces and paired or browser clients

| Fact | Evidence |
| --- | --- |
| The worker is always a local child of the Orca process that hosts the plugin service. There is no code path that starts a worker on an SSH or WSL host. | code: `startPluginWorker`; `src/main/startup/plugin-startup/main-process-plugins.ts` `initializeMainProcessPlugins` |
| "For an SSH or WSL terminal or workspace, that is the desktop"; "A paired client reaching a remote Orca server is decided by that server's plugins." | docs: `plugin-host-api.md`, Hooks section |
| So with an SSH or WSL workspace the worker runs on the desktop machine. `127.0.0.1:3090`, the `archon` on `PATH` and `~/.archon` are the desktop's, not the remote host's. | inferred |
| With a paired or browser client the plugin and its worker run on the Orca server the client is paired to. Archon must be reachable from that machine. | docs + inferred |
| Worker posts reach desktop windows only. The push subscription is an Electron IPC channel, typed "desktop only", and it is the only caller of `PluginPanelBridge.open`. The runtime RPC that serves paired clients has `plugins.panelAction` and `plugins.readPanelEntry` but no push method. | code: `registerPluginPanelPushHandlers`; `src/preload/api/plugins/plugin-host-api.ts` (`subscribePanelPush`); `src/main/runtime/rpc/methods/plugins/plugins.ts` |
| A browser client can still call `plugin.request`, relayed through `plugins.panelAction`. | code: `plugins.ts` (`plugins.panelAction`) |
| Browser clients load a frame as one sandboxed document with `connect-src 'none'`. Components panels (`"ui": "components"`) are not shown there. | docs: `plugin-authoring.md`; `plugin-declarative-ui.md` |
| `statusBar.update` is desktop only. | docs |

## Verdict

**A held-open SSE connection in the worker is workable.**

Manifest conditions:

- `"execution": "trusted-worker"`, a `main` entry and `"pluginApi": 1`.
- At least one `contributes.statusBarItems` entry. This is the documented way to get a
  worker that starts when the plugin is enabled and is never stopped for idleness. It
  needs `engines.orca` `>=1.4.248`. A hook entry has the same effect but should not be
  used for this.
- Capabilities only for the host methods used: `storage:own` and `settings:own` if the
  worker keeps a cursor or reads settings, `notifications:show` for notifications.
  Network, file and process access need no capability.

Without a status bar item the worker starts on the first `plugin.request` and is stopped
five to six minutes after its last activity. As the code stands, a worker that posts or
calls the host on each 30 s heartbeat would never be idle, but that is an undocumented
detail of an experimental lifecycle.

Worker rules that follow from the findings:

1. Connect in the background; `activate` returns at once.
2. Catch every rejection; reconnect with backoff when Archon is down or the stream drops.
3. Read SSE from `fetch` and parse it by hand.
4. Rebuild state from an Archon snapshot after every start. Worker memory does not
   survive restarts, updates or an Orca restart.
5. Post coalesced change hints; the panel pulls state with `plugin.request` in pages.
6. Abort the stream and end child processes in `deactivate()`.

**Fallback if the stream is not usable** (or where posts do not arrive):

1. Worker polling: the resident worker polls Archon's HTTP API on a timer and posts a
   hint when something changed. Same relay path, no long-lived connection.
2. Panel polling: the panel calls `plugin.request` on a timer and the worker answers
   from Archon. This works for a non-resident worker and is the only route that works in
   paired and browser clients. Budget: 120 panel calls per 10 s per plugin.
3. Long poll: the panel holds one `plugin.request` open for up to 120 s and the worker
   answers when something changes. It also tells the worker when the panel closes.

## Open points for the plan

- Paired and browser clients get no worker posts, and components panels do not render
  there. Decide whether the first version is desktop only or carries the polling path.
- Run control through the CLI from the worker is doubtful because of the filtered
  environment. Prefer the HTTP API for actions; test the CLI under that environment
  before depending on it.
- Archon on an SSH host or inside WSL is not at the desktop's `127.0.0.1` by default.
  The base URL must be a setting, and reaching a remote Archon is its own question.
- `orca.panels` is missing from the list of promised worker APIs, and the worker
  lifecycle is marked experimental. Pin `engines.orca` and re-check on Orca updates.
- Not verified by execution: `fetch` streaming inside a real worker, the CLI under the
  filtered environment, and the idle behaviour of a resident worker.
