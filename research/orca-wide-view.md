# How an Orca plugin can show a wide view in the main editor area

Research for ticket #3. Plan only: facts about Orca, no product code.

## Short answer

- Orca has no plugin tab type. The only plugin-drawn surface in the main
  area is a **custom editor inside an ordinary editor tab**, and an editor
  tab is always backed by a real file inside a workspace. There are no
  virtual documents.
- A worker can put such a tab on screen itself: write a small file inside
  a workspace, then call `editor.open`. If that file's suffix belongs to
  the plugin's custom editor, the tab shows the plugin frame at full
  editor width. This is the workable route for the run graph and the
  builder, on the desktop app only.
- A right-sidebar panel can be dragged very wide (window width minus 320
  px), but the width is one shared, user-owned value for the whole
  sidebar. It cannot be set, maximised or popped out by a plugin.
- `.yaml` and `.yml` are only ever offered in the view toggle. A compound
  suffix such as `.archon.yaml` is not a core type and opens in the
  plugin editor by default. A `filenames` match also opens by default,
  but it matches exact base names only, so it cannot cover arbitrary
  workflow names. Nothing matches on directory.
- An editor frame can do everything a panel frame can (same host methods,
  `plugin.request`, worker posts, events, storage) plus `orca.document`.
- In a browser client the bundled web client lists no plugins at all, so
  none of this appears there.

## Sources and method

- Orca source, `stablyai/orca` at commit
  `ae3fe2642ce3b030508535ae25f1f055f9ca608b` (shallow clone, read only).
- Orca docs in that tree: `docs/reference/plugin-authoring.md`,
  `plugin-manifest.md`, `plugin-host-api.md`, `plugin-isolated-frames.md`,
  `plugin-declarative-ui.md`.
- The installed Orca CLI, version 1.4.261, help output and bundled skill
  guides only (`orca plugin --help`, `orca plugin open --help`,
  `orca tab create --help`, `orca file open --help`,
  `orca skills get orca-plugin-authoring`).

Nothing was run inside Orca: no plugin was loaded, no tab was opened.
Every claim carries one of these marks:

- **[code]** read in the source at the commit above.
- **[docs]** read in Orca's reference docs or CLI help.
- **[inferred]** follows from the code or docs but was not seen stated,
  and was not exercised.

## What can sit in the main area

Main-area tabs come from a closed list of kinds: `terminal`, `editor`,
`diff`, `conflict-review`, `check-details`, `git-graph`, `agent-session`,
`browser`, `simulator`. There is no plugin kind. **[code]**
`src/shared/workspace-layout/tab-groups/tab-types.ts` `TabContentType`

A plugin reaches the main area in exactly one way: its custom editor is
chosen as the view of an `editor` tab. The frame is mounted by
`PluginCustomEditorFrame` for the tab's active file. **[code]**
`src/renderer/src/components/editor/plugin-editors/PluginCustomEditorFrame.tsx`

The reserved contribution points (`sidebarCards`, `taskSources`,
`connections`, `agentHarnesses`, `mcpServers`, `skills`) must stay empty,
and each is planned as "declared data that Orca renders and enforces,
never arbitrary plugin UI". **[docs]** `plugin-manifest.md`, "Planned
contribution points"

## Way 1: a view file opened by the worker (recommended)

### How it works

1. The worker writes a small file inside a workspace. Its suffix is one
   only this plugin claims, for example `.archonrun`. Its content is a
   pointer the frame can read, for example a run id as JSON.
2. The worker calls `editor.open({ workspaceId, path })`.
3. Orca opens an editor tab for that file. The suffix is not a core file
   type, so the plugin's custom editor takes the tab by default.
4. The frame reads the pointer with `orca.document.get()`, then pulls the
   real data from the worker with `orca.plugin.request` and listens for
   worker posts with `orca.plugin.on`.

The trigger can be anything that reaches the worker: a button in the
sidebar panel (`plugin.request`), a palette command, a keybinding, or a
status bar item's `command`. **[docs]** `plugin-host-api.md`,
`plugin-manifest.md`

### What `editor.open` accepts

- Worker only, capability `workspace:write`, "desktop app only". **[docs]**
  `plugin-host-api.md`
- `path` must be relative to the workspace: no drive letter, no leading
  separator, no `..` segment. **[code]**
  `src/shared/plugins/workers/plugin-host-api-workspace-methods.ts`
  `isPluginWorkspaceRelativePath`, `editorOpenParams`
- The renderer joins the path onto the workspace root and opens that
  file. The workspace is a Git worktree or a folder workspace, looked up
  from the id `workspace.list` gives. **[code]**
  `src/renderer/src/components/plugins/view/plugin-view-host-actions.ts`
  `openWorkspaceFile`, `resolveWorkspace`
- With no Orca window, the call fails with `unavailable` ("Orca has no
  window open to do this in"). **[code]**
  `src/main/plugins/view/plugin-host-renderer-actions.ts` `ask`
- It opens the tab in that workspace; it does not switch the window to
  the workspace. `workspace.open` does that. **[docs]**
  `plugin-host-api.md`

So the answer to "where can the worker write the file" is: only inside a
workspace root. The plugin data directory and the temp directory are not
reachable through `editor.open` unless that directory is itself a
workspace. **[code]**

### Where to put the view file

- **Inside the repository worktree.** Always available. The file is
  visible to Git as untracked unless it sits under an ignored path.
  Whether Archon already ignores anything under `.archon/` is not
  established here. **[inferred]**
- **Inside a folder workspace.** `workspace.list` rows have
  `kind: "folder"` and a `path`, and `editor.open` resolves folder
  workspaces. A user who adds a folder to Orca once (for example the home
  Archon folder) gives the plugin a place for view files that touches no
  repository, and also makes home-scoped workflow files openable. The
  plugin cannot create a folder workspace itself: `workspace.create`
  makes a branch and worktree in a Git project only. **[code]**
  `resolveWorkspace` (as above); **[docs]** `plugin-host-api.md`
- A workspace on an SSH or runtime host has its `path` on that host. The
  worker runs on the desktop, so it cannot write there with Node's file
  system. The view-file route is for local workspaces. **[inferred]**

### Limits

- Desktop app only, and a workspace must exist. **[docs]**
- The file must exist and load before the editor is offered: a tab whose
  content failed to load, a read-only tab, a binary file (for a text
  editor) and a file in a merge conflict keep the Source view. **[code]**
  `src/renderer/src/components/editor/panel/editor-panel-render-model.ts`
  (the `textEditorEligible` condition)
- The tab label is the file name, so the file name is the screen title.
  The editor's `title` shows in the view toggle and the tab hover card,
  and its `icon` on the tab. **[code]**
  `src/renderer/src/components/editor/panel/header/editor-labels.ts`
  `getEditorDisplayLabel`;
  `src/renderer/src/components/tab-bar/editor-tabs/EditorFileTab.tsx`
- The frame never learns the file's path or name, so identity must be in
  the file's content. **[docs]** `plugin-authoring.md`, "Custom editors"
- The frame exists only while its tab is the active file of its tab
  group; switching tabs unmounts it. Keep state in the worker or in
  plugin storage. **[inferred]** from `EditorPanel` rendering one active
  file,
  `src/renderer/src/components/editor/EditorPanel.tsx`
- The user can always switch the tab to Source and see the pointer text.
  **[code]** `resolveCustomEditorChoice` in
  `src/renderer/src/store/plugins/file-editors/plugin-custom-editors.ts`
- View files are left on disk when the tab closes. Cleaning them up is
  the worker's job. **[inferred]**

## Way 2: an untitled file from `contributes.newFiles`

### How it works

A `newFiles` entry adds an item to the tab bar + menu and the command
palette. Choosing it creates a real file named `untitled<extension>` (or
`untitled-<n><extension>`) at the **root of the active workspace** and
opens it; the plugin's custom editor takes it when it claims the suffix.
**[code]**
`src/renderer/src/store/slices/editor/opening/untitled-file-creation.ts`
`openSeededUntitledFile`, `createUntitledFileInActiveWorkspace`;
`src/renderer/src/lib/editor/file-operations/create-untitled-markdown.ts`
`createUntitledMarkdownFile`, `untitledFileNameWith`

These details make it usable as a "screen" rather than a document:

- With no `template` (or an empty one) the file starts at zero bytes, and
  Orca deletes it when the tab closes if it is still untouched and still
  empty. With a non-empty template the file is kept. **[code]**
  `src/main/plugins/contributions/plugin-new-file-template.ts`
  `readApprovedPluginNewFileTemplate`;
  `src/renderer/src/store/slices/editor/tabs/untitled-file-cleanup.ts`
  `shouldDeleteUntouchedUntitledFile`, `deleteUntouchedUntitledFile`
- Chosen from the floating workspace's + menu, the file is created in
  Orca's own floating directory (under its user data), not in a
  repository, and the tab lives in the floating panel. The built-in
  action `floatingWorkspace.maximize` exists and a worker may run it with
  `commands.run`. **[code]** `openSeededUntitledFile` (as above);
  `src/main/ipc/worktrees/floating-workspace-directory.ts`
  `getDefaultFloatingWorkspacePath`;
  `src/shared/plugins/contributions/plugin-command-actions.ts`
  `PLUGIN_COMMAND_ALIAS_ACTION_IDS`

### Limits

- Only the user can trigger it. No host method creates a plugin new
  file, so a panel button cannot open this tab. **[code]** (no such
  method in `src/shared/plugins/workers/`); **[docs]**
  `plugin-host-api.md`
- The tab is labelled `untitled<extension>`. **[code]**
- The file carries no pointer, so it suits one fixed screen (a console
  home with its own internal navigation), not "open run X".
  **[inferred]**
- While the tab is open, a zero-byte file sits at the workspace root.
  **[code]**
- What a save does to an untitled view file was not checked.

## Way 3: the workflow YAML file itself in a custom editor

### How matching works

- A file matches by exact base name (`filenames`) or by the longest
  listed suffix (`extensions`), ignoring case. Only the base name is
  looked at; there is no directory or glob match. **[code]**
  `src/shared/plugins/contributions/plugin-file-match.ts`
  `matchPluginFile`, `pluginFileBaseName`
- Whether a `priority: "default"` editor may actually open a file by
  default is decided by `customEditorMayOpenByDefault`: **[code]**
  `src/shared/plugins/contributions/plugin-custom-editor-core-file-types.ts`
  - never for a base name in `CORE_FILE_NAMES` (lockfiles,
    `package.json`, `pnpm-workspace.yaml` and similar) or an `.env` file;
  - always for a `filenames` match otherwise;
  - for an `extensions` match, only when the matched suffix without its
    leading dot is not in `CORE_FILE_TYPES`. `yaml` and `yml` are in that
    set; `archon.yaml` is not.

### What that means for Archon workflows

| Manifest match | `foo.yaml` | `foo.archon.yaml` |
| --- | --- | --- |
| `extensions: [".yaml"]` | Source; toggle | Source; toggle |
| `extensions: [".archon.yaml"]` | no match | plugin editor |
| both suffixes listed | Source; toggle | plugin editor |
| `filenames: ["foo.yaml"]` | plugin editor | no match |

- Existing workflow files have arbitrary `*.yaml` names, so they open in
  Source and the builder is one click away in the view toggle. **[code]**
- Claiming `.yaml` puts the builder in the toggle of **every** YAML file
  in every workspace, because matching cannot be limited to
  `.archon/workflows/`. The frame has to recognise a non-workflow
  document from its content and say so. **[code]** for the matching,
  **[inferred]** for the consequence
- The user's toggle pick is kept per open file and for the session only;
  after a restart the file is back in Source. **[code]**
  `useCustomEditorViewStore` in
  `src/renderer/src/store/plugins/file-editors/plugin-custom-editors.ts`
- A worker's `editor.open` does not set that pick, so it cannot land a
  plain `.yaml` in the builder. The CLI's `orca plugin open <key>
  --editor <file>` does set it, but that is a developer command, not a
  host method. **[code]** `openWorkspaceFile` versus `openEditor` in
  `src/renderer/src/components/plugins/view/plugin-view-request-handler.ts`
- Files the plugin creates itself can be named `<name>.archon.yaml`.
  They then open in the builder by default, including through
  `editor.open`. Whether Archon loads a workflow file with that double
  suffix like any other `*.yaml` is a question for the Archon tickets.
  **[code]** for Orca's side, **[inferred]** for Archon's
- Home-scoped workflows (`~/.archon/workflows/`) are outside every
  workspace unless the user adds that folder as a folder workspace, so
  `editor.open` cannot reach them otherwise. **[code]**

When the YAML file is the document, Orca keeps the buffer, dirty state,
saving, the external-change banner and remote files; the frame gets the
text and posts full-text edits back through `orca.document.session()`.
Orca keeps no undo history for a custom editor. **[docs]**
`plugin-authoring.md`, "Custom editors"

The alternative for the builder is Way 1 with a pointer file: it opens
in the builder by default for any workflow, home-scoped ones included,
but then the worker reads and writes the YAML and Orca's dirty state and
save apply to the pointer, not the workflow. **[inferred]**

## Way 4: the right-sidebar panel, dragged wide

- Minimum width 220 px. Maximum is the window width minus 320 px, minus
  40 px more when the activity bar sits on the side. On a 1920 px window
  that is 1600 or 1560 px. The left sidebar is not subtracted. **[code]**
  `src/renderer/src/components/right-sidebar/layout/right-sidebar-width.ts`
  `RIGHT_SIDEBAR_MIN_WIDTH`, `RIGHT_SIDEBAR_MIN_NON_SIDEBAR_AREA`,
  `RIGHT_SIDEBAR_SIDE_ACTIVITY_BAR_WIDTH`,
  `computeMaxRightSidebarPanelWidth`
- The only width control is the drag handle on the sidebar's left edge.
  **[code]** `RightSidebarInner` in
  `src/renderer/src/components/right-sidebar/RightSidebar.tsx`;
  `src/renderer/src/hooks/useSidebarResize.ts` `useSidebarResize`
- The width is a single persisted value (`rightSidebarWidth`) shared by
  every sidebar tab: Explorer, Source Control and every plugin panel get
  the same width. **[code]** `RightSidebarInner`
- No maximise, pop-out or detach control exists for the sidebar or a
  panel, and no host method sets the width or selects a panel. A worker
  can only toggle the sidebar with `commands.run` and
  `sidebar.right.toggle`. The `--width` of `orca plugin shot` applies to
  one capture. **[code]** `RightSidebarInner`,
  `PLUGIN_COMMAND_ALIAS_ACTION_IDS`; **[docs]** `plugin-authoring.md`,
  "See the panel"
- A plugin panel is mounted only while its tab is the one shown.
  **[code]**
  `src/renderer/src/components/right-sidebar/right-sidebar-panel-content.tsx`
  `RightSidebarPanelContent`

A panel is therefore a workable wide surface only when the user chooses
to drag it, and it takes the width from the main area while it is open.

## Way 5: an Orca browser tab (outside the plugin API)

`browser` is a main-area tab kind, and the CLI can create one with
`orca tab create --url <url>`. **[code]** `TabContentType`; **[docs]**
`orca tab create --help`

Such a tab can show any local web page at full width with a working
network, including a web console that Archon or the plugin's worker
serves on localhost. It is not a plugin surface: there is no
`window.orca`, no host method opens it, and frames cannot embed it
(`frame-src 'none'`, no network). The user opens it, or something runs
the CLI. **[code]** `PLUGIN_GUEST_CSP` in
`src/shared/plugins/frames/plugin-panel-shell.ts`; **[docs]**
`plugin-host-api.md`, `plugin-isolated-frames.md`

A worker is an unsandboxed Node process, so it could start the `orca`
CLI itself. That is outside the host API contract and was not tested.
**[inferred]** from `plugin-authoring.md` ("it is not a sandbox")

## What does not work

- **Virtual documents.** Every editor tab has a file path under a
  workspace root (or the floating directory). **[code]**
- **Files in the plugin data or temp directory** through `editor.open`.
  **[code]**
- **Popping out or maximising a panel.** **[code]**
- **Board and tasks views.** `workspace.openBoard` and `view.tasks` are
  built-in actions a plugin can run or replace with a worker command; a
  replacement runs code, it does not draw in those views. **[docs]**
  `plugin-authoring.md`, `plugin-manifest.md`
- **A `components` (Orca-drawn) UI in an editor tab.** `ui` is a panel
  field; a custom editor `entry` is an HTML page or a module in a frame
  that brings its own UI runtime. **[docs]** `plugin-manifest.md`,
  `plugin-authoring.md`

## Editor frame compared with panel frame

Same:

- **Host methods.** Every method's surface list is all three surfaces,
  worker only, or both frame kinds together; no method is offered to a
  panel and not to an editor, or the reverse. **[code]**
  `src/shared/plugins/workers/plugin-host-method-spec.ts` `ALL_SURFACES`,
  `FRAMES_ONLY`, `WORKER_ONLY`
- **`window.orca` helpers.** `orca.plugin.request`, `orca.plugin.on`,
  `orca.storage`, `orca.settings`, `orca.secrets` and `orca.on` for
  workspace, agent and editor events are added to the frame API for both
  surfaces. **[code]** `frameApiScript` in
  `src/shared/plugins/frames/plugin-panel-shell.ts`;
  `src/shared/plugins/frames/plugin-panel-shell-facades.ts`
  `PLUGIN_FRAME_FACADES_SCRIPT`
- **Worker posts.** `orca.panels.post` goes to every open frame of the
  plugin, editors included, and a request handler's caller names its
  surface (`panel` or `editor`) and contribution id. **[code]**
  `src/shared/plugins/workers/plugin-panel-bridge-protocol.ts`
  `pluginPanelCallerSchema`;
  `src/main/plugins/panels/plugin-panel-bridge.ts` `PluginPanelBridge`;
  `src/renderer/src/components/plugins/frames/use-plugin-frame-host.ts`
  `usePluginFrameHost`
- **Budgets.** A `plugin.request` input is at most 64 KiB and an answer
  1 MiB; a post is at most 256 KiB, with 200 posts per 10 s per plugin;
  frame calls are limited to 120 per 10 s per plugin. **[code]**
  `plugin-panel-bridge-protocol.ts` constants;
  `src/shared/plugins/frames/plugin-frame-bridge.ts`
  `PANEL_MESSAGE_RATE_LIMIT`, `PANEL_MESSAGE_MAX_BYTES`
- **Isolation.** Same isolated guest on desktop: own origin, no network,
  assets by relative URL, `localStorage` and IndexedDB per plugin.
  `shell.openExternal` and `files.saveAs` need a click in the frame.
  **[docs]** `plugin-isolated-frames.md`

Editor only:

- `orca.document` (`get`, `onDidChange`, `applyEdit`, `session`) and the
  `editor.flush` request before a save. **[code]**
  `src/shared/plugins/frames/plugin-panel-shell-document.ts`
  `PLUGIN_FRAME_DOCUMENT_SCRIPT`
- Orca's save shortcut pressed inside the frame saves the tab. **[code]**
  `PluginCustomEditorFrame`
- `"frame": "isolated"` in the manifest, which refuses the fallback
  frame. **[docs]** `plugin-manifest.md`

Panel only:

- `"ui": "components"`, where Orca draws the UI. **[docs]**
- A right-sidebar tab that needs no file and no workspace file write.

Neither frame can call worker-only methods (`editor.open`,
`workspace.list`, `terminal.*`, `agent.launch`, `commands.run`); both go
through `plugin.request` to the worker for those. **[docs]**
`plugin-host-api.md`

## Browser clients (`orca serve` in a web browser)

- The bundled web client implements `getAutoUpdateState`,
  `takeUpdateReviewNotices` and `getInstallCounts` for plugins and
  nothing else; its own comment says "Desktop-only: plugins run in the
  desktop app". Every other call, `list` included, falls through to a
  default result, which for `list` is an empty array. So a browser
  client shows no plugin panels and no custom editors; files open in
  Source. **[code]**
  `src/renderer/src/web/preload-api/host-capabilities/web-plugins-api.ts`
  `createWebPluginsApi`;
  `src/renderer/src/web/preload-api/web-fallback-api.ts`
  `withFallback`, `getFallbackResult`;
  `src/renderer/src/store/plugins/catalog/plugin-contribution-catalog.ts`
  `usePluginPanelsStore`
- The server's RPC has `plugins.list`, `plugins.readPanelEntry` and
  `plugins.panelAction`, but no method that serves a custom editor
  entry; that exists as desktop IPC only. **[code]**
  `src/main/runtime/rpc/methods/plugins/plugins.ts` `PLUGIN_METHODS`;
  `src/main/ipc/plugins/plugin-frame-entry-ipc.ts`
  `registerPluginFrameEntryHandlers`
- `editor.open`, `commands.run`, `statusBar.update`,
  `shell.openExternal` and `files.saveAs` are "desktop app only", and a
  headless server refuses `orca plugin open` and `orca plugin shot`.
  **[docs]** `plugin-host-api.md`; **[code]**
  `src/main/runtime/rpc/methods/plugins/plugin-view.ts`
  `requirePluginView`
- The docs describe a fallback in which a browser client loads a frame
  as one sandboxed `srcdoc` document: inline scripts and styles only,
  `data:` images and fonts, `connect-src 'none'`, no workers or WASM by
  URL, no `orca.shell` or `orca.files`. That shell exists in the source
  and is what the desktop app uses when isolated frames are switched
  off. With `"frame": "isolated"` such a client shows Source and a
  notice instead. **[docs]** `plugin-authoring.md`,
  `plugin-isolated-frames.md`; **[code]** `PLUGIN_PANEL_CSP`,
  `buildPluginPanelShellHtml`

The docs and the web client disagree. Reading the code, the fallback
frame is reachable today on the desktop app with isolation off, not in
the bundled browser client. Treat the plugin as desktop only.

## Ranked recommendation

1. **Custom editor tabs as the wide surface, opened by the worker (Way
   1), with the sidebar panel as the narrow home.** The panel holds the
   runs list, launcher, chat and status at sidebar width. "Open graph"
   and "Open builder" go panel to worker by `plugin.request`; the worker
   writes or locates the file and calls `editor.open`. One custom editor
   entry per screen kind, each with its own suffix. Set
   `"frame": "isolated"` on editors that load a canvas library. This is
   the only route that is in the documented contract, plugin-triggered
   and full width.
2. **For the builder, edit the workflow YAML as the document where Orca
   can open it (Way 3), and name plugin-created workflows
   `<name>.archon.yaml`.** List `.archon.yaml`, `.yaml` and `.yml` on the
   builder editor: new files open in the builder by default, existing
   ones get it in the toggle. Fall back to a pointer file (Way 1) for
   workflows no workspace contains. Confirm first that Archon accepts
   the double suffix.
3. **Add a `newFiles` entry as a user-driven "open the console" door (Way
   2)**, with no template so the placeholder cleans itself up. Cheap to
   add, useful from the floating workspace, not a substitute for 1.
4. **Design the panel to work at any width (Way 4)** so a user who drags
   the sidebar wide gets a usable graph there, but do not depend on it.
5. **Keep the browser tab (Way 5) in mind as a fallback**, not as part
   of the plugin: it is the only main-area surface with a network, and
   it is outside the plugin API.

## Effects on the plan

- **Desktop only.** Browser clients show no plugin UI at this commit, so
  "works in `orca serve`" should leave the requirements, or become an
  explicit non-goal.
- **View files are a design item of their own.** Where they live (in the
  worktree or in a dedicated folder workspace), what they are called
  (the name is the tab title), how they are kept out of Git, and when
  the worker deletes them all need a decision.
- **Home-scoped workflows need a workspace.** Either the user adds the
  home Archon folder to Orca as a folder workspace, or the builder edits
  them through a pointer file and the worker.
- **State must survive unmounts.** Both a panel and an editor frame are
  torn down when their tab is not showing, so run state, chat scrollback
  and builder drafts belong in the worker or in plugin storage.
- **Message budgets shape the live views.** The 1 MiB answer cap, the
  256 KiB post cap and the per-plugin rates bound how run graphs, logs
  and chat streams are paged. The worker connection ticket should take
  these numbers.
- **Open questions.**
  - Does Archon load `<name>.archon.yaml` under `.archon/workflows/` as
    a normal workflow?
  - Does Archon's own web server run in the setups this plugin targets?
    If it does, an Orca browser tab already shows the full console, and
    the plugin's value is the integration around it.
  - How does a tab on a view file behave across an Orca restart and on
    save? Not checked here; a spike with a development plugin would
    settle it.
