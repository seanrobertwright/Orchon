# Orchon

Archon's runs, workflows and chat inside Orca. Unofficial; not made or endorsed by the Archon or Orca projects.

Orchon is a plugin for [Orca](https://github.com/stablyai/orca). It brings the console of an [Archon](https://github.com/coleam00/Archon) server running on the same computer into Orca. It is free and MIT licensed.

## Status

Orchon finds the Archon on this computer, checks that it is one Orchon works with, and says whether it is connected. It shows none of Archon's data yet.

- A sidebar panel named Orchon with a section bar: Runs, Launch, Workflows, Chat, Metrics and Settings. While Orchon is connected, each section is an empty placeholder. While it is not, each section says why: Orchon is looking for Archon, Archon is not running (with the command that starts it), there is no Archon home folder, a connection setting is not valid, or the Archon found is not supported. Metrics says it needs Archon 0.14.0 or newer when the server lacks the metrics paths. Settings always shows a read-only Connection group with the state, the connected address and both connection settings. The panel reopens on the section last shown in a workspace.
- A status bar item that reads "Archon", "Archon…", "Archon off" or "Archon setup" by connection state, with one sentence as its tooltip. Pressing it runs the command "Orchon: Show runs", which makes an open panel show Runs.
- An editor tab for each kind of pointer file: "Orchon run graph" for `.orchonrun` files and "Orchon workflow builder" for `.orchonflow` files. Each shows a placeholder page.

### How Orchon finds Archon

Orchon talks only to this computer's loopback address, and counts an address as Archon only once `GET /api/health` there answers JSON with `status: "ok"`. Each time it looks, it tries one address: the first of these that applies.

1. The Base URL setting, when it is set.
2. The address in `server.json` in the Archon home folder. The folder is `~/.archon` unless the Archon home folder setting names another.
3. `http://127.0.0.1:3090`.

Once an address answers, Orchon reads its list of API paths from `/api/openapi.json` before it counts as connected. An Archon whose list lacks a path Orchon needs, or that answers something other than that document, is not supported. The version Archon reports is shown and decides nothing: Orchon works with Archon 0.12.1 or newer because those releases serve the paths it needs.

When nothing answers, Orchon looks again after 2 seconds and then at longer intervals, up to one try every 30 seconds, until Archon answers. An Archon that is not supported is checked again every 30 seconds. It never starts or stops Archon. Both settings are changed in Orca's Settings, and Orchon looks again as soon as one changes.

## Requirements

- Orca 1.4.248 or newer, the desktop app.
- For development: Node 24.2 or newer, and Orca's `orca` command on the `PATH`.

## Development

Install the development dependencies and generate Orca's types once:

```sh
npm ci
npm run types
```

There is no bundler. Orca loads `src/worker.ts` and `src/panel.tsx` as written. The editors under `editors/` are TypeScript compiled to JavaScript beside each source file, and both are committed. After changing an editor's TypeScript, run `npm run build:editors` and commit the JavaScript with it.

`npm run check` runs every gate below in turn. CI runs the same gates on every pull request and on every push to `main`, against the latest Orca release.

| Command | What it checks |
| --- | --- |
| `npm run check:tracked` | No tracked file holds U+FFFD, text that is not valid UTF-8, or the owner's personal handle, home path or email address. |
| `npm run typecheck` | The whole repository type-checks against Orca's generated types. |
| `npm run check:editors` | The committed editor JavaScript equals the compiler's output, and every JavaScript file under `editors/` has a TypeScript source. |
| `npm run lint` | ESLint: unused code, the module bans below, and accessibility rules for the editors' HTML. |
| `npm run lint:md` | markdownlint on every Markdown file. |
| `npm test` | `orca plugin test`: the worker, the panel, the editors, the text cutter and the gates' own rules. |
| `npm run check:panel` | `orca plugin check`: renders the panel in each scenario of `src/panel.check.ts` and reads every file the editors load. |
| `npm run validate` | `orca plugin validate`: the manifest and the host calls, as Orca loads them. |
| `npm run check:limits` | Orca's install limits: 2,000 files, 50 MiB, and 1 MiB for each file Orca transpiles. |

Every gate skips `node_modules/`, `.orca/` and `.lril/`.

On Windows, keep the repository on the same drive as Orca: `orca plugin check` fails from another drive.

### Pre-commit check

Turn the pre-commit hook on once per clone:

```sh
npm run hooks:install
```

Before each commit it runs the same check as `npm run check:tracked`, on the staged content and not on the working tree.

### Module bans

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

### Recorded fixtures

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
- Costs a little: for each launch that saves its message, Archon writes a title with its small model, through your own Claude login.
- Leaves the release reachable the way `archon serve` does while it runs. Archon listens on every network interface by default.
- Stops the release and every process it started, deletes the throwaway folder, scrubs what it recorded, and writes the fixtures. On Linux and macOS a process that has not ended five seconds after SIGTERM is sent SIGKILL; on Windows `taskkill /T /F` ends the tree at once.
- Does the same on Ctrl+C at any point, the release's first boot and `provider add` included. A second Ctrl+C does not cut the cleanup short: the recorder ends once the release is gone and the throwaway folder is deleted.
- Writes nothing when the run failed, was interrupted, or held back a fixture that still named a machine path or name after scrubbing. The fixtures folder of that release is left as it was, and the log is printed instead. A complete run replaces the folder only once the new recording is on disk.

After recording, run `npm run check` and read the diff before you commit.

### Seeing it in Orca

Loading the plugin into Orca asks you to approve what it may do. Read Orca's list before you approve.

```sh
orca plugin dev load .
```

`fixtures/pointers/` holds one sample pointer file for each editor tab.

`fixtures/markdown/` holds the long Markdown file of the run detail prototype, which the text cutter's tests cut. It is kept as the prototype wrote it and does not pass markdownlint, so its name ends in `.md.txt`: markdownlint reads every `.md` file.

## Licence

MIT. See [LICENSE](LICENSE). Licences of code copied from other projects are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
