# What a launch through Archon's HTTP API emits

A task for ticket #27. Plan only: recordings of a local Archon, no product
code.

Recorded on 2026-11-18 against the charting machine's Archon. It reports
version 0.12.1 and is a source build newer than that. The same behaviour
was then read in Archon's source at tag `v0.12.1`; the last section says
which facts were only read and not seen.

## Answer in brief

- **The run row carries both ids of the launch conversation.** Its
  `parent_conversation_id` is the conversation's `id` and its
  `parent_platform_id` is the conversation's `conversationId`. Both are
  on the rows of `GET /api/dashboard/runs` and on
  `GET /api/workflows/runs/{runId}`.
- **The row appears seconds after the 200, not at once.** The launch call
  answered in under 20 ms. The row showed 7.7 s after the launch was sent
  in one run and about 3.5 s in the other.
- **A `workflow_dispatch` frame on the conversation's stream means a run
  was started.** It came less than 100 ms before the row could be read,
  and before the lock was released. No refused launch sent one.
- **The lock is released when the run has been handed off, not when it
  ends.** It was released 7.7 s and 3.6 s after a started launch, and
  2.6 s after a refused one.
- **Only a malformed request is a 400.** An empty message answered 400
  in 3 ms. An undeclared input name and a missing required input both
  answered 200 with `{"accepted":true,"status":"started"}` and were
  refused about 2.5 s later as chat text, with no run row.
- **A refusal is saved as one assistant message that joins two texts.**
  The message reads "Starting workflow: `<name>`" followed at once by the
  refusal, with nothing between them. On the stream the refusal is its
  own `text` frame.
- **A workflow with no `inputs:` block accepts any input name.** The
  launch with an unknown name on `archon-forge-check` started a run, and
  the name was stored in the run's `metadata.inputs`.
- **A late reader gets the frames it missed.** A stream opened 3 s after
  the launch received the lock, both texts and the unlock in one burst.
  An `error` frame takes the same path, but none was provoked.
- **A second reader ends the first reader's stream.** The first reader
  saw a clean end of stream, with no frame saying why.
- **A deleted conversation leaves the lists.** `DELETE
  /api/conversations/{conversationId}` answered 200. The conversation was
  gone from `GET /api/conversations`, with and without `codebaseId`. It
  is a soft delete: `GET /api/conversations/{conversationId}` and its
  messages still answer 200, with `deleted_at` set.
- **A conversation with no message and no title is never listed**, so
  the conversation left by a launch refused with a 400 was not in the
  list even before it was deleted.
- **Every launch whose message is saved makes Archon write a title with
  its small model.** That is one small model call per launch, refused
  launches included. A launch refused with a 400 saves nothing and makes
  no call.

## How it was recorded

`research/launch-emissions/record.mjs` runs one scenario and writes every
request, answer and stream frame, in order, with a time in milliseconds.
`research/launch-emissions/scrub.mjs` turns the raw files into the
fixtures in `research/launch-emissions/fixtures/`, replacing the project
path, the home folder, the account name and the install's store id with
placeholders.

The project was a throwaway Git repository with one commit, registered
with `POST /api/codebases` and deleted afterwards.

The workflow for the real launch was `archon-forge-check`. It is the
cheapest workflow that runs to completion: one script node, no agent, no
worktree, and it does not change the checkout. `archon-worktree-cleanup`
is also a single script but removes worktrees across every project, so
it was not used. The refused launches used `archon-review-eval-judge`,
which declares one required input, `item`.

<!-- markdownlint-disable MD013 -->

| Fixture | Launch | Stream opened |
| --- | --- | --- |
| `accepted.json` | `archon-forge-check`, a message only | before the launch |
| `undeclared-no-inputs-block.json` | `archon-forge-check` with an input `not_declared` | before the launch |
| `undeclared.json` | `archon-review-eval-judge` with an input `not_declared` | before the launch |
| `missing-required.json` | `archon-review-eval-judge` with no inputs | 3 s after the launch |
| `empty-message.json` | `archon-forge-check` with an empty message | before the launch |

<!-- markdownlint-enable MD013 -->

Each fixture is `{ scenario, recordedAt, codebaseId, log }`. A `log`
entry has `atMs`, a `kind` and the fields of that kind:

- `http`: `method`, `path`, `requestBody`, `startedMs`, `status`,
  `contentType`, `body`.
- `stream-open`, `stream-end`: the reader's `label`, and for an end who
  ended it (`server`, `recorder` or `error`).
- `frame`: the reader's `label`, the frame as sent in `raw`, and its
  parsed `data`.
- `launch-sent`, `launch-answered`, `run-found`, `run-not-found`,
  `run-status` and the `listed-*` entries mark what the recorder did or
  saw between requests.

## The accepted launch

Times are milliseconds after the launch was sent.

<!-- markdownlint-disable MD013 -->

| Time | What happened |
| --- | --- |
| 16 | `POST /api/workflows/archon-forge-check/run` answers 200, `{"accepted":true,"status":"started"}` |
| 35 | frame `conversation_lock`, `locked: true` |
| 1068 | frame `text`, "Starting workflow: `archon-forge-check`" |
| 7613 | frame `text` with `category: "workflow_dispatch_status"`, then frame `workflow_dispatch` with `workerConversationId` and `workflowName` |
| 7693 | the run is in `GET /api/dashboard/runs`, status `pending` |
| 7713 | frame `conversation_lock`, `locked: false` |
| 9228 | the row's status is `running` |
| 9662 | frame `workflow_status`, `running`, with the `runId` |
| 10296 | frame `dag_node` for node `forge`, `running` |
| 11681 | frame `dag_node` for node `forge`, `completed` |
| 11684 | frame `workflow_status`, `completed` |
| 11720 | frame `text` with `category: "workflow_result"`, the run's returned value |

<!-- markdownlint-enable MD013 -->

The run's frames keep arriving on the launch conversation's stream after
the lock is released.

The run row, as first seen:

- `parent_conversation_id` equals the launch conversation's `id`.
- `parent_platform_id` equals the launch conversation's `conversationId`.
- `conversation_id` is the `id` of a second conversation that Archon
  made for the run, and `worker_platform_id` is that conversation's
  platform id. It equals `workerConversationId` in the
  `workflow_dispatch` frame.
- `metadata` has no `inputs` key, because none were sent.

The conversation's saved messages after the run, in the order the API
returned them:

1. `user`: the launch message.
2. `assistant`: a rocket emoji and "Dispatching workflow:
   **archon-forge-check** (background)", with metadata `category: "workflow_dispatch_status"`
   and `workflowDispatch.workerConversationId`.
3. `assistant`: "Starting workflow: `archon-forge-check`", with empty
   metadata.
4. `assistant`: the run's returned value, with metadata
   `category: "workflow_result"` and `workflowResult.runId`.

Messages 2 and 3 were saved in the same second, about 6 s after the
"Starting workflow" frame was sent. Assistant text is held back and saved in
segments, so a reader of saved messages sees nothing for the first
seconds of a launch.

The conversation had no title when it was created. When it was read back
15 s after the launch it had one, written by Archon's small model from
the launch message.

## The refused launches

### An input name the workflow does not declare

`undeclared.json`. The call answered 200 `started` after 19 ms.

<!-- markdownlint-disable MD013 -->

| Time | What happened |
| --- | --- |
| 26 | frame `conversation_lock`, `locked: true` |
| 867 | frame `text`, "Starting workflow: `archon-review-eval-judge`" |
| 2474 | frame `text`, "Cannot run workflow 'archon-review-eval-judge': it does not declare input 'not_declared'. Declared inputs: item." |
| 2555 | frame `conversation_lock`, `locked: false` |

<!-- markdownlint-enable MD013 -->

No `workflow_dispatch` frame was sent and no run row appeared in the
10 s that followed.

The conversation then held two messages: the `user` message, and one
`assistant` message whose content is both texts joined with nothing
between them: "Starting workflow: \`archon-review-eval-judge\`Cannot run
workflow ...". Its metadata is empty.

### A required input left out

`missing-required.json`. The call answered 200 `started` after 3 ms. The
stream was opened 3 s later and received, in one burst after the
heartbeat: the lock, "Starting workflow: `archon-review-eval-judge`",
the refusal and the unlock. Each replayed frame keeps the `timestamp` of
the moment it was first sent, which puts the unlock 2.5 s after the
launch.

The refusal text begins "This workflow requires input 'item', and none
was supplied." and goes on to explain the CLI flag and the console's run
form. It ends "No worktree was created and no AI cost was incurred."

The saved assistant message is again both texts joined.

### An input name on a workflow with no `inputs:` block

`undeclared-no-inputs-block.json`. Archon did not refuse it. The launch
ran like the accepted one: `workflow_dispatch` at 3455 ms, the row at
about 3.5 s, the unlock at 3613 ms. The run's `metadata.inputs` was
`{"not_declared":"x"}` and the run completed.

`resolveDeclaredInputs` in `packages/workflows/src/workflow-inputs.ts`
returns the supplied values unchanged when the workflow declares no
`inputs:` block at all. The check for undeclared names applies only to a
workflow that declares at least the block.

While that run was `pending`, `POST /api/workflows/runs/{runId}/cancel`
answered 400: "Cannot cancel run with status 'pending'. Only a running
run has live work to stop; abandon a paused or failed run instead."

### An empty message

`empty-message.json`. The call answered 400 after 3 ms with
`{"error":"message must be a non-empty string"}`. The stream sent
nothing but its opening heartbeat. No message was saved.

## One reader per conversation

In `accepted.json` a second reader opened the same conversation's stream
after the run had ended. The first reader's stream ended at that moment,
closed by the server, with no frame before the end. The
second reader received a heartbeat and nothing else: frames that the
first reader had already received are not replayed.

A reader that has lost the stream can still learn this from the saved
messages:

- A started launch saves an assistant message with metadata
  `category: "workflow_dispatch_status"`, and later one with
  `category: "workflow_result"` that names the `runId`.
- A refused launch saves one assistant message with empty metadata, the
  joined text above, at about the time the lock is released.
- An `error` frame is not saved (`createOrchestratorDispatch` in
  `packages/server/src/routes/api-message-dispatch.ts`, in the newer
  source, only sends it),
  so a failure of that kind leaves nothing to read.

## Deleting the conversation

`DELETE /api/conversations/{id}` takes the platform id, the
`conversationId` that `POST /api/conversations` returned. Every delete
answered 200 `{"success":true}`.

| Conversation | Listed before | Listed after |
| --- | --- | --- |
| refused with a 400, no message | no | no |
| refused after a 200, two messages | yes | no |
| started a run, three messages | yes | no |

"Listed" means present in `GET /api/conversations?codebaseId=`; the list
without `codebaseId` was checked too and agreed.

After the delete, `GET /api/conversations/{conversationId}` still
answered 200 with `deleted_at` set, and the messages were still
readable. An open stream on a deleted conversation was not closed.

Deleting the conversation of a run that had just started running did not
stop the run; it completed.

## Cleanup, and what Archon keeps

- `DELETE /api/codebases/{id}` answered 200 and the project left
  `GET /api/codebases`.
- The two runs stayed, with `codebase_id` set to `null`. They no longer
  matched `GET /api/dashboard/runs?codebaseId=` and still showed in the
  unfiltered list. They were then removed with
  `DELETE /api/workflows/runs/{runId}`, after which
  `GET /api/workflows/runs/{runId}` answered 404.

## Read in source, not seen

Read on 2026-11-18 in Archon's source at tag `v0.12.1` unless a line
says otherwise.

- The launch handler in `packages/server/src/routes/api.ts` saves the
  user message and, when the conversation has no title, calls
  `generateTitleForUser` with the `small` tier. On the recorded build
  the empty-message check runs before both.
- `packages/server/src/adapters/web/persistence.ts` appends assistant
  text to the last segment (`lastSeg.content += message`) unless the
  text is a workflow status. That is why the refusal is joined to
  "Starting workflow".
- `workflow_dispatch_status`, the `workflow_dispatch` frame and both
  refusal texts are in the `v0.12.1` source. Whether a `v0.12.1` server
  sends them in the recorded order was not seen: the recorded server is
  a newer build.
- `GET /api/conversations` passes `excludeEmpty: true` to
  `listConversations` in `packages/core/src/db/conversations.ts`, which
  hides a conversation with no title and no message, and every
  conversation with `deleted_at` set.
- In the newer source (`packages/server/src/adapters/web/transport.ts`),
  a frame sent while no reader is connected is held for 60 s, at most
  500 per conversation, whatever its type. An `error` frame therefore
  reaches a late reader the same way the refusal texts did. No launch
  here made Archon send one.
- Status `queued-capacity` and `queued-conversation` were not seen; the
  server was idle for every launch.
