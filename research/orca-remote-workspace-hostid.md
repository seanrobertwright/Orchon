# What Orca reports as `hostId` for SSH and WSL workspaces

Research for ticket #25. Plan only: facts about Orca, no product code.

## Answer in brief

- `workspace.list` gives each row a `hostId` that is the exact string
  `local`, or `ssh:<SSH target id>`, or `runtime:<environment id>`, or
  `null`.
- **SSH workspace.** `hostId` is `ssh:<target id>` (the id is
  URI-encoded). `path` is the path on the SSH machine, for example
  `/home/<user>/repo`. `kind` is `worktree` for a Git project and
  `folder` for a folder project. If Orca runs its own server on that
  machine, the same machine's projects can be owned by a
  `runtime:<environment id>` host instead.
- **WSL workspace.** It depends on how the project was added. Only the
  last shape below is a separate host:
  1. *A project opened through the WSL share.* `hostId` is `local`.
     `path` is the Windows UNC spelling, `\\wsl.localhost\<distro>\...`
     or the older `\\wsl$\<distro>\...`. It is not a Linux-style path.
  2. *A project on a Windows drive whose runtime is set to WSL.*
     `hostId` is `local` and `path` is an ordinary drive path. Nothing
     in `workspace.list` tells it apart from a plain Windows project.
  3. *A project on a "WSL host"* (an Orca server that Orca installs
     inside the distro; an experimental setting, off by default).
     `hostId` is `runtime:<environment id>` and `path` is a Linux path.
- **`runtime:...`** means a paired Orca server, called a runtime
  environment: a server reached directly over the network, one reached
  or deployed over SSH, one Orca deployed into a WSL distro, or a
  recipe VM. Its paths belong to that server's file system.
- **`null`** means the row carries no host stamp. At this version every
  row that belongs to a project is stamped, so `null` is left for
  project-group folders. It does **not** prove the folder is on this
  machine: an SSH project-group folder records its host in a field that
  `workspace.list` does not read. Treat `null` as remote.
- **`workspace.readContext` adds nothing about the host.** It returns
  `workspaceId`, `branch`, `displayName` and `terminals` for the focused
  workspace. The worker joins `workspaceId` to the `id` of a
  `workspace.list` row to learn `hostId`, `path` and `kind`.

### The test the worker should use

A workspace row is **local and writable by path** when both hold:

1. `row.hostId === "local"` (exact string; `null`, `ssh:...`,
   `runtime:...` and anything else fail), and
2. `row.path` is not a WSL share path. Strip a leading `\\?\UNC\`
   long-path prefix, turn every `\` into `/`, and fail the row when the
   result matches `^//(wsl\.localhost|wsl\$)/` without regard to case.
   Apply this second check only when the worker's `process.platform` is
   `win32`.

Use the same test for both jobs:

- **Pointer files:** write into `<row.path>/.orchon/` only when the test
  passes. Still handle a failed write (read-only folder, permissions) by
  turning wide tabs off for that workspace.
- **Matching to an Archon project:** take the project root from
  `project.list` (`path`, with `hostId` always named), apply the same
  checks to that row, and compare paths only when they pass. Before
  comparing, unify the separators: on this Windows machine Orca reports
  drive paths with `/` on most rows and `\` on at least one.

Everything else is remote: show the console, turn off matching,
launching and wide tabs. That includes WSL shape 1, which is `local` by
host id but is excluded by check 2. This matches the earlier decision
that WSL counts as remote.

One gap the test cannot close: WSL shape 2 passes, because its files
really are on a Windows drive. Pointer files and path matching are safe
there, but terminals and agents that Orca starts in that workspace run
inside the distro. Whether "launching runs" should stay on for it is a
product decision; the host API gives the worker no field to detect it.

## Sources and method

- Orca source, `stablyai/orca` at tag `v1.4.261`, commit
  `92d4266cc4ffa945dbc1fa52850e62448d2dfc1c` (shallow clone, read only).
  The `version` in its `package.json` is 1.4.261, the same as the
  installed app.
- Orca docs in that tree: `docs/reference/plugin-host-api.md`,
  `plugin-authoring.md`, `plugin-manifest.md`. The first states "Host
  API 1.10".
- The references shipped with the installed Orca CLI, version 1.4.261:
  `orca skills get orca-plugin-authoring --reference
  references/host-api.md` and `--reference references/events.md`. The
  host API reference also states "Host API 1.10", and its
  `workspace.list` and `workspace.readContext` entries read the same as
  the source tree's.
- Read-only CLI calls on this machine: `orca worktree list --json`,
  `orca repo list --json`, `orca host list`, `orca environment list`.

Nothing was changed in Orca: no plugin was loaded, no workspace, SSH
target or WSL host was created. This machine has only the local host
and no saved environments, so every SSH and WSL statement below comes
from reading source, not from a live row.

Every claim carries one of these marks:

- **[code]** read in the source at the tag above.
- **[docs]** read in Orca's reference docs or CLI help.
- **[observed]** seen in CLI output on this machine.
- **[inferred]** follows from the code or docs but was not seen stated,
  and was not exercised.

## How `workspace.list` builds a row

The method is `listPluginWorkspaces` in
`src/main/plugins/workers/host-api/plugin-host-workspace-list.ts`. It
calls runtime methods in the desktop's own process, the same ones the
`orca` CLI calls: `worktree.list`, `repo.list` and
`folderWorkspace.list`, plus `worktree.ps` when `includeStatus` is set.
**[code]**

It produces these rows. **[code]**

- **A `worktree.list` row whose project is a Git repository.**
  `kind: "worktree"`; `path` is the row's `path`; `hostId` is the row's
  `hostId`, else `null`.
- **A `worktree.list` row whose project has `kind: "folder"`.**
  `kind: "folder"`; `path` is the row's `path`; `hostId` is the row's
  `hostId`, else `null`.
- **A `folderWorkspace.list` row (a folder of a project group).**
  `kind: "folder"`; `path` is the row's `folderPath`; `hostId` is the
  row's `executionHostId`, else `null`. These rows also have
  `project: null`, `projectId: null` and `branch: null`.

The public shape is `workspaceListResult` in
`src/shared/plugins/workers/plugin-host-api-workspace-methods.ts`. Its
comments describe `path` as "The path on the host that owns it, which
may be WSL or an SSH machine", and `hostId` as "`local`,
`ssh:<connection>` or `runtime:<environment>`; null when it records none
(older rows on this machine)". **[code]**

### Where a project row's `hostId` comes from

The runtime stamps every project-backed row before it answers
`worktree.list`. In `projectRepoWorktreeRows`
(`src/main/runtime/workspaces/catalog/repo-worktree-row-resolution.ts`)
a Git row gets the host saved in its own metadata, else the project's
host; a folder-project row gets its own host, else the project's host.
**[code]**

The project's host is `getRepoExecutionHostId` in
`src/shared/execution-host.ts`. **[code]** It returns, in this order:

1. the project's `executionHostId`, when it parses as `local`,
   `ssh:...` or `runtime:...`;
2. else `ssh:<connectionId>`, when the project has a `connectionId`
   (the older way to mark an SSH project);
3. else `local`.

So a project-backed row always has a host id, and a project with no
host fields at all reads as `local`. **[code]**

This machine agrees: `orca repo list --json` shows no project with an
`executionHostId` or a `connectionId`, and every row of
`orca worktree list --json` has `hostId: "local"`. **[observed]**

The `id` of such a row is `identity:<key>`, and the key is
`wt2:<host id>:<instance id>` (`canonicalWorktreeIdentity` in
`src/shared/worktree/identity.ts`, `pluginWorkspaceId` in the workspace
methods file). On this machine the keys begin `wt2:local:`.
**[code]** **[observed]** The worker should still read `hostId`, not
parse the id: a row with no identity keeps a raw id.

### The host id grammar

`ExecutionHostId` and `parseExecutionHostId` in
`src/shared/execution-host.ts` allow only these forms. **[code]**

- `local` (`LOCAL_EXECUTION_HOST_ID`): the machine Orca's desktop app
  runs on.
- `ssh:<id>` (`toSshExecutionHostId`): a saved SSH target; `<id>` is the
  target id, URI-encoded.
- `runtime:<id>` (`toRuntimeExecutionHostId`): a runtime environment;
  `<id>` is the environment id, URI-encoded.

There is one reserved value, `runtime:unresolved-owner`
(`UNRESOLVED_OWNER_HOST_ID`). Its comment says it uses the `runtime`
spelling "to prevent local treatment", that no environment owns it, and
that it must never be dialed. A test that accepts only the exact string
`local` handles it correctly. **[code]**

## SSH workspaces

- An SSH project is marked either by `connectionId` ("SSH target ID for
  remote repos. null/undefined = local") or by
  `executionHostId: "ssh:..."`; both resolve to `ssh:<target id>`.
  **[code]** `Repo` in `src/shared/repository/repo-types.ts`,
  `getRepoExecutionHostId`
- The desktop's runtime does not run Git for an SSH project. It answers
  from stored rows, and each stored row's path is the path part of the
  worktree id, which is the path on the SSH machine. **[code]**
  `RuntimeWorkspaceCatalog.listRepoWorktreesForResolution` in
  `src/main/runtime/workspaces/catalog/workspace-catalog.ts` (its
  comment: "this process serves no SSH git, so an SSH repo answers from
  its stored rows"); `listStoredWorktreeRowsForRepo` in
  `repo-worktree-row-resolution.ts`
- So an SSH workspace row is `hostId: "ssh:<target id>"`, `path` on the
  remote machine, `kind: "worktree"` or `"folder"` by project type.
  **[inferred]** from the points above; no SSH row was seen.
- An SSH machine can also run a server that Orca deployed there. Orca
  then keeps both host ids for the one machine, `ssh:<target id>` and
  `runtime:<environment id>`, as separate "ownership ids". **[code]**
  `annotateManagedOrcadExecutionHosts` in
  `src/shared/execution-host/managed-orcad-execution-host.ts`. A
  project on that machine can therefore list under either id.
  **[inferred]**
- The worker runs on the desktop, so a path on the SSH machine is not a
  path it can write. **[inferred]** The earlier wide-view research
  reached the same conclusion.

## WSL workspaces

Orca on Windows has several ways to work in WSL. They report
differently.

### Shape 1: a project opened through the WSL share (`local`, UNC path)

- The project's stored path is the Windows UNC spelling. Orca
  recognises both `\\wsl.localhost\<distro>\...` and
  `\\wsl$\<distro>\...`, with either slash. **[code]** `parseWslUncPath`
  in `src/shared/file-access/wsl-paths.ts`
- It has no host fields, so `getRepoExecutionHostId` gives `local`.
  **[code]** Orca's own model says the same: a location is native only
  when `executionHostId === "local"` **and** `wslDistro === null`
  (`isNativeLocalLocation` in `src/shared/execution-host.ts`), and the
  comment where the distro is worked out reads "WSL routing describes
  *this* machine; no remote or runtime host may inherit it"
  (`structuredAgentSessionLocationForTarget` in
  `src/main/runtime/session-tabs/structured-session-workspace-scope.ts`).
- Worktree paths are UNC too. Git runs inside the distro and prints
  Linux paths; Orca rewrites them, with the comment "Map Linux worktree
  output to UNC paths Node can open on Windows". A worktree that sits on
  a mounted Windows drive is rewritten to the drive path instead,
  unless the project itself was saved under the distro's view of that
  drive. **[code]** `translateWslOutputPaths` in
  `src/main/git/command-runner/host-routing/wsl-path-translation.ts`,
  `toWindowsWslPath` in `wsl-paths.ts`
- A project with no saved runtime that lives in a WSL share runs its
  terminals inside that distro. **[code]** `getWorkspaceRuntimePreference`
  in `src/shared/execution-host/project-runtime-preference.ts`

So the row is `hostId: "local"`, `path` a `\\wsl.localhost\...` or
`\\wsl$\...` UNC path, `kind` by project type. **[inferred]** from the
points above; no such row was seen.

Can the Windows worker write there? A Windows process can open these
paths, and Orca's own main process does. But Orca treats them as
unreliable, and the source says why: **[code]**

- "Any 9P touch of `\\wsl.localhost\<distro>` boots a stopped distro, so
  background reads ask first" (`src/main/wsl/filesystem/wsl-unc-access-gate.ts`,
  the comment above `WSL_UNC_RUNNING_LEASE_MS`). A pointer-file write
  would start a stopped distro.
- "A Windows stat over \\wsl.localhost can report a transient ENOENT"
  (`resolveWslWorktreeGitPath` in
  `src/main/git/worktrees/catalog/wsl-worktree-git-path.ts`), and Orca
  probes inside the guest "because Win32 9P stat can falsely report
  ENOENT" (`wslUncDirectoryExistsAsync` in
  `src/main/wsl/filesystem/unc-path-access.ts`).
- Windows can refuse the path outright with EPERM or EACCES
  (`describeWslUncAccessDenied` in
  `src/main/wsl/filesystem/wsl-unc-access-denied.ts`).

Path matching does not work either: an Archon that runs inside the
distro names the project by its Linux path, and the row gives the UNC
spelling. **[inferred]** That is why the recommended test excludes this
shape.

### Shape 2: a Windows-drive project with a WSL runtime (`local`, drive path)

A project on a Windows drive can have its runtime set to a WSL distro,
per project or as the global default. Terminals and agents then run in
the distro while the files stay on the drive. **[code]**
`resolveProjectExecutionRuntime` in
`src/shared/execution-host/project-execution-runtime.ts`,
`LocalWindowsRuntimePreference` and `ProjectGitRuntime` in
`project-runtime-preference.ts`

The project has no host fields, so its rows are `hostId: "local"` with
an ordinary drive path. **[code]** Neither `workspace.list` nor
`project.list` returns the runtime preference, and no method in the
host API reference returns one. **[docs]** The worker can write the
folder and match its path, but cannot tell that Orca's terminals there
run in WSL. **[inferred]**

### Shape 3: a WSL host (`runtime:<environment id>`, Linux path)

- A WSL host is described as "A managed orcad Orca deployed into a WSL
  distro and reaches through a `wsl.exe` stdio bridge". It is a runtime
  environment whose deployment has `kind: "wsl"`. **[code]**
  `OrcadWslDeploymentLinkSchema` in
  `src/shared/remote-runtime/host-catalog/wsl-host-deployment-link.ts`,
  `classifyRuntimeEnvironmentHost` in
  `runtime-environment-host-kind.ts`
- Its host id is therefore `runtime:<environment id>`, and its paths
  are Linux paths. When Orca moves a shape 1 project onto a WSL host it
  rewrites the stored paths from UNC to Linux and sets the destination
  host to `toRuntimeExecutionHostId(...)`. **[code]**
  `wslMoveDesktopRewriteContext` in
  `src/main/persistence/moving-wsl-projects/desktop-state/wsl-move-desktop-rewrite.ts`,
  `createUncToLinuxPathRewriter`
- A WSL host refuses projects on a Windows drive. **[code]**
  `src/shared/remote-runtime/wsl-hosts/wsl-host-windows-drive-refusal.ts`
- The feature is behind the setting `experimentalWslHosts`
  ("Experimental (Windows): add WSL distros as hosts, each running its
  own Orca server"), which defaults to `false`, and behind a launch
  gate that is open unless the environment or a remote policy closes
  it. Existing shape 1 projects move only when the user chooses to.
  **[code]** `GlobalSettings` in `src/shared/global-settings-types.ts`,
  `src/shared/default-global-settings.ts`, `isWslHostsInternalGateOpen`
  in `src/shared/remote-runtime/wsl-hosts/wsl-host-internal-gate.ts`,
  `WSL_MOVE_AUTO_MOVES_BRIDGE_PROJECTS` in
  `src/shared/wsl-move/wsl-move-rollout-stage.ts`

## What `runtime:...` means

A runtime environment is a saved Orca server that the desktop reaches
over a socket. The CLI calls it "a remote Orca runtime" saved "from a
pairing code". **[docs]** `orca --help`

`classifyRuntimeEnvironmentHost` sorts environments into the kinds
`network` (reached directly), `ssh` (reached through an SSH tunnel, or
deployed by Orca over SSH) and `wsl` (shape 3 above). An environment
can also have the source `ephemeral-vm`, a recipe VM.
**[code]** `runtime-environment-host-kind.ts`,
`RuntimeEnvironmentSourceSchema` in
`src/shared/remote-runtime/host-catalog/runtime-environments.ts`

A project owned by such a server carries
`executionHostId: "runtime:<environment id>"`; the type comment says
these projects "otherwise resemble local repos (connectionId: null)".
**[code]** `Repo` in `repo-types.ts`

For the worker every `runtime:` row is remote. Even the WSL kind, which
runs on the same computer, reports Linux paths. **[inferred]**

## When `hostId` is `null`

- For project-backed rows the runtime always stamps a host, so `null`
  should not appear at this version; none was seen on this machine.
  **[code]** **[observed]** The schema still allows it and describes it
  as "older rows on this machine".
- For project-group folders, `workspace.list` copies the folder's own
  `executionHostId` and nothing else. **[code]** That field is described
  as a "Renderer-owned host stamp for host-qualified folder catalogs".
  A folder workspace has a second host field, `connectionId`, described
  as the "SSH target ID for folder workspaces whose folder path lives
  remotely", and its project group has one too. **[code]**
  `FolderWorkspace` in
  `src/shared/folder-workspaces/folder-workspace-types.ts`,
  `ProjectGroup` in `src/shared/project/groups/project-group-types.ts`
- Orca itself works out a folder's real host from more than the stamp:
  the folder's `connectionId`, its project group's host fields and the
  projects in scope all take part. **[code]**
  `resolveFolderWorkspaceRowHost` and
  `candidateReposForFolder` in
  `src/shared/folder-workspaces/folder-workspace-execution-host.ts`
- `listPluginWorkspaces` parses `connectionId` on these rows but never
  uses it for `hostId`. **[code]**

So `hostId: null` means "this folder row has no host stamp". The folder
may be on this machine, which is the case the reference names ("null
when it records none, as for a project-group folder on this machine"),
or on an SSH machine whose target is recorded only in `connectionId`.
**[inferred]** The host API gives the worker no way to tell the two
apart.

Recommended handling: **treat `null` as remote.** The cost is small.
A folder the user adds as a folder project is project-backed and reads
as `local`; only folders inside a project group can be `null`.

Do not use "the path exists on my disk" as a fallback proof. On a
macOS or Linux desktop an SSH machine's `/home/<user>/project` can
exist locally with the same spelling. **[inferred]**

## What `workspace.readContext` adds

The answer shape is `pluginWorkspaceContextSchema` in
`src/shared/plugins/workers/plugin-host-api-workspace-context.ts`, a
strict object or `null`. **[code]**

- `workspaceId` (optional): the id `workspace.list` gives the focused
  workspace.
- `branch`: the short branch name.
- `displayName`: the workspace's name.
- `terminals`: `{ id, title? }` for each terminal of that workspace.

There is no `hostId`, `path` or `kind`. **[code]** **[docs]** The value
is built by `projectPluginWorkspaceContext` in
`src/main/plugins/workers/host-api/plugin-workspace-projection.ts`.

`workspaceId` is left out when the id is longer than the public bound,
and was absent before host API 1.7. **[code]** A worker always gets the
id when it is present; a panel or editor frame does not get a raw id,
because a raw id embeds the workspace path
(`pluginFrameWorkspaceContext`). **[code]**

The `workspace.changed` event carries the same object. The
`workspace.created` and `workspace.removed` events carry `path` and
`kind` but no `hostId`. **[docs]** `references/events.md`

So the worker flow is: read the context (or take it from
`workspace.changed`), find the `workspace.list` row whose `id` equals
`workspaceId`, then apply the test to that row. If `workspaceId` is
absent or no row matches, treat the workspace as remote. **[inferred]**

## Notes on comparing paths

- `orca worktree list --json` on this Windows machine reports drive
  paths with forward slashes on most rows and with backslashes on at
  least one. **[observed]** Unify separators before comparing.
- Windows paths compare without regard to case; Linux paths do not.
  Orca's own comparison follows the same rule for WSL paths. **[code]**
  `foldWslUncPathCaseInsensitiveParts` in `wsl-paths.ts`
- `project.list` gives a project's root `path` and a `hostId` that is
  "always named", through the same `getRepoExecutionHostId`. **[code]**
  `listPluginProjects` in `plugin-host-workspace-list.ts` **[docs]**
  Match Archon projects against these rows; `workspace.list` rows name
  their project by `projectId`.

## Not checked

- **No SSH or WSL workspace was run.** The `hostId`, `path` and `kind`
  values for SSH and for every WSL shape are read from source. A
  real row from each would confirm them, in particular the exact
  spelling of a shape 1 path (slash direction, `wsl.localhost` or
  `wsl$`).
- **Whether `runtime:` rows appear in the desktop's `workspace.list` at
  all.** The reference says the list covers "every host Orca reaches".
  The code path read here builds rows from projects in the desktop's
  own store, and the desktop also receives paired-server rows through a
  separate sidebar feed (`pairedServerRowsSnapshot` in
  `src/main/runtime/sidebar-inputs/workspace-rows/paired-server-rows-snapshot.ts`).
  Which of the two a plugin sees for a paired server was not traced.
  The test treats `runtime:` as remote either way.
- **Whether an SSH project-group folder really lists with
  `hostId: null`.** This follows from the types and from the mapping in
  `listPluginWorkspaces`; it needs an SSH project group to confirm. If
  the renderer always stamps `executionHostId` on such folders, `null`
  would be local only, and treating it as remote would merely be
  cautious.
- **Whether a Node worker can write a pointer file through a
  `\\wsl.localhost\...` path in practice.** Orca's main process does
  write there, with the failure cases quoted above. It was not tried
  from a plugin worker.
- **Whether the WSL hosts feature is reachable in a stock install.**
  The setting default and the launch gate were read; the remote policy
  that can close the gate was not, and the setting was not looked up on
  this machine.
- **`null` on project-backed rows.** The schema comment mentions "older
  rows on this machine". The row-building code at this tag always
  stamps a host; an older stored row that slips through was not found
  and not ruled out.
- **Network shares.** A project on an ordinary `\\server\share` path
  has no host fields, so by `getRepoExecutionHostId` it should read as
  `local`. The test lets it through; no such project was tried.
