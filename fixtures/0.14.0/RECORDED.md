# Archon 0.14.0: recorded fixtures

Written by `scripts/record-fixtures.ts`. Do not edit these files by hand: record them again.

- Recorded at: 2026-11-19T01:04:48Z
- Release: 0.14.0
- Binary: `archon-windows-x64.exe`, 90,520,064 bytes, SHA-256 `aebc48ee8422ce9fbe426af730e17261f058923cd27293b46254d1cf9555744c`
- The binary reports: `Archon CLI v0.14.0 Platform: win32-x64 Build: binary Database: sqlite Git commit: 8def159a`
- The running server reported version: `0.14.0`
- Recorded on: win32 x64
- Archon home: a throwaway folder the recorder made and deleted afterwards

## What was recorded

| File | What it holds |
| --- | --- |
| `answer.json` | POST answer on an attention wait: a wrong occurrence, an unknown option, no choice, no occurrence, a respond sent to the wait, the answer with its occurrence, the same answer again, and the finished run |
| `artifacts.json` | a run's artifact list, one text file and a file that does not exist |
| `attention-empty.json` | GET /api/runs/attention |
| `attention-gate.json` | the attention queue, the run and the dashboard count while a run waits at an approval gate |
| `attention-wait.json` | the attention queue, the run and the dashboard count while a run waits at an attention wait |
| `auth.json` | every /api/auth/* path that the path list gives a GET and no parameter |
| `codebases-empty.json` | GET /api/codebases |
| `codebases.json` | POST /api/codebases for the throwaway project, then the list and the one project |
| `config-aliases.json` | PATCH /api/config/aliases: a merge, a null removal, the config after each, and two refused requests |
| `config-assistants.json` | PATCH /api/config/assistants: a merge, the config after it, and two refused requests |
| `config-tiers.json` | PATCH /api/config/tiers: a merge, a null removal, the config after each, and two refused requests |
| `config.json` | GET /api/config |
| `conversations-empty.json` | GET /api/conversations |
| `conversations.json` | the conversation list, all and for one project, then one conversation and its messages |
| `dashboard-runs-empty.json` | GET /api/dashboard/runs, before any run |
| `dashboard-runs.json` | GET /api/dashboard/runs with runs: all, one, one project and one status |
| `deletes.json` | DELETE of a run and of the throwaway project, with a read after each |
| `health.json` | GET /api/health |
| `launch-accepted.json` | a launch that starts a run: every request, answer and stream frame, in order |
| `launch-empty-message.json` | a launch refused with a 400, then the delete of its conversation |
| `launch-missing-required.json` | a launch refused after a 200: a required input left out, the stream opened late |
| `launch-undeclared-no-inputs-block.json` | a launch with an input name sent to a workflow that declares no inputs |
| `launch-undeclared.json` | a launch refused after a 200: an input name the workflow does not declare |
| `metrics.json` | GET /api/metric-views and /api/metrics, which a release before 0.14.0 answers with its HTML page |
| `missing-path.json` | GET /api/orchon-recorder-missing |
| `openapi.json` | GET /api/openapi.json |
| `providers.json` | GET /api/providers |
| `respond.json` | POST respond on a gate: mismatches of each id, the node id alone, an unknown and a missing decision, an approval guarded by both ids, and the same approval again |
| `run-by-worker.json` | GET /api/workflows/runs/by-worker/web-worker-1795050313338-bvgrg9 |
| `run-control-paused.json` | a run that waits at a gate: cancel, resume, abandon, the run after it, abandon again and a late respond |
| `run-control-running.json` | a run with live work: the run while it works, resume, cancel, the run after it, then cancel, resume and abandon on the cancelled run, with the dashboard stream throughout |
| `run-detail.json` | GET /api/workflows/runs/68b479b2-217a-4e84-b86d-ecb9faf394e6 |
| `run-failed.json` | a run whose one step fails: the run, the queue and the failed filter, then cancel, resume, the run after it, and abandon twice |
| `run-provider-events.json` | GET /api/workflows/runs/68b479b2-217a-4e84-b86d-ecb9faf394e6/provider-events |
| `run-unknown.json` | every run route for a run id that does not exist |
| `server.json` | the release's own server.json, from its Archon home |
| `update-check.json` | GET /api/update-check |
| `validate.json` | POST /api/workflows/validate: a valid definition, an invalid one and a malformed request |
| `workflows.json` | GET /api/workflows |
| `workflows/archon-attention.json` | GET /api/workflows/archon-attention |
| `workflows/archon-attention.yaml` | the YAML of archon-attention as the release holds it |
| `workflows/archon-build-queue.json` | GET /api/workflows/archon-build-queue |
| `workflows/archon-build-queue.yaml` | the YAML of archon-build-queue as the release holds it |
| `workflows/archon-deliver-block.json` | GET /api/workflows/archon-deliver-block |
| `workflows/archon-deliver-block.yaml` | the YAML of archon-deliver-block as the release holds it |
| `workflows/archon-deliver.json` | GET /api/workflows/archon-deliver |
| `workflows/archon-deliver.yaml` | the YAML of archon-deliver as the release holds it |
| `workflows/archon-discoveries.json` | GET /api/workflows/archon-discoveries |
| `workflows/archon-discoveries.yaml` | the YAML of archon-discoveries as the release holds it |
| `workflows/archon-forge-check.json` | GET /api/workflows/archon-forge-check |
| `workflows/archon-forge-check.yaml` | the YAML of archon-forge-check as the release holds it |
| `workflows/archon-implement.json` | GET /api/workflows/archon-implement |
| `workflows/archon-implement.yaml` | the YAML of archon-implement as the release holds it |
| `workflows/archon-intake.json` | GET /api/workflows/archon-intake |
| `workflows/archon-intake.yaml` | the YAML of archon-intake as the release holds it |
| `workflows/archon-investigate.json` | GET /api/workflows/archon-investigate |
| `workflows/archon-investigate.yaml` | the YAML of archon-investigate as the release holds it |
| `workflows/archon-merge-queue.json` | GET /api/workflows/archon-merge-queue |
| `workflows/archon-merge-queue.yaml` | the YAML of archon-merge-queue as the release holds it |
| `workflows/archon-metrics-prs.json` | GET /api/workflows/archon-metrics-prs |
| `workflows/archon-metrics-prs.yaml` | the YAML of archon-metrics-prs as the release holds it |
| `workflows/archon-metrics-test-value-calibrate.json` | GET /api/workflows/archon-metrics-test-value-calibrate |
| `workflows/archon-metrics-test-value-calibrate.yaml` | the YAML of archon-metrics-test-value-calibrate as the release holds it |
| `workflows/archon-metrics-test-value-judge.json` | GET /api/workflows/archon-metrics-test-value-judge |
| `workflows/archon-metrics-test-value-judge.yaml` | the YAML of archon-metrics-test-value-judge as the release holds it |
| `workflows/archon-metrics-test-value.json` | GET /api/workflows/archon-metrics-test-value |
| `workflows/archon-metrics-test-value.yaml` | the YAML of archon-metrics-test-value as the release holds it |
| `workflows/archon-plan-block.json` | GET /api/workflows/archon-plan-block |
| `workflows/archon-plan-block.yaml` | the YAML of archon-plan-block as the release holds it |
| `workflows/archon-plan.json` | GET /api/workflows/archon-plan |
| `workflows/archon-plan.yaml` | the YAML of archon-plan as the release holds it |
| `workflows/archon-pr.json` | GET /api/workflows/archon-pr |
| `workflows/archon-pr.yaml` | the YAML of archon-pr as the release holds it |
| `workflows/archon-review-block.json` | GET /api/workflows/archon-review-block |
| `workflows/archon-review-block.yaml` | the YAML of archon-review-block as the release holds it |
| `workflows/archon-review-eval-judge.json` | GET /api/workflows/archon-review-eval-judge |
| `workflows/archon-review-eval-judge.yaml` | the YAML of archon-review-eval-judge as the release holds it |
| `workflows/archon-review-eval.json` | GET /api/workflows/archon-review-eval |
| `workflows/archon-review-eval.yaml` | the YAML of archon-review-eval as the release holds it |
| `workflows/archon-review.json` | GET /api/workflows/archon-review |
| `workflows/archon-review.yaml` | the YAML of archon-review as the release holds it |
| `workflows/archon-ship-block.json` | GET /api/workflows/archon-ship-block |
| `workflows/archon-ship-block.yaml` | the YAML of archon-ship-block as the release holds it |
| `workflows/archon-ship.json` | GET /api/workflows/archon-ship |
| `workflows/archon-ship.yaml` | the YAML of archon-ship as the release holds it |
| `workflows/archon-simplify.json` | GET /api/workflows/archon-simplify |
| `workflows/archon-simplify.yaml` | the YAML of archon-simplify as the release holds it |
| `workflows/archon-split.json` | GET /api/workflows/archon-split |
| `workflows/archon-split.yaml` | the YAML of archon-split as the release holds it |
| `workflows/archon-triage-block.json` | GET /api/workflows/archon-triage-block |
| `workflows/archon-triage-block.yaml` | the YAML of archon-triage-block as the release holds it |
| `workflows/archon-triage.json` | GET /api/workflows/archon-triage |
| `workflows/archon-triage.yaml` | the YAML of archon-triage as the release holds it |
| `workflows/archon-upkeep.json` | GET /api/workflows/archon-upkeep |
| `workflows/archon-upkeep.yaml` | the YAML of archon-upkeep as the release holds it |
| `workflows/archon-validate.json` | GET /api/workflows/archon-validate |
| `workflows/archon-validate.yaml` | the YAML of archon-validate as the release holds it |
| `workflows/archon-worktree-cleanup.json` | GET /api/workflows/archon-worktree-cleanup |
| `workflows/archon-worktree-cleanup.yaml` | the YAML of archon-worktree-cleanup as the release holds it |

## What could not be recorded

- respond accepted with a string expectedGate: the gate this release paused at has a pause id, and the node id alone answered 409; that answer is in respond.json
- a null removal on PATCH /api/config/assistants: the release's UpdateAssistantConfigBody in openapi.json takes an object for each assistant and never null, so there is no removal to record; the tiers and aliases routes record theirs

## What was scrubbed

Each of these stands for a value of the machine that recorded:

- `<project-path>`: the throwaway project folder
- `<archon-home>`: the throwaway Archon home
- `<recorder-folder>`: the folder that held both
- `<temp>`: the machine's temp folder
- `<home>`: the developer's home folder
- `<binary>`: the release binary's path
- `<user>`: the developer's account name
- `<host>`: the machine's name
- `<store-id>`: the install's store id
