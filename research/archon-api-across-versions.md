# Archon API across versions: what the plugin can rely on

Research for #2. Investigated on 2026-11-17.

## Answer in brief

- Every endpoint the Archon console calls for runs, run detail, run control, the attention
  list, launching, workflows and the builder, chat and settings exists in Archon 0.12.1 with
  the same path, parameters and response envelope as upstream HEAD. Differences on those
  routes are added optional fields, with the exceptions listed under
  [Breaking differences](#breaking-differences).
- The metrics screen has no backend before 0.14.0: `GET /api/metrics` and
  `GET /api/metric-views` first ship in 0.14.0.
- `GET /api/openapi.json` is served by every version checked. It covers every `/api` JSON route
  but not the two SSE streams, and it carries no usable API version. It is the right thing to
  feature-detect against.
- `~/.archon/server.json` does not exist in release 0.12.1. It first ships in 0.13.0. A plugin
  that must work with 0.12.1 needs a fallback (configured port, default 3090, then
  `GET /api/health`).
- The version string is not a capability signal. The local install reports `0.12.1` but runs a
  later source build that already has 0.13.0 features.
- The CLI reads the database directly, so its `--json` read commands work with no server, but
  their shapes are close to the HTTP shapes rather than equal to them.

## What was compared

| Label | What it is | How it was read |
| --- | --- | --- |
| 0.12.1 | upstream tag `v0.12.1` (commit `5f2b4841`, released 2026-10-17) | source at the tag, and the generated types `packages/web/src/lib/api.generated.d.ts` at the tag |
| 0.13.0, 0.13.2 | upstream tags | generated types at each tag, `packages/paths/src/server-discovery.ts`, `CHANGELOG.md` |
| 0.14.0 | upstream tag `v0.14.0` (commit `8def159a`, released 2026-11-07) | generated types at the tag, `packages/server/src/routes/api.workflow-run-launch.ts` at the tag |
| HEAD | upstream default branch at commit `8d24481d` (2026-11-17). `package.json` still says `0.14.0`, so this is 0.14.0 plus unreleased work | source and generated types |
| local dev build | the server running on this machine. `server.json` and `/api/health` report `0.12.1`, but it runs from a source checkout at upstream commit `72817c50d` (2026-10-26), which sits between the 0.12.1 and 0.13.0 releases | live `GET` requests only: `/api/openapi.json`, `/api/health`, and key-shape samples of list endpoints |

Method: the generated types file is produced from the server's OpenAPI document
(`packages/server/src/scripts/generate-api-types.ts` requests `/api/openapi.json` from the
app), so it is a per-tag snapshot of the spec. The path blocks and schema blocks of that file
were split and diffed between tags, and the live spec from the local dev build was compared
with the 0.12.1 tag's types. Routes outside OpenAPI were found by searching for plain
`app.get(...)` registrations in `packages/server/src`.

Two limits on this evidence:

- No release 0.12.1 server was run. Statements about 0.12.1 come from its source and its
  generated types. The release 0.12.1 CLI binary was run only for `--version` and `--help`.
- The only live server is the local dev build, so "observed" below means observed on that
  build, not on release 0.12.1.

## The local install is not release 0.12.1

This changes how the ticket should be read, so it comes first.

- `~/.archon/install.json` and `~/.archon/bin/archon` are release 0.12.1 (`archon --version`
  prints `Build: binary`, commit `5f2b4841`).
- The running server is started by a local supervisor script from a source checkout through a
  `bun link` shim (`archon --version` on `PATH` prints `Build: source (bun)`). That checkout is
  the upstream commit named above, and its `package.json` still says `0.12.1`.
- Observed consequences: the live spec has `GET /api/dashboard/conversations`, request bodies
  for the launch and send-message routes, `owner_observation` on run rows, and `storeId` in
  health. The 0.12.1 tag has none of these. The live server also writes `server.json`, which
  the 0.12.1 tag cannot do.

So "version 0.12.1" on this machine means "somewhere between 0.12.1 and 0.13.0". A plugin that
branches on the version string would get this install wrong.

## Verdict key

- **stable**: same path, parameters, request body and response envelope at 0.12.1, 0.14.0 and
  HEAD. Any difference is an added optional field or a widened enum.
- **changed**: a client written against one end can break against the other. The row says how.
- **missing in 0.12.1**: the row says which release first has it.

"Console reads" refers to the console at HEAD under
`packages/web/src/experiments/console`.

## Per-screen endpoints

### Connection and health (every screen)

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/health` | changed | 0.13.0 removed `concurrency.queuedByConversation` and `concurrency.activeConversationIds` and added `concurrency.oldestActiveAgeMs`, `concurrency.oldestQueuedAgeMs` and `storeId` (`CHANGELOG.md` 0.13.0 Breaking). HEAD adds optional `commit` (`sha`, `committedAt`). `status`, `adapter`, `concurrency.active`, `concurrency.queuedTotal`, `concurrency.maxConcurrent`, `runningWorkflows`, `version`, `is_docker`, `is_wsl`, `activePlatforms`, `attentionDestinations` and `schema` are in every version. |
| `GET /health`, `/health/db`, `/health/concurrency` | stable | plain routes, not in OpenAPI. Registered in `packages/server/src/index.ts` at 0.12.1 and `packages/server/src/server-routes.ts` at HEAD. |
| `GET /api/openapi.json` | stable | see [OpenAPI](#openapi-availability-and-completeness). |
| `GET /api/auth/status` | stable | observed: `enabled` is `false` on the local solo install. |
| `GET /api/update-check` | stable | |

### Runs list (running and history)

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/dashboard/runs` | stable | query `status`, `codebaseId`, `search`, `after`, `before`, `limit`, `offset`. Response `runs`, `total`, `counts` with keys `all`, `running`, `completed`, `failed`, `cancelled`, `pending`, `paused`. Row fields added later: `owner_observation` (0.13.0), `completed_outcome`, `active_phase_started_at`, `item_id` (HEAD, unreleased). |
| `GET /api/workflows/runs` | stable | not called by the console. Query `conversationId`, `status`, `codebaseId`, `limit`, `mine`, `open`. Same added fields as above. |
| `GET /api/codebases` | stable | project names and the project filter. |
| SSE `GET /api/stream/__dashboard__` | stable | see [SSE streams](#sse-streams). |

### Run detail with graph

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/workflows/runs/{runId}` | stable | response `run` and `events`. `run.nodes[]` carries `node_id`, `state`, `error`, `reason`, `cause` in every version. Added later: `run.owner_observation` and `fan_out_outcome` on nodes (0.13.0); `run.platform_type`, `run.loop_rounds`, node `failure_kind`, `terminal_record.completed_outcome`, `terminal_record.result_commit`, `boundary` inside `cause` (HEAD, unreleased). |
| `GET /api/workflows?cwd=` | stable for the graph | the console builds the graph from the list route, filtered by name (`getWorkflowGraph` in `skills/workflows.ts`), reading each node's `id`, `depends_on` and which of `loop`, `approval`, `wait`, `cancel`, `bash`, `command`, `script` is set. Those keys exist in every version. |
| `GET /api/conversations/{id}/messages?limit=` | stable | `{id}` is the platform conversation id, not the database id (comment on `Run.conversationPlatformId` in `primitives/run.ts`). |
| `GET /api/workflows/runs/{runId}/provider-events` | stable | query `step`, `attemptId`, `afterSeq`. Event union grew: `continuesPreviousBlock` on message chunks (0.13.0), a `heartbeat` event (0.13.2). |
| `GET /api/runs/{runId}/artifacts` | stable | `files[]` with `path`, `size`, `modifiedAt`. |
| `GET /api/artifacts/{runId}/{path}` | stable | the route `app.get('/api/artifacts/:runId/*')` exists in every version. It is described in OpenAPI only at HEAD. |
| `GET /api/workflows/runs/by-worker/{platformId}` | stable | not called by the console. |
| SSE `GET /api/stream/{conversationPlatformId}` | stable | see [SSE streams](#sse-streams). |

### Run control

All of these return `success` and `message`, with `400`, `403`, `404`, `409` and `500` errors.
The gate routes return a `400` body with `error` and optional `childRunId`.

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `POST /api/workflows/runs/{runId}/cancel` | stable | no body. |
| `POST /api/workflows/runs/{runId}/resume` | stable | no body. The HEAD console shows the returned `message`. |
| `POST /api/workflows/runs/{runId}/abandon` | stable | no body. |
| `POST /api/workflows/runs/{runId}/approve` | stable | body `comment?`, `expectedGate?`. The console does not call it; it sends approve and reject through `respond`. |
| `POST /api/workflows/runs/{runId}/reject` | stable | body `reason?`, `expectedGate?`. Same remark. |
| `POST /api/workflows/runs/{runId}/respond` | stable | body `decision`, `text?`, `expectedGate?` (a string, or `nodeId` plus `pauseId`). |
| `POST /api/workflows/runs/{runId}/answer` | stable | body `occurrence`, `choose?`, `text?`. HEAD adds optional `recommended` and `as` (unreleased). Whether an older server rejects those unknown keys was not tested; do not send them to a server whose spec does not list them. |
| `POST /api/workflows/runs/{runId}/signal` | stable | not called by the console. |
| `DELETE /api/workflows/runs/{runId}` | stable | not called by the console. |

### Attention queue

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/runs/attention` | changed | query `project`, `all`, `label`, `sort`, `countBy`. The response is either `runs` plus `items`, or `counts` when `countBy` is set. `runs[]` (dashboard rows, each with `attention`) is stable and is all the 0.12.1 console reads. `items[]` is restructured at HEAD (unreleased): the flat `runId`, `workflow`, `parentRunId`, `fanOut`, `context`, `node`, `occurrence` move under a nested `run` object, a top-level `ref` is added, top-level `context` becomes an optional string, and a new `owner_lost` kind appears. Released 0.14.0 still has the flat shape. `degraded[]` is added in 0.14.0. |
| run row `attention` field | stable | the same kinds in every version: `stalled_tool_calls`, `awaiting_response`, `attention`, `usage_limit`, `blocked_on_child`, `blocked_on_children`, `unreadable`, `terminal`. Options gain `does` and `value`, and the item gains `recommendation`, in 0.14.0; `other` at HEAD. |
| `GET /api/runs/{runId}/attention` | changed | wraps one item; same restructuring as `items[]` above. |
| `POST /api/runs/{runId}/attention/labels` | stable | body `occurrence`, `set?`, `unset?`. |
| SSE `GET /api/runs/attention/stream` | missing in 0.12.1 | first in 0.14.0 with query `project`, `all`, `label`; HEAD adds `level`. The console does not use it. |
| `POST /api/attention/answer`, `POST /api/attention/withdraw` | missing in 0.12.1 | HEAD only, unreleased. Answer by `ref` instead of by run. The console does not use them. |

### Launching runs

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `POST /api/conversations` | stable | body `codebaseId?`, `message?`. Response `conversationId` (the platform id the launch route expects), `id`, `dispatched?`. |
| `POST /api/workflows/{name}/run` | changed (minor) | JSON body `conversationId`, `message`, `inputs?`, `tiers?`, `aliases?`, `config?`, `adopt_run_id?`, `supersedes_run_id?`, or the multipart form with the object fields JSON-encoded plus `files`. Response `accepted`, `status`. Through 0.14.0 an empty `message` is refused with `400`; HEAD accepts an empty string. The request body is absent from OpenAPI at 0.12.1 and described from 0.13.0. |
| `GET /api/workflows?cwd=` | stable | the workflow picker and each workflow's declared `inputs`. |

The launch response carries no run id in any version. The console's `startRun`
(`skills/startRun.ts`) creates a conversation, posts the launch, and lets the runs list show
the new run when it appears.

### Workflows and the builder

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/workflows?cwd=` | stable | `workflows[]` with `workflow`, `source`, `parseWarnings?`; `recommended[]`; `errors?`. |
| `GET /api/workflows/{name}?cwd=` | stable | `workflow`, `authored?`, `filename`, `source`. The builder edits `authored`. It does not find workflows in subfolders (comment on `loadWorkflow` in `skills/workflows.ts`). |
| `PUT /api/workflows/{name}?cwd=&source=` | stable | body `definition`. |
| `DELETE /api/workflows/{name}?cwd=&source=` | stable | response `deleted`, `name`. |
| `POST /api/workflows/validate` | stable | body `definition`; response `valid`, `errors?`. |
| `GET /api/commands?cwd=` | stable | not called by the console. |
| `DELETE /api/workflows/{name}/node-sessions` | stable | not called by the console. |
| the workflow definition itself | changed | the envelope is stable but the language is not. 0.13.0: `model` may be a list, `fan_out.max_parallel` may be `all`, `include` nodes get their own form. 0.14.0: `on_exhausted` on loops. HEAD (unreleased): `outcome_field` and `evidence_policy` are removed and a workflow that sets them fails to load (`CHANGELOG.md` Unreleased Breaking); `result`, `resource`, input `result_of`, context `same` and retry `schema_unmet` are added. |
| `GET /api/codebases/{id}/config` | missing in 0.12.1 | first in 0.14.0. Not called by the console. |
| `GET /api/packs/{pack}/graph` | missing in 0.12.1 | HEAD only, unreleased. Not called by the console. |

### Chat

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/conversations` | stable | query `platform`, `codebaseId`, `mine`. |
| `POST /api/conversations` | stable | as under launching. |
| `GET`, `PATCH`, `DELETE /api/conversations/{id}` | stable | |
| `GET /api/conversations/{id}/messages?limit=` | stable | message fields `id`, `conversation_id`, `role`, `content`, `metadata`, `user_id`, `created_at`. |
| `POST /api/conversations/{id}/message` | stable | JSON `message`, or multipart `message` plus `files`. Response `accepted`, `status`. The request body is absent from OpenAPI at 0.12.1 and described from 0.13.0. |
| SSE `GET /api/stream/{conversationPlatformId}` | stable | |
| `GET /api/dashboard/conversations` | missing in 0.12.1 | first in 0.13.0. Not called by the console. |

### Metrics

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/metrics` | missing in 0.12.1 | first in 0.14.0. Query `since`, `until`, `name`, `subject`, `codebaseId`, `compare`, `byModel`. |
| `GET /api/metric-views` | missing in 0.12.1 | first in 0.14.0. |

These report metric records that workflow nodes return, declared by workflow packs
(`CHANGELOG.md`, 0.14.0 section). They are not run counts or success rates. No endpoint before
0.14.0 returns the same data. A metrics screen for older servers would have to compute a
different thing from `GET /api/dashboard/runs` (counts, and `metadata.total_cost_usd` per
run).

### Settings

| Endpoint | Verdict | Notes |
| --- | --- | --- |
| `GET /api/config` | stable | `config`, `database`. |
| `PATCH /api/config/assistants`, `/tiers`, `/aliases` | stable | a tier or alias entry is `provider`, `model`, `effort?`, or null. The generated types print this differently at HEAD, but the live spec from the local dev build already marks the entry nullable. |
| `GET /api/providers`, `/api/providers/pi/models`, `/api/providers/opencode/credentials` | stable | capabilities gain `structuredOutputCorrection` at HEAD. |
| `GET`, `POST /api/codebases`; `GET`, `PATCH`, `DELETE /api/codebases/{id}`; `POST /api/codebases/base-branch` | stable | |
| `GET`, `PUT /api/codebases/{id}/env`; `DELETE /api/codebases/{id}/env/{key}`; `GET /api/codebases/{id}/environments` | stable | |
| `/api/auth/me/ai-prefs` and its `tiers`, `aliases`, `default` routes | stable | observed: `401` on the local solo install, where web auth is off. |
| `/api/auth/providers` routes, `/api/auth/github` routes | stable | observed: `401` on the local solo install. |
| `/api/web-push/key`, `/api/web-push/subscriptions` | stable | browser push; not useful to a Node worker. |

### SSE streams

| Stream | Verdict | Notes |
| --- | --- | --- |
| `GET /api/stream/__dashboard__` | stable | plain route, not in OpenAPI. Sends a `heartbeat` frame on open and every 30 seconds. The console acts only on `workflow_status` and `dag_node`, reading `type` and `runId` (`useDashboardSSE` in `lib/sse.ts`). |
| `GET /api/stream/{conversationPlatformId}` | stable | plain route, not in OpenAPI. The console acts on `text`, `tool_call`, `tool_result`, `dag_node`, `workflow_status`, `workflow_step`, `workflow_artifact`, `workflow_dispatch`, `conversation_lock` and `workflow_provider_event` (`useRunStreamSSE`, `useConversationSSE`). |
| `GET /api/runs/attention/stream` | missing in 0.12.1 | first in 0.14.0; described in OpenAPI. Frames carry an SSE `id` that `Last-Event-ID` resumes from (`registerAttentionStreamRoute` in `routes/api.run-attention.ts`). |

The set of frame `type` values written by `packages/server/src/adapters/web` is the same at
0.12.1 and HEAD. Only `dag_node` has a schema in the spec (`DagNodeSseEvent`); it gains
optional fields but loses none. The `workflow_status` frame has `type`, `runId`,
`workflowName`, `status`, `timestamp` in both (`packages/server/src/adapters/web/workflow-bridge.ts`).
The console changed its SSE handling between the two versions only by also invalidating
metrics and by refetching messages on unlock.

## Breaking differences

These are the cases where a client written for one version misreads another.

1. `GET /api/health`: `concurrency.queuedByConversation` and `concurrency.activeConversationIds`
   are gone from 0.13.0.
2. Attention `items[]` (`GET /api/runs/attention`, `GET /api/runs/{runId}/attention`): flat run
   fields at 0.12.1 through 0.14.0, nested under `run` at HEAD (unreleased). Reading `runs[]`
   and each row's `attention` avoids the difference.
3. The workflow language: a definition valid for one server version can fail to load on
   another. Use the server's own `POST /api/workflows/validate` instead of a bundled schema.

One behaviour that is the same everywhere but easy to trip over: the web UI fallback is
`app.get('*')` serving `index.html` (`serveWebUi` in `packages/server/src/static-cache.ts`,
identical at 0.12.1 and HEAD). Observed on the local dev build: `GET /api/metrics`,
`GET /api/runs/attention/stream` and a made-up `/api/` path each return `200` with
`text/html`. A missing endpoint therefore does not answer `404` to a `GET`. Detect it from the
spec, or from the response content type. Inferred, not tested: a `POST` to a missing path
returns `404`, since the fallback is registered for `GET` only.

## OpenAPI availability and completeness

- Served by every version: `app.doc('/api/openapi.json', ...)` in
  `packages/server/src/routes/api.ts` at 0.12.1 and at HEAD. Observed on the local dev build:
  `200`, `application/json`.
- It sits behind the `/api/*` access gate, so it needs an identity when web auth is on. On a
  local SQLite install without web auth it is open.
- `info.version` is the constant `1.0.0` in both versions, and the document has no `servers`
  or security schemes. It cannot tell you the Archon version; use `/api/health` `version` for
  display only.
- Covered: every route registered through `createRoute`. The operation list in the live spec
  equals the 0.12.1 tag's generated types plus `GET /api/dashboard/conversations`.
- Not covered in any version: the two `/api/stream/...` SSE routes and the `/health` routes.
- Not covered until later: the artifact file route (described at HEAD only); the request
  bodies of `POST /api/workflows/{name}/run` and `POST /api/conversations/{id}/message`
  (described from 0.13.0; at 0.12.1 the route comment says the body is validated by hand).
- SSE frames: only `dag_node` has a component schema. The attention stream's frame has one
  from 0.14.0 (`AttentionStreamLine`).
- `metadata` on a run is an open object. Keys the console reads from it, such as
  `total_cost_usd`, are not all declared in the schema.

Operations added per release, from the generated types at each tag:

| Release | Added operations |
| --- | --- |
| 0.12.0 to 0.12.1 | none |
| 0.13.0 | `GET /api/dashboard/conversations` |
| 0.13.2 | none |
| 0.14.0 | `GET /api/codebases/{id}/config`, `GET /api/metrics`, `GET /api/metric-views`, `GET /api/runs/attention/stream` |
| HEAD, unreleased | `POST /api/attention/answer`, `POST /api/attention/withdraw`, `GET /api/items`, `GET /api/items/window`, `POST /api/items/rulings`, `POST /api/items/rulings/{rulingId}/withdraw`, `GET /api/packs/{pack}/graph`, and the spec entry for `GET /api/artifacts/{runId}/{filename}` |

No operation was removed in any step.

## Server discovery

- `server.json` is not in release 0.12.1. `packages/paths/src/server-discovery.ts` does not
  exist at the `v0.12.1` tag and exists at `v0.13.0` (`CHANGELOG.md`, 0.13.0 section). The file
  on this machine exists only because the running server is the later dev build.
- Fields: `pid`, `port`, `host`, `version`, `startedAt`, `storeId` (`ServerRecord`).
- `host` is the bound address, taken from `HOST` or `0.0.0.0` (`packages/server/src/index.ts`).
  A client must connect to loopback when it reads `0.0.0.0`.
- It is advisory. `writeServerRecord` writes it once the server listens and
  `removeServerRecord` removes it on a clean shutdown. A killed server leaves it behind, so a
  reader must check that `pid` is alive, as `readLiveServerRecord` does.
- To confirm the server serves this home, compare `storeId` from `GET /api/health` with the
  `store-id` file in the Archon home (upstream `reference/archon-directories.md`). Both exist
  from 0.13.0.
- Later servers also write `server-records/<pid>.json`, and a stopping server hands
  `server.json` to the newest one still running. `CHANGELOG.md` lists this under 0.13.1; the
  code is absent at `v0.13.0` and present at `v0.13.2`. The local dev build predates it: its
  home has no `server-records` directory.
- Nothing in the upstream CLI or web app reads the record; `readLiveServerRecord` has no
  caller outside its module at HEAD. It exists for outside clients.
- `ARCHON_HOME`: `getArchonHome` returns `/.archon` in Docker, else `ARCHON_HOME` with `~`
  expanded, else `~/.archon`. It is in `packages/paths/src/archon-paths.ts` at 0.12.1 and
  `packages/paths/src/home-paths.ts` at HEAD, with the same logic. The database path, the
  home `.env`, `install.json`, `store-id`, `server.json` and the workspaces all resolve
  through it, in the server and the CLI alike. The plugin has to apply the same rule itself
  to find the file.
- Port without `server.json` (`getPort` in `packages/core/src/utils/port-allocation.ts`, same
  in both versions): `PORT` if set, which may come from the home `.env`; a path-derived port
  in the range 3190 to 4089 when the server runs from a git worktree; otherwise 3090.

A discovery order that works from 0.12.1 to HEAD: read `server.json` under the resolved home
and check the `pid`; if absent, try a user-configured port, then 3090; in every case confirm
with `GET /api/health`, and compare `storeId` when the response has one.

## CLI equivalents without a server

The CLI opens the store itself. `workflowRunsCommand`, `workflowGetCommand` and
`workflowStatusCommand` read through `host.deps.store`, and no workflow command file under
`packages/cli/src/commands` at HEAD makes an HTTP call to a local server. That the commands
work with the server stopped is inferred from this; they were run only while the server was
up. `CHANGELOG.md` states it outright for `workflow artifacts` and `project list`.

Observed on the local dev build: `archon workflow runs --json --all` run outside a git
repository answers an `ok: false` document with `error`, and the same command run inside one
succeeds. Under `--json` each command writes one pretty-printed JSON document.

Shapes below were observed on the local dev build (key names only).

| Command | Same data as | Shape difference |
| --- | --- | --- |
| `archon workflow runs --json [--all] [--status] [--limit]` | `GET /api/dashboard/runs` | `runs`, `total`, `counts` plus `scopeFallback`. Rows lack `attention` and `owner_observation` unless `--verbose` is added. Default limit is 20 and the scope is the current project unless `--all`. |
| `archon workflow status --json [--all]` | `GET /api/dashboard/runs` for active runs | `runs` (each with `attention`) and `scopeFallback`. |
| `archon workflow get <run-id> --json` | `GET /api/workflows/runs/{runId}` | not the same envelope: the run fields are at the top level with `transcript_path`, `terminal_record` and `leave_behind`, and there is no `events`. `--verbose` adds `nodes` in the CLI's own form (`nodeId`, `state`, `startedAt`, `durationMs`, `outputPreview`, `execution`), not the API's `node_id` form. `--events` gives raw event rows instead. |
| `archon workflow attention --json [--all]` | `GET /api/runs/attention` | `ok`, `action`, `scope`, `items`. No `runs`. |
| `archon workflow list --json` | `GET /api/workflows` | compact entries (`name`, `description`, `descriptionTruncated`) and `errors`; not the full definitions the builder needs. |
| `archon workflow cancel`, `abandon`, `resume`, `approve`, `reject`, `respond`, `answer` with `--json` | the run-control routes | not run for this research. `--help` lists them under `--json`, and the source writes an `ok: false` document with `error` on failure. |
| `archon workflow wait <run-id> --json` | no HTTP equivalent | not run for this research. Per `--help` it blocks until the run ends or needs attention. |

`--json` coverage by version, from each build's `--help`:

- Release 0.12.1: `list`, `status`, `get`, `wait`, `attention`, `runs`, `approve`, `reject`,
  `respond`, `answer`, `cancel`, `abandon`, `resume`.
- From 0.13.0: also `workflow artifacts` and `project list`.
- From 0.14.0: `archon metrics`, the CLI twin of `GET /api/metrics`
  (`packages/cli/src/commands/metrics.ts` exists at `v0.14.0` and not at `v0.13.2`), and
  `project config` (`CHANGELOG.md`, 0.14.0 section).

The CLI has no equivalent of the builder's read and write of full workflow definitions, of
chat messages, or of the settings routes.

One caution, inferred from `CHANGELOG.md` (Unreleased Breaking, state documents) and from the
schema-version comment in `packages/core/src/db/schema-version.ts`: a source checkout and an
installed release can share one Archon home, and the older binary may refuse data the newer
one wrote. A plugin that shells out to `archon` should use the same build as the server it
talks to. On this machine `archon` on `PATH` is the dev build and the release binary is a
different file.

## Fields the console reads that an older server will not send

"First in" is the earliest version whose generated types have the field.

| Field | Where | First in | Console use at HEAD | If absent |
| --- | --- | --- | --- | --- |
| `owner_observation` | run rows and run detail | 0.13.0 | `toRun` in `primitives/run.ts` | treated as no claim. |
| `fan_out_outcome` | run detail nodes | 0.13.0 | `primitives/event.ts` | no fan-out tally shown. |
| `degraded` | `GET /api/runs/attention` | 0.14.0 | `listRunsNeedingAttention` defaults it to an empty list | none. |
| `recommendation`, option `does` | a run's `attention` | 0.14.0 | `AttentionAnswerPanel.tsx` | no recommendation line or option descriptions. |
| `completed_outcome` | run rows and detail | HEAD, unreleased | `readOutcome` falls back to `outcome` for completed runs | the fallback is already written. |
| `active_phase_started_at` | run rows and detail | HEAD, unreleased | `runPhaseStart` falls back to `started_at` | duration counts from creation. |
| `platform_type` on run detail | `GET /api/workflows/runs/{runId}` | HEAD, unreleased | `normalizeOrigin` | origin reads as unknown on the detail page. List rows have had it since 0.12.1. |
| `failure_kind` | run detail nodes in the types; the console reads it from run event `data` | HEAD, unreleased | `primitives/event.ts` | no failure class shown. |
| `other` | a run's `attention` | HEAD, unreleased | `AttentionAnswerPanel.tsx` | no free-text "other" rule. |
| `items[].run`, `items[].item`, kind `owner_lost` | `GET /api/runs/attention` | HEAD, unreleased | `toOwnerLostHolders` | no owner-lost holders; on older servers the code must not read `item.run`. |
| `commit` | `GET /api/health` | HEAD, unreleased | `SystemPanel.tsx` | shown as a dash. |
| `storeId` | `GET /api/health` | 0.13.0 | not read by the console | no home check possible. |
| `metadata.total_cost_usd` | run rows | not a declared schema key in any version. Observed in run metadata on the local dev build; the name appears in provider and server code at both 0.12.1 and HEAD | `readCost` | cost shown as none. |

Fields in the types that the console does not read, and so need no handling: `item_id`,
`loop_rounds`, `result_commit`, `iterationOutput`, per-call token `calls`,
`structuredOutputCorrection`, `oldestActiveAgeMs`.

## What this means for the plan

- Target the released surface. Everything except metrics works against 0.12.1 if the plugin
  reads `runs[]` rather than attention `items[]`, treats every field in the table above as
  optional, and does not send `recommended` or `as` on answers.
- Decide capabilities from `GET /api/openapi.json` at connect time (for example: is
  `/api/metrics` in `paths`), not from the version string and not from a `404`.
- Discovery needs a fallback path, because `server.json` starts at 0.13.0.
- The builder should lean on the server's `validate` route, because the workflow language
  changes in every release, including removals.
- HEAD is a moving target: the attention item reshape, the `ref`-based answer routes, items
  and pack graphs are unreleased and may still change before the next release.
- Upstream moves fast. `CHANGELOG.md` dates 0.12.0 at 2026-10-17, 0.13.0 at 2026-10-28 and
  0.14.0 at 2026-11-07, and each of those sections has a Breaking list.

## Open questions this raised

- Which Archon versions will the plugin support? If the floor is 0.13.0, discovery by
  `server.json` and `storeId` is dependable and the fallback path can be dropped.
- What should the metrics screen show on a server older than 0.14.0: hidden, or a smaller
  screen computed from the runs list?
- Does an older server reject unknown keys in a run-control body? Untested, since only `GET`
  requests were allowed.
- Was release 0.12.1's runtime behaviour ever different from its source? Not checked; no
  release server was run.

## Sources

- Upstream repository `coleam00/Archon`: tags `v0.12.0`, `v0.12.1`, `v0.13.0`, `v0.13.2`,
  `v0.14.0`, and the default branch at commit `8d24481d`.
- `packages/web/src/lib/api.generated.d.ts` at each of those points.
- `packages/server/src/routes/api.ts` (0.12.1: all routes; HEAD: gate, spec registration) and
  the HEAD route modules `api.workflow-runs.ts`, `api.workflow-run-launch.ts`,
  `api.run-control.ts`, `api.run-gates.ts`, `api.run-attention.ts`, `api.messages.ts`,
  `api.artifacts.ts`, `api.metrics.ts`, `api.health.ts`.
- `packages/server/src/routes/schemas/workflow.schemas.ts`,
  `workflow-run-launch.schemas.ts`, `conversation.schemas.ts`.
- `packages/server/src/adapters/web/workflow-bridge.ts`, `workflow-event.schemas.ts`.
- `packages/server/src/static-cache.ts`, `packages/server/src/index.ts`.
- `packages/paths/src/server-discovery.ts`, `home-paths.ts`, `archon-paths.ts`,
  `env-loader.ts`; `packages/core/src/utils/port-allocation.ts`;
  `packages/core/src/db/connection.ts`.
- `packages/web/src/experiments/console`: `skills/runs.ts`, `skills/startRun.ts`,
  `skills/workflows.ts`, `skills/metrics.ts`, `primitives/run.ts`, `primitives/event.ts`,
  `lib/sse.ts`, `lib/sse-endpoints.ts`, `components/AttentionAnswerPanel.tsx`,
  `components/SystemPanel.tsx`.
- `packages/cli/src/commands/workflow.ts` (0.12.1), and at HEAD `workflow-query.ts`,
  `workflow-get.ts`, `metrics.ts`, and `packages/cli/src/help-table`.
- `CHANGELOG.md` and `packages/docs-web/src/content/docs/reference/api.md`,
  `reference/archon-directories.md` at HEAD.
- The local install: `server.json` and `install.json` under `~/.archon`, `archon --version`
  and `archon --help` from both builds, read-only `archon workflow ... --json` commands on the
  dev build, and `GET` requests to the running server.
