// Records what a local Archon emits around one launch through its HTTP API.
//
//   node record.mjs <scenario> <codebaseId> <outDir>
//
// Scenarios:
//   accepted                   one real launch of archon-forge-check, stream opened first
//   undeclared-no-inputs-block an unknown input name sent to archon-forge-check, which has no
//                              `inputs:` block; Archon accepts it and the run starts
//   undeclared                 an unknown input name sent to archon-review-eval-judge, which
//                              declares inputs, stream opened first
//   missing-required           archon-review-eval-judge without its required input, stream
//                              opened 3 s after the launch
//   empty-message              a launch with an empty message, then a delete of its conversation
//
// Every scenario but `accepted` ends by deleting its conversation, to see whether
// the project's conversation list held it before and after.
//
// Every request, answer and stream frame is written, in order and with a time
// in milliseconds since the scenario began, to <outDir>/<scenario>.raw.json.
// The raw file holds machine paths; scrub.mjs turns it into a fixture.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3090';
const HTTP_TIMEOUT_MS = 30_000;
const SCENARIOS = [
  'accepted',
  'undeclared-no-inputs-block',
  'undeclared',
  'missing-required',
  'empty-message',
];

const [scenario, codebaseId, outDir] = process.argv.slice(2);
if (!SCENARIOS.includes(scenario) || !/^[0-9a-f]{32}$/.test(codebaseId ?? '') || !outDir) {
  console.error(`usage: node record.mjs <${SCENARIOS.join('|')}> <codebaseId> <outDir>`);
  process.exit(2);
}

const t0 = performance.now();
const at = () => Math.round(performance.now() - t0);
const log = [];
const note = (kind, data = {}) => {
  log.push({ atMs: at(), kind, ...data });
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(method, path, body) {
  const init = { method, redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, contentType: res.headers.get('content-type'), body: parsed };
}

/** A request that is written to the log. */
async function call(method, path, body) {
  const startedMs = at();
  try {
    const answer = await request(method, path, body);
    note('http', { method, path, requestBody: body ?? null, startedMs, ...answer });
    return answer;
  } catch (error) {
    note('http-failed', { method, path, requestBody: body ?? null, startedMs, error: String(error) });
    throw error;
  }
}

function parseFrame(raw) {
  const frame = { raw };
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') frame.event = value;
    else if (field === 'id') frame.id = value;
  }
  if (data.length > 0) {
    const text = data.join('\n');
    try {
      frame.data = JSON.parse(text);
    } catch {
      frame.data = text;
    }
  }
  return frame;
}

/** Opens a conversation's stream and logs every frame under `label`. */
async function openStream(conversationId, label) {
  const controller = new AbortController();
  const reader = { label, ended: false, sawUnlock: false, frames: 0, done: Promise.resolve() };
  let res;
  try {
    res = await fetch(`${BASE}/api/stream/${encodeURIComponent(conversationId)}`, {
      headers: { accept: 'text/event-stream' },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    note('stream-open-failed', { label, error: String(error) });
    reader.ended = true;
    return { reader, close: async () => {} };
  }
  note('stream-open', { label, status: res.status, contentType: res.headers.get('content-type') });
  reader.done = (async () => {
    const body = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await body.read();
        if (done) {
          note('stream-end', { label, by: 'server' });
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const raw = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const frame = parseFrame(raw);
          reader.frames += 1;
          if (/"locked"\s*:\s*false/.test(raw)) reader.sawUnlock = true;
          note('frame', { label, ...frame });
        }
      }
    } catch (error) {
      note('stream-end', { label, by: controller.signal.aborted ? 'recorder' : 'error', error: String(error) });
    }
    reader.ended = true;
  })();
  return {
    reader,
    close: async () => {
      controller.abort();
      await reader.done;
    },
  };
}

async function runsOfProject() {
  const answer = await request('GET', `/api/dashboard/runs?codebaseId=${codebaseId}&limit=50`);
  return Array.isArray(answer.body?.runs) ? answer.body.runs : [];
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const matches = (run, conv) =>
  run.parent_conversation_id === conv.id || run.parent_platform_id === conv.conversationId;

/** Polls the runs list until a run of this conversation shows, or the time is up. */
async function waitForRun(conv, everyMs, forMs) {
  const until = at() + forMs;
  let polls = 0;
  while (at() < until) {
    const sentMs = at();
    const run = (await runsOfProject()).find(r => matches(r, conv));
    polls += 1;
    if (run) {
      note('run-found', { pollSentMs: sentMs, polls, run });
      return run;
    }
    await sleep(everyMs);
  }
  note('run-not-found', { polls, waitedMs: forMs });
  return null;
}

async function waitUntil(test, forMs) {
  const until = at() + forMs;
  while (at() < until) {
    if (test()) return true;
    await sleep(50);
  }
  return test();
}

async function createConversation() {
  const answer = await call('POST', '/api/conversations', { codebaseId });
  if (answer.status !== 200 || typeof answer.body?.conversationId !== 'string') {
    throw new Error(`could not create a conversation: ${answer.status}`);
  }
  return answer.body;
}

async function readBack(conv) {
  await call('GET', `/api/conversations/${encodeURIComponent(conv.conversationId)}`);
  await call('GET', `/api/conversations/${encodeURIComponent(conv.conversationId)}/messages?limit=50`);
}

/** Deletes a conversation and logs whether the project's list held it before and after. */
async function deleteAndCheck(conv) {
  const listed = body =>
    Array.isArray(body)
      ? body.some(c => c.id === conv.id || c.platform_conversation_id === conv.conversationId)
      : null;
  const before = await call('GET', `/api/conversations?codebaseId=${codebaseId}`);
  note('listed-before-delete', { listed: listed(before.body) });
  const removed = await call('DELETE', `/api/conversations/${encodeURIComponent(conv.conversationId)}`);
  if (removed.status === 404) {
    await call('DELETE', `/api/conversations/${encodeURIComponent(conv.id)}`);
  }
  const after = await call('GET', `/api/conversations?codebaseId=${codebaseId}`);
  note('listed-after-delete', { listed: listed(after.body) });
  const all = await request('GET', '/api/conversations');
  note('listed-in-all-after-delete', { listed: listed(all.body) });
  await call('GET', `/api/conversations/${encodeURIComponent(conv.conversationId)}`);
  await call('GET', `/api/conversations/${encodeURIComponent(conv.conversationId)}/messages?limit=50`);
}

/**
 * If a launch that should have been refused started a run, stop it. Archon refuses
 * to cancel a pending run, so this keeps asking until the run is running or over.
 */
async function cancelIfStarted(run, conv) {
  if (!run) return;
  note('unexpected-run', { runId: run.id, status: run.status });
  const until = at() + 60_000;
  while (at() < until) {
    const answer = await request('POST', `/api/workflows/runs/${run.id}/cancel`);
    const now = (await runsOfProject()).find(r => matches(r, conv));
    if (answer.status === 200 || !now || TERMINAL.has(now.status)) {
      note('unexpected-run-stopped', { cancelStatus: answer.status, runStatus: now?.status ?? null });
      return;
    }
    await sleep(100);
  }
  note('unexpected-run-not-stopped', { runId: run.id });
}

async function accepted() {
  const conv = await createConversation();
  const first = await openStream(conv.conversationId, 'first');
  await sleep(500);
  note('launch-sent');
  const launching = call('POST', `/api/workflows/archon-forge-check/run`, {
    conversationId: conv.conversationId,
    message: 'Recording a launch for the Orchon plan: check forge access.',
  });
  const finding = waitForRun(conv, 100, 60_000);
  await launching;
  note('launch-answered');
  let run = await finding;
  let lastStatus = run?.status;
  const until = at() + 180_000;
  while (run && !TERMINAL.has(run.status) && at() < until) {
    await sleep(500);
    run = (await runsOfProject()).find(r => matches(r, conv)) ?? run;
    if (run.status !== lastStatus) {
      note('run-status', { status: run.status, was: lastStatus });
      lastStatus = run.status;
    }
  }
  note('lock-released-seen', { seen: await waitUntil(() => first.reader.sawUnlock, 20_000) });
  await sleep(3000);
  await readBack(conv);
  if (run) await call('GET', `/api/workflows/runs/${run.id}`);
  note('runs-of-project', { runs: await runsOfProject() });

  // One reader per conversation: a second reader should close the first.
  const second = await openStream(conv.conversationId, 'second');
  note('first-reader-ended-after-second-opened', {
    ended: await waitUntil(() => first.reader.ended, 5000),
  });
  await sleep(1000);
  await second.close();
  await first.close();
  // The title is written by a model call that outlives the launch.
  await sleep(15_000);
  await call('GET', `/api/conversations/${encodeURIComponent(conv.conversationId)}`);
}

/** A launch with an input name the workflow may not declare, stream opened first. */
async function undeclaredInput(workflowName, message) {
  const conv = await createConversation();
  const first = await openStream(conv.conversationId, 'first');
  await sleep(500);
  note('launch-sent');
  const answer = await call('POST', `/api/workflows/${workflowName}/run`, {
    conversationId: conv.conversationId,
    message,
    inputs: { not_declared: 'x' },
  });
  note('launch-answered', { status: answer.status });
  const run = await waitForRun(conv, 200, 10_000);
  // archon-forge-check is one script and no agent, so a run of it is left to finish.
  if (workflowName !== 'archon-forge-check') await cancelIfStarted(run, conv);
  note('lock-released-seen', { seen: await waitUntil(() => first.reader.sawUnlock, 10_000) });
  await sleep(1000);
  await readBack(conv);
  // Not what the plugin does after a 200; done here to watch a listed conversation leave the list.
  await deleteAndCheck(conv);
  await first.close();
}

async function missingRequired() {
  const conv = await createConversation();
  note('launch-sent');
  const answer = await call('POST', `/api/workflows/archon-review-eval-judge/run`, {
    conversationId: conv.conversationId,
    message: 'Recording a refused launch for the Orchon plan: a required input left out.',
  });
  note('launch-answered', { status: answer.status });
  const finding = waitForRun(conv, 200, 10_000);
  await sleep(3000);
  // Opened only now: anything that arrives was held back for a late reader.
  const late = await openStream(conv.conversationId, 'late');
  const run = await finding;
  await cancelIfStarted(run, conv);
  await sleep(2000);
  await readBack(conv);
  await deleteAndCheck(conv);
  await late.close();
}

async function emptyMessage() {
  const conv = await createConversation();
  const first = await openStream(conv.conversationId, 'first');
  await sleep(500);
  note('launch-sent');
  const answer = await call('POST', `/api/workflows/archon-forge-check/run`, {
    conversationId: conv.conversationId,
    message: '',
  });
  note('launch-answered', { status: answer.status });
  await sleep(1000);
  await deleteAndCheck(conv);
  note('stream-after-delete', { ended: await waitUntil(() => first.reader.ended, 2000) });
  await first.close();
}

const flows = {
  accepted,
  'undeclared-no-inputs-block': () =>
    undeclaredInput(
      'archon-forge-check',
      'Recording a refused launch for the Orchon plan: an undeclared input.'
    ),
  undeclared: () =>
    undeclaredInput(
      'archon-review-eval-judge',
      'Recording a refused launch for the Orchon plan: an undeclared input on a workflow that declares inputs.'
    ),
  'missing-required': missingRequired,
  'empty-message': emptyMessage,
};

const recordedAt = new Date().toISOString();
let failure = null;
try {
  await call('GET', '/api/health');
  await flows[scenario]();
} catch (error) {
  failure = String(error?.stack ?? error);
  note('recorder-failed', { error: failure });
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${scenario}.raw.json`);
writeFileSync(file, JSON.stringify({ scenario, recordedAt, codebaseId, log }, null, 2) + '\n');
console.log(`${failure ? 'FAILED' : 'ok'}: ${log.length} entries -> ${file}`);
process.exit(failure ? 1 : 0);
