# Orchon

Archon's runs, workflows and chat inside Orca. Unofficial; not made or endorsed by the Archon or Orca projects.

Orchon is a plugin for [Orca](https://github.com/stablyai/orca). It brings the console of an [Archon](https://github.com/coleam00/Archon) server running on the same computer into Orca. It is free and MIT licensed.

## Status

Orchon finds the Archon on this computer and says whether it is connected. It shows none of Archon's data yet.

- A sidebar panel named Orchon with a section bar: Runs, Launch, Workflows, Chat, Metrics and Settings. While Orchon is connected, each section is an empty placeholder. While it is not, each section says why: Orchon is looking for Archon, Archon is not running (with the command that starts it), there is no Archon home folder, or a connection setting is not valid. Settings always shows a read-only Connection group with the state, the connected address and both connection settings. The panel reopens on the section last shown in a workspace.
- A status bar item that reads "Archon", "Archon…", "Archon off" or "Archon setup" by connection state, with one sentence as its tooltip. Pressing it runs the command "Orchon: Show runs", which makes an open panel show Runs.
- An editor tab for each kind of pointer file: "Orchon run graph" for `.orchonrun` files and "Orchon workflow builder" for `.orchonflow` files. Each shows a placeholder page.

### How Orchon finds Archon

Orchon talks only to this computer's loopback address, and counts an address as Archon only once `GET /api/health` there answers JSON with `status: "ok"`. Each time it looks, it tries one address: the first of these that applies.

1. The Base URL setting, when it is set.
2. The address in `server.json` in the Archon home folder. The folder is `~/.archon` unless the Archon home folder setting names another.
3. `http://127.0.0.1:3090`.

When nothing answers, Orchon looks again after 2 seconds and then at longer intervals, up to one try every 30 seconds, until Archon answers. It never starts or stops Archon. Both settings are changed in Orca's Settings, and Orchon looks again as soon as one changes.

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
| `npm test` | `orca plugin test`: the worker, the panel, the editors and the gates' own rules. |
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

- Loading `node:child_process`, `node:net`, `node:http`, `node:https`, `node:tls`, `node:dgram` or `node:worker_threads`, in any file.
- Loading `node:fs` outside the disk module `src/disk.ts`. The gates' scripts and the tests are the exception: they may read files.
- A use of `fetch` outside the client module `src/client.ts`.
- A use of `Date` or `Intl.DateTimeFormat` outside the date helper `src/dates.ts`, so that every clock read, date parse and formatted time goes through one file. The gates' scripts and the tests are the exception.
- `eval`, `new Function`, and an `import()` or `require()` whose target is not a literal string.
- The ways around those rules: `require()` outside `eslint.config.cjs`, `node:module` outside `scripts/tooling.ts`, and `process.getBuiltinModule` in any file.

A test also fails when the source names a `workspace:write` host method other than `editor.open` and `workspace.open`.

### Seeing it in Orca

Loading the plugin into Orca asks you to approve what it may do. Read Orca's list before you approve.

```sh
orca plugin dev load .
```

`fixtures/pointers/` holds one sample pointer file for each editor tab.

## Licence

MIT. See [LICENSE](LICENSE). Licences of code copied from other projects are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
