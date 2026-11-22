# Development

How to build, check and test Orchon, and how its recorded fixtures are made. You need Node 24.2 or newer, and Orca's `orca` command on the `PATH`.

Install the development dependencies and generate Orca's types once:

```sh
npm ci
npm run types
```

There is no bundler. Orca loads `src/worker.ts` and `src/panel.tsx` as written. The editors under `editors/` are TypeScript compiled to JavaScript beside each source file, and both are committed. After changing an editor's TypeScript, run `npm run build:editors` and commit the JavaScript with it.

The workflow builder's rules for reading, editing, validating and writing a workflow are copied from Archon release v0.14.0 into `editors/builder/archon/`. [`UPSTREAM.md`](../editors/builder/archon/UPSTREAM.md) there gives the commit and every difference from upstream. The plugin's own replacements for what that code imported from the rest of Archon are in `editors/builder/support/`. Its test fixtures and test helpers are loaded only by the tests, so they have no JavaScript.

`npm run check` runs every gate below in turn. CI runs the same gates on every pull request and on every push to `main`, against the latest Orca release. When that release cannot be downloaded, CI still runs the gates that need no Orca, skips the ones that do, and names each skipped gate and why in a warning and the job summary.

| Command | What it checks |
| --- | --- |
| `npm run check:tracked` | No tracked file holds U+FFFD, text that is not valid UTF-8, or the owner's personal handle, home path or email address. The repository's own public path, which the install steps need, is the one place the handle may appear. |
| `npm run typecheck` | The whole repository type-checks against Orca's generated types. |
| `npm run check:editors` | The committed editor JavaScript equals the compiler's output, and every JavaScript file under `editors/` has a TypeScript source. |
| `npm run lint` | ESLint: unused code, the module bans below, and accessibility rules for the editors' HTML. |
| `npm run lint:md` | markdownlint on every Markdown file. |
| `npm test` | `orca plugin test`: the worker, the panel, the editors and the builder logic copied from Archon, the text cutter and the gates' own rules. |
| `npm run check:panel` | `orca plugin check`: renders the panel in each scenario of `src/panel.check.ts` and reads every file the editors load. |
| `npm run validate` | `orca plugin validate`: the manifest and the host calls, as Orca loads them. |
| `npm run check:limits` | Orca's install limits: 2,000 files, 50 MiB, and 1 MiB for each file Orca transpiles. |

Every gate skips `node_modules/`, `.orca/` and `.lril/`.

CI also runs one gate `npm run check` does not, because it needs the manifest of the last released tag: it compares the approval surface with that tag (see [Releases](../README.md#releases) in the README). It takes the newest `v*` tag and pipes that tag's `orca-plugin.json` into `node scripts/check-approval-surface.ts --tag <tag>`; with no tag yet it runs the script with no tag, which passes. To run it by hand:

```sh
git show v0.1.0:orca-plugin.json | node scripts/check-approval-surface.ts --tag v0.1.0
```

On Windows, keep the repository on the same drive as Orca: `orca plugin check` fails from another drive.

## Pre-commit check

Turn the pre-commit hook on once per clone:

```sh
npm run hooks:install
```

Before each commit it runs the same check as `npm run check:tracked`, on the staged content and not on the working tree.

## Module bans

ESLint fails the build on any of these. A module counts as loaded by `import`, `export ... from`, `import()` or `require()`. The rules cover every file of code; `scripts/source-extensions.json` lists the extensions for all the gates.

- Loading `node:net`, `node:http`, `node:https`, `node:tls`, `node:dgram` or `node:worker_threads`, in any file.
- Loading `node:child_process` outside the fixture recorder's process module `scripts/recorder/process.ts`.
- Loading `node:fs` outside the disk module `src/disk.ts`. The gates' scripts and the tests are the exception: they may read files.
- A use of `fetch` outside the client module `src/client.ts` and the fixture recorder's HTTP module `scripts/recorder/http.ts`.
- A use of `Date` or `Intl.DateTimeFormat` outside the date helper `src/dates.ts`, so that every clock read, date parse and formatted time goes through one file. The gates' scripts and the tests are the exception.
- Loading anything under `scripts/` from shipped code: a file under `src/` or `editors/` that is not a test or a check. Orca never loads `scripts/`. The tests may load its shared helpers.
- `eval`, `new Function`, and an `import()` or `require()` whose target is not a literal string.
- The ways around those rules: `require()` outside `eslint.config.cjs`, `node:module` outside `scripts/tooling.ts`, and `process.getBuiltinModule` in any file.

The fixture recorder is the one exception to the `node:child_process` ban and the `fetch` ban. It is a script a developer runs by hand, described under [Recorded fixtures](#recorded-fixtures), and Orca never loads it. It has to start an Archon release and call it, so one of its files may start a program and one may use `fetch`. Every other file of the recorder keeps both bans.

A test also fails when the source names a `workspace:write` host method other than `editor.open` and `workspace.open`.

## Recorded fixtures

`fixtures/` holds what real Archon releases answered, so that the plugin can be tested against them. There is one folder for each supported release, named after it. Do not edit these files by hand: record them again.

- Each JSON file in a release folder is one recording: `{ release, scenario, log }`. The log holds every request the recorder sent with the release's answer, every stream frame, and notes of what the recorder did between them, in order. An entry of kind `http` has `method`, `path`, `requestBody`, `status`, `contentType` and `body`. A recording that would be larger than 1 MiB indented is written on one line.
- `workflows/` holds, for each bundled workflow of the release, its load answer and its YAML file.
- `server.json` is the file the release wrote into its Archon home. A release that writes none has no such file.
- `RECORDED.md` is the log: when the folder was recorded, from which binary, what each file holds, and what could not be recorded.
- Machine paths, the account name, the machine name and the store id are replaced by placeholders such as `<project-path>` and `<store-id>`. `RECORDED.md` lists them.

`fixtures/workspace-rows.json` is different. It holds rows of Orca's `workspace.list` for local, SSH and WSL workspaces, with Windows paths in both slash directions. A path with the long-path prefix `\\?\UNC\` is given with backslashes only, as Windows reads it. It is written from the table of the decision on host ids, because no SSH or WSL workspace was available to record.

To record a release, download its `archon` binary for your machine from the release's page on GitHub into a folder outside this repository, then run:

```sh
node scripts/record-fixtures.ts 0.14.0 --binary <path to the downloaded archon binary>
```

Read this before you run it. The recorder:

- Makes a new Archon home in the temp folder and points the release at it. It never reads or writes your own Archon home or its `config.yaml`, and it refuses to start a release against a home it did not make in that run.
- Starts the release with `archon serve` on port 39417, or the port given with `--port`. It refuses port 3090, where your own Archon listens, and it never calls or stops an Archon it did not start.
- Lets the release download its own server and web UI from its GitHub release, and installs the `claude` provider into the throwaway home with the release's own `provider add`. A release with no provider cannot create a conversation.
- Registers one project: a scratch Git repository it makes inside the throwaway folder.
- Launches only its own workflows, which it writes into that project. They hold shell steps, an approval gate and an attention wait, and no agent. It never launches a bundled workflow, so it never launches `archon-worktree-cleanup`, and it never sends a chat message.
- Hides your Claude login from the release. Claude Code, which Archon's `claude` provider starts, reads its login from the folder `CLAUDE_CONFIG_DIR` names, or from `.claude` in your home folder. The recorder points `CLAUDE_CONFIG_DIR` at an empty folder inside the throwaway folder, and passes on no API key or token, so the release finds no login and cannot call a model. The title Archon writes for each launch with its small model falls back to the launch message. Whether this also hides a login Claude Code keeps in the macOS keychain is not established; every release so far was recorded on Windows.
- Leaves the release reachable the way `archon serve` does while it runs. Archon listens on every network interface by default.
- Stops the release and every process it started, deletes the throwaway folder, scrubs what it recorded, and writes the fixtures. On Linux and macOS a process that has not ended five seconds after SIGTERM is sent SIGKILL; on Windows `taskkill /T /F` ends the tree at once.
- Does the same on Ctrl+C at any point, the release's first boot and `provider add` included. A second Ctrl+C does not cut the cleanup short: the recorder ends once the release is gone and the throwaway folder is deleted.
- Writes nothing when the run failed, was interrupted, or held back a fixture that still named a machine path or name after scrubbing. The fixtures folder of that release is left as it was, and the log is printed instead. A complete run replaces the folder only once the new recording is on disk.

After recording, run `npm run check` and read the diff before you commit.

### Spend mode

Some fixtures only a live model can give: an agent step with its tool calls, and a web chat turn. Spend mode records them, one scenario at a time, through your own Claude login. It is off unless you ask for it, and it spends your Claude allowance, which has no spending cap of its own. Run each scenario by hand, in your own shell, logged in to Claude Code as you normally are.

| Scenario | What it records | Expected spend (an estimate) | Highest `--token-ceiling` | Wall-clock ceiling |
| --- | --- | --- | --- | --- |
| `agent-step` | One agent step on the `small` tier, prompted "List the files in this folder, then stop.", with Glob as its only tool: its run, its stream frames and its provider events by `step` and by the `attemptId` and `afterSeq` cursor | 40,000 to 70,000 tokens in, 1,000 to 2,000 out | 150000 | 5 minutes |
| `chat-turn` | One web chat turn, "run workflow orchon-recorder-echo": the stream frames in order, the saved messages and the shell-step run it starts | 25,000 to 40,000 tokens in, 1,000 out | 100000 | 5 minutes |
| `metrics` | First runs the recorder's synthetic metrics pack, one shell step that prints made-up metric records, then `GET /api/metric-views` and `GET /api/metrics` over the default window, 7 days and 365 days, and for the project, with the time each query took. Every metric record in it, and every overview card of its `orchon-synthetic` packs, is synthetic; the bundled `sdlc` pack's cards are Archon's own. Archon 0.14.0 only | none | 0: it takes no ceiling | 2 minutes |

The three ceilings add up to 250,000 tokens. Run `agent-step` first, alone, as the smoke test, and read its log before you run the next one:

```sh
node scripts/record-fixtures.ts 0.14.0 --binary <path> --scenario agent-step --allow-token-spend --token-ceiling 150000
node scripts/record-fixtures.ts 0.14.0 --binary <path> --scenario chat-turn --allow-token-spend --token-ceiling 100000
node scripts/record-fixtures.ts 0.14.0 --binary <path> --scenario metrics
```

A lower `--token-ceiling` is allowed; a higher one is refused. Without `--allow-token-spend` and `--token-ceiling`, `agent-step` and `chat-turn` refuse to start. `metrics` calls no model, so it refuses both flags and the release never sees your login.

In spend mode the recorder does everything the recording that spends nothing does, and also:

- Gives the release your login only for `agent-step` and `chat-turn`, and only as names: the home folder it already passes, and `CLAUDE_CONFIG_DIR` and `CLAUDE_BIN_PATH` when your shell sets them. It never reads, copies or logs what the login folder holds, and it passes on no API key or token. `--version`, `provider add` and `git` never get the login.
- Writes the throwaway home's own `config.yaml`: Claude's chat and the `small` tier on Haiku, only the project's own Claude settings, and no bundled workflow or command. Before it spends anything it reads `GET /api/config` and refuses to go on unless the release reports Haiku for both. Your own Archon config is never read.
- Launches only its own agent step, after Archon reads it from the throwaway project as one agent step with the recorder's prompt, the `small` tier and Glob alone. The step asks for one attempt (`retry: { max_attempts: 1 }`) and a Claude budget of USD 0.30 (`maxBudgetUsd`), a second guard whose effect on a subscription login is not established. In `chat-turn` it launches nothing itself and cancels at once any run of a workflow other than `orchon-recorder-echo`.
- Reads the spend Archon reports every second, and cancels the run through `POST /api/workflows/runs/{runId}/cancel` when the tokens reported cross the ceiling, the wall-clock ceiling passes, or the agent step makes more tool calls than `AGENT_STEP_MAX_TOOL_CALLS` allows. In 0.14.0's path list a step's tokens are reported on its node event and in the run's metadata, and its provider events carry none, so while a step runs the wall-clock ceiling and the tool-call count are what stop it. The chat turn's own tokens are read from its stream frames and its run, if the release reports them there at all; its wall-clock ceiling is the guard that holds. No route of the release cancels a chat turn, so a chat turn past a ceiling has its run cancelled and the release stopped.
- Writes into `fixtures/<release>/spend/<scenario>/`, with its own `RECORDED.md` that says it was recorded in spend mode, the ceilings, the tokens Archon reported and the ceiling crossed, if any. Recording the release again without spending keeps this folder.
- Holds back any fixture, and the whole log, that still names your Claude login folder, your home folder or your account name, or holds a string shaped like a key or a token or an email address a person owns, after scrubbing.

To stop a run, press Ctrl+C once. The release and every process it started are stopped, which ends the model call, and the throwaway folder is deleted; nothing is written.

Afterwards:

1. Read the printed line `Archon reported N tokens.` and the `RECORDED.md` of the scenario's folder: the tokens reported, and whether a ceiling was crossed.
2. Compare with your Claude usage page. The recorder counts only what Archon reports, and the title Archon writes with its small model may not be reported anywhere, so the real spend can be higher.
3. Run `npm run check`, then read the diff of `fixtures/<release>/spend/` before you commit.

The `metrics` scenario's records are synthetic. `archon-metrics-prs`, the pack workflow that would record real ones, is not run: it needs a forge plugin whose `pr.view` reports pull request timestamps, which is a GitHub login, and it counts only pull requests its build queue opened. The recorder handles no GitHub credential. Instead it writes its own pack into the throwaway project: the workflow `orchon-recorder-synthetic-metrics`, one `bash` step that echoes fixed records whose names all start `orchon_synthetic.`, its overview cards in `.archon/workflows/orchon-synthetic/.shared/metric-views.json`, and a declaration with no cards in `orchon-synthetic-unreadable`, so the views list an unreadable pack. The last record gives `orchon_synthetic.items_opened` a second definition, so the reports hold a refusal. The scenario launches the step only after Archon reads it from the project as a shell step with no agent, waits up to a minute for the run to complete and its records to be reported, and then reads the reports. It touches no forge plugin, no GitHub and no credential, and the release never sees your login.

The fixture's `holds`, its `synthetic-data` log entry and the `Synthetic data` line of its `RECORDED.md` say the records are made up and measure nothing. When Archon does not read the pack from the project as a shell step with no agent, or refuses its launch, the scenario says why in the same three places and reads the reports over an empty store; any `orchon-synthetic` cards in the views are still made up. Once Archon has accepted the launch the step may have printed its records, so when the run does not appear, fails, is cancelled after a minute, or its records do not appear in the project's report, the same three places say why and that the reports are possibly synthetic.

## Seeing it in Orca

Loading the plugin into Orca asks you to approve what it may do. Read Orca's list before you approve.

```sh
orca plugin dev load .
```

`fixtures/pointers/` holds one sample pointer file for each editor tab.

`fixtures/markdown/` holds the long Markdown file of the run detail prototype, which the text cutter's tests cut. It is kept as the prototype wrote it and does not pass markdownlint, so its name ends in `.md.txt`: markdownlint reads every `.md` file.
