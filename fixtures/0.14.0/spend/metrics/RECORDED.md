# Archon 0.14.0: recorded fixtures

Written by `scripts/record-fixtures.ts`. Do not edit these files by hand: record them again.

- Recorded at: 2026-11-20T02:28:56Z
- Release: 0.14.0
- Binary: `archon-windows-x64.exe`, 90,520,064 bytes, SHA-256 `aebc48ee8422ce9fbe426af730e17261f058923cd27293b46254d1cf9555744c`
- The binary reports: `Archon CLI v0.14.0 Platform: win32-x64 Build: binary Database: sqlite Git commit: 8def159a`
- The running server reported version: `0.14.0`
- Recorded on: win32 x64
- Archon home: a throwaway folder the recorder made and deleted afterwards
- Recorded in spend mode: the `metrics` scenario alone
- Ceilings: 0 tokens and 2 minutes
- Tokens Archon reported: 0
- Ceiling crossed: none
- Claude login: hidden from the release
- Synthetic data: every metric record here, and the overview cards of `orchon-synthetic`, were made up by the recorder's own pack (workflow `orchon-recorder-synthetic-metrics`, one shell step, fixed numbers, names starting `orchon_synthetic.`). They measure nothing.

## What was recorded

| File | What it holds |
| --- | --- |
| `metrics.json` | SYNTHETIC: every metric record here, and the overview cards of orchon-synthetic, were made up by the recorder's own pack (workflow orchon-recorder-synthetic-metrics, one shell step, fixed numbers, names starting orchon_synthetic.). They measure nothing. GET /api/metric-views and /api/metrics over the default window, 7 days and 365 days, and for the project, with the time each query took, after the synthetic pack ran |

## What could not be recorded

- a metrics report after a real pack that emits metrics has run: archon-metrics-prs was not run: its own description says it needs a forge plugin whose pr.view reports pull request timestamps, which is a GitHub login, and it counts only pull requests the build queue opened, which a throwaway home has none of. The recorder handles no GitHub credential, so the records come from the recorder's synthetic pack instead

## What was scrubbed

Each of these stands for a value of the machine that recorded:

- `<project-path>`: the throwaway project folder
- `<archon-home>`: the throwaway Archon home
- `<recorder-folder>`: the folder that held both
- `<temp>`: the machine's temp folder
- `<home>`: the developer's home folder
- `<claude-config>`: the developer's Claude config folder, which holds the Claude login
- `<binary>`: the release binary's path
- `<user>`: the developer's account name
- `<host>`: the machine's name
- `<store-id>`: the install's store id
- `<token>`: a string shaped like a key or a token
