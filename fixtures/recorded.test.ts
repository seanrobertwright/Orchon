// The fixtures recorded from each supported Archon release: what every release folder must
// hold, that nothing of the recording machine is left in it, and that no recording launched a
// workflow other than the recorder's own.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { findLeaks } from '../scripts/recorder/leaks.ts'
import { SPEND_FOLDER } from '../scripts/recorder/output.ts'
import { SPEND_SCENARIO_NAMES } from '../scripts/recorder/spend.ts'
import { FORBIDDEN_WORKFLOWS, RECORDER_WORKFLOWS } from '../scripts/recorder/workflows.ts'
import { repoRoot } from '../scripts/repo-files.ts'

/** The floor and the newest patch of each later minor. */
const RELEASES = ['0.12.1', '0.13.2', '0.14.0']

/** The first release whose path list has the metrics paths. */
const METRICS_SINCE = '0.14.0'

interface HttpEntry {
  kind: 'http'
  method: string
  path: string
  requestBody: unknown
  status: number
  contentType: string | null
  body: unknown
}

interface Entry {
  atMs: number
  kind: string
  [field: string]: unknown
}

interface Recording {
  release: string
  scenario: string
  log: Entry[]
}

const folderOf = (release: string): string => join(repoRoot, 'fixtures', release)

/** A release or a workflow name as a literal inside a pattern. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every file of a folder, as paths with forward slashes relative to it, sorted. */
function filesIn(folder: string): string[] {
  return (readdirSync(folder, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1).replaceAll('\\', '/'))
    .sort()
}

/**
 * Every file of a release folder that the recording that spends nothing wrote. The spend-mode
 * recordings in its `spend` folder are checked on their own.
 */
const filesOf = (release: string): string[] => filesIn(folderOf(release)).filter((path) => !path.startsWith(`${SPEND_FOLDER}/`))

/** The spend-mode scenario folders a release has, such as `agent-step`. */
function spendScenariosOf(release: string): string[] {
  const folder = join(folderOf(release), SPEND_FOLDER)
  if (!existsSync(folder)) return []
  return (readdirSync(folder, { withFileTypes: true }) as import('node:fs').Dirent[]).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

const textOf = (release: string, path: string): string => readFileSync(join(folderOf(release), path), 'utf8')

function recordingOf(release: string, scenario: string): Recording {
  return JSON.parse(textOf(release, `${scenario}.json`)) as Recording
}

const isHttp = (entry: Entry): entry is Entry & HttpEntry => entry.kind === 'http'

/** The requests of a recording, in order. */
const callsOf = (release: string, scenario: string): HttpEntry[] => recordingOf(release, scenario).log.filter(isHttp)

/** The requests of a recording that went to a path ending in `suffix` with `method`. */
const callsTo = (release: string, scenario: string, method: string, suffix: string): HttpEntry[] =>
  callsOf(release, scenario).filter((call) => call.method === method && (call.path.split('?')[0] ?? '').endsWith(suffix))

const statuses = (calls: readonly HttpEntry[]): number[] => calls.map((call) => call.status)

/** A field of a body, or undefined when the body has another shape. */
function field(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const isJson = (call: HttpEntry): boolean => call.contentType?.startsWith('application/json') === true
const isHtml = (call: HttpEntry): boolean => call.contentType?.startsWith('text/html') === true && typeof call.body === 'string'

/** The files of a release that are recordings: every JSON file but the release's own `server.json`. */
const recordingFiles = (release: string): string[] => filesOf(release).filter((path) => path.endsWith('.json') && path !== 'server.json')

/** The names of the bundled workflows in a release's workflow list. */
function bundledWorkflows(release: string): string[] {
  const [listed] = callsOf(release, 'workflows')
  const entries = field(listed?.body, 'workflows')
  assert.ok(Array.isArray(entries), `${release}: the workflow list has no workflows`)
  return (entries as unknown[])
    .filter((entry) => field(entry, 'source') === 'bundled')
    .map((entry) => String(field(entry, 'workflow', 'name')))
}

/** The scenarios every release folder holds, beside one load answer and one YAML file for each bundled workflow. */
const SCENARIOS = [
  'health',
  'openapi',
  'codebases-empty',
  'codebases',
  'dashboard-runs-empty',
  'dashboard-runs',
  'run-detail',
  'run-by-worker',
  'run-provider-events',
  'run-unknown',
  'workflows',
  'validate',
  'config',
  'providers',
  'update-check',
  'config-assistants',
  'config-tiers',
  'config-aliases',
  'auth',
  'conversations-empty',
  'conversations',
  'attention-empty',
  'attention-gate',
  'attention-wait',
  'artifacts',
  'missing-path',
  'metrics',
  'launch-accepted',
  'launch-undeclared-no-inputs-block',
  'launch-undeclared',
  'launch-missing-required',
  'launch-empty-message',
  'respond',
  'answer',
  'run-control-paused',
  'run-control-running',
  'run-failed',
  'deletes'
]

/** Every path the plugin requires of a server, from "Versions" in the spec. */
const REQUIRED_PATHS = [
  '/api/health',
  '/api/codebases',
  '/api/dashboard/runs',
  '/api/runs/attention',
  '/api/runs/{runId}/artifacts',
  '/api/workflows',
  '/api/workflows/validate',
  '/api/workflows/{name}',
  '/api/workflows/{name}/run',
  '/api/workflows/runs/{runId}',
  '/api/workflows/runs/{runId}/cancel',
  '/api/workflows/runs/{runId}/resume',
  '/api/workflows/runs/{runId}/abandon',
  '/api/workflows/runs/{runId}/respond',
  '/api/workflows/runs/{runId}/answer',
  '/api/workflows/runs/{runId}/provider-events',
  '/api/workflows/runs/by-worker/{platformId}',
  '/api/conversations',
  '/api/conversations/{id}',
  '/api/conversations/{id}/messages',
  '/api/conversations/{id}/message',
  '/api/config',
  '/api/config/assistants',
  '/api/config/tiers',
  '/api/config/aliases',
  '/api/providers',
  '/api/update-check'
]

const METRICS_PATHS = ['/api/metrics', '/api/metric-views']

const pathList = (release: string): string[] => Object.keys((field(callsOf(release, 'openapi')[0]?.body, 'paths') as object | undefined) ?? {})

/**
 * The `host` values that name no machine: the placeholder, the addresses a release listens on,
 * and the empty and `.example` hosts a bundled workflow's prompt shows as examples.
 */
const NOT_A_MACHINE = /(?:<host>|0\.0\.0\.0|127\.0\.0\.1|localhost|[a-z0-9.-]*\.example|)/.source

/** What no fixture may hold, each with the words a failure names it by. */
const MACHINE_DETAILS: [RegExp, string][] = [
  [/[A-Za-z]:(?:\\{1,4}|\/)(?:Users|Documents and Settings|Windows|ProgramData)\b/i, 'a Windows folder'],
  [/(?:^|[^<\w.-])AppData[\\/]/, 'an AppData folder'],
  [/\/(?:home|Users)\/[^/<\s"]+\/\.(?:archon|claude|config)\b/, 'a home folder'],
  [/"(?:storeId|store_id)":\s*"(?!<store-id>")/, 'a store id'],
  [/\\"(?:storeId|store_id)\\":\s*\\"(?!<store-id>\\")/, 'a store id inside a stream frame'],
  [new RegExp(`"host(?:name)?":\\s*"(?!${NOT_A_MACHINE}")`), 'a machine name'],
  // A stream frame, or a prompt inside one, escapes its quotes once or more.
  [new RegExp(`\\\\+"host(?:name)?\\\\+":\\s*\\\\+"(?!${NOT_A_MACHINE}\\\\+")`), 'a machine name inside a stream frame']
]

// The spend-mode recordings, when a release has any: each was made by the recorder in spend mode,
// lists its files, and holds nothing of the machine, no token and no email address.
for (const release of RELEASES) {
  for (const scenario of spendScenariosOf(release)) {
    describe(`the ${scenario} spend-mode recording of Archon ${release}`, () => {
      const folder = join(folderOf(release), SPEND_FOLDER, scenario)
      test('is a scenario the recorder knows, with a log that says it was recorded in spend mode', () => {
        assert.ok((SPEND_SCENARIO_NAMES as readonly string[]).includes(scenario), scenario)
        const log = readFileSync(join(folder, 'RECORDED.md'), 'utf8').replaceAll('\r\n', '\n')
        assert.ok(log.includes(`\n- Recorded in spend mode: the \`${scenario}\` scenario alone\n`), `${scenario} has no spend-mode line`)
        const listed = [...log.matchAll(/^\| `([^`]+)` \| .+ \|$/gm)].map((row) => row[1])
        assert.deepEqual(listed, filesIn(folder).filter((path) => path !== 'RECORDED.md'))
      })

      test('holds nothing of the machine, no token and no email address', () => {
        for (const path of filesIn(folder)) {
          const text = readFileSync(join(folder, path), 'utf8')
          for (const [pattern, what] of MACHINE_DETAILS) assert.ok(!pattern.test(text), `${scenario}/${path} holds ${what}`)
          assert.deepEqual(findLeaks(text, { loginFolder: '', homeFolder: '', user: '' }), [], `${scenario}/${path}`)
        }
      })
    })
  }
}

for (const release of RELEASES) {
  describe(`the fixtures of Archon ${release}`, () => {
    test('are there, with a log', () => {
      assert.ok(existsSync(join(folderOf(release), 'RECORDED.md')), `fixtures/${release} has no RECORDED.md`)
    })

    test('the log says what was recorded, when, from which binary, and what could not be', () => {
      const log = textOf(release, 'RECORDED.md')
      assert.match(log, new RegExp(`^# Archon ${literal(release)}: recorded fixtures$`, 'm'))
      assert.match(log, /^- Recorded at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m)
      assert.match(log, /^- Binary: `archon-[a-z0-9.-]+`, [\d,]+ bytes, SHA-256 `[0-9a-f]{64}`$/m)
      assert.match(log, new RegExp(`^- The binary reports: \`Archon CLI v${literal(release)} .*Build: binary`, 'm'))
      assert.match(log, new RegExp(`^- The running server reported version: \`${literal(release)}\`$`, 'm'))
      assert.match(log, /^## What was recorded$/m)
      assert.match(log, /^## What could not be recorded$/m)
    })

    test('the log lists every file of the folder and no other', () => {
      const listed = [...textOf(release, 'RECORDED.md').matchAll(/^\| `([^`]+)` \| .+ \|$/gm)].map((row) => row[1])
      assert.deepEqual(listed, filesOf(release).filter((path) => path !== 'RECORDED.md'))
    })

    test('hold every scenario', () => {
      const files = filesOf(release)
      for (const scenario of SCENARIOS) assert.ok(files.includes(`${scenario}.json`), `${release} has no ${scenario}.json`)
    })

    test('every recording names its release and its scenario, and every entry has a time and a kind', () => {
      for (const path of recordingFiles(release)) {
        const recording = JSON.parse(textOf(release, path)) as Recording
        assert.equal(recording.release, release, path)
        assert.equal(`${recording.scenario}.json`, path)
        assert.ok(recording.log.length > 0, `${path} is empty`)
        let last = 0
        for (const entry of recording.log) {
          assert.ok(Number.isInteger(entry.atMs) && entry.atMs >= last, `${path}: entries are out of order`)
          last = entry.atMs
          assert.ok(typeof entry.kind === 'string' && entry.kind !== '', path)
          if (!isHttp(entry)) continue
          assert.ok(typeof entry.method === 'string' && entry.path.startsWith('/'), path)
          assert.ok(Number.isInteger(entry.status) && Object.hasOwn(entry, 'body') && Object.hasOwn(entry, 'requestBody'), path)
        }
      }
    })

    test('hold nothing of the machine that recorded them', () => {
      // The recorder's temp folder is `orchon-recorder-` and six characters. Its workflows share the prefix.
      const own = Object.values(RECORDER_WORKFLOWS).map((workflow) => workflow.name)
      for (const path of filesOf(release)) {
        const text = textOf(release, path)
        for (const [pattern, what] of MACHINE_DETAILS) assert.ok(!pattern.test(text), `fixtures/${release}/${path} holds ${what}`)
        const folders = [...text.matchAll(/orchon-recorder-[A-Za-z0-9]{6}(?![A-Za-z0-9-])/g)].map((match) => match[0])
        assert.deepEqual(
          folders.filter((folder) => !own.includes(folder)),
          [],
          `fixtures/${release}/${path} holds the recorder's temp folder`
        )
      }
    })

    test('hold no string shaped like a key or a token, and no email address a person owns', () => {
      for (const path of filesOf(release)) {
        assert.deepEqual(findLeaks(textOf(release, path), { loginFolder: '', homeFolder: '', user: '' }), [], `fixtures/${release}/${path}`)
      }
    })

    test('every launch is of one of the recorder own workflows, and never the cleanup workflow', () => {
      const own = Object.values(RECORDER_WORKFLOWS).map((workflow) => workflow.name)
      const launched: string[] = []
      for (const path of recordingFiles(release)) {
        const recording = JSON.parse(textOf(release, path)) as Recording
        for (const call of recording.log.filter(isHttp)) {
          const launch = /^\/api\/workflows\/([^/?]+)\/run(?:\?|$)/.exec(call.path)
          if (call.method !== 'POST' || launch?.[1] === undefined) continue
          const name = decodeURIComponent(launch[1])
          assert.ok(own.includes(name), `${path} launches ${name}`)
          assert.ok(!FORBIDDEN_WORKFLOWS.includes(name), `${path} launches ${name}`)
          launched.push(name)
        }
        // No chat message is sent either: that would start Archon's agent.
        assert.deepEqual(
          recording.log.filter(isHttp).filter((call) => call.method === 'POST' && /\/api\/conversations\/[^/]+\/message$/.test(call.path)),
          [],
          path
        )
      }
      assert.ok(launched.length > 0)
    })

    test('the path list has every required path, and the metrics paths only from the release that added them', () => {
      const paths = pathList(release)
      for (const path of REQUIRED_PATHS) assert.ok(paths.includes(path), `${release} has no ${path}`)
      const hasMetrics = METRICS_PATHS.every((path) => paths.includes(path))
      assert.equal(hasMetrics, RELEASES.indexOf(release) >= RELEASES.indexOf(METRICS_SINCE))
      // Called by the plugin but never in the document.
      assert.ok(!paths.some((path) => path.startsWith('/api/stream/')))
      const metrics = callsOf(release, 'metrics')
      assert.equal(metrics.length, METRICS_PATHS.length)
      for (const call of metrics) {
        assert.equal(call.status, 200)
        assert.equal(isJson(call), hasMetrics, `${release}: ${call.path}`)
        assert.equal(isHtml(call), !hasMetrics, `${release}: ${call.path}`)
      }
    })

    test('health answers ok, and server.json is there or the log says the release writes none', () => {
      const [health] = callsOf(release, 'health')
      assert.equal(field(health?.body, 'status'), 'ok')
      assert.equal(field(health?.body, 'version'), release)
      if (filesOf(release).includes('server.json')) {
        const server = JSON.parse(textOf(release, 'server.json')) as Record<string, unknown>
        assert.ok(Number.isInteger(server.port))
        assert.equal(server.storeId, '<store-id>')
        assert.equal(field(health?.body, 'storeId'), '<store-id>')
      } else {
        assert.match(textOf(release, 'RECORDED.md'), /^- server\.json: this release wrote no server\.json/m)
      }
    })

    test('lists are recorded empty and not', () => {
      assert.deepEqual(callsOf(release, 'codebases-empty')[0]?.body, [])
      assert.equal(statuses(callsTo(release, 'codebases', 'POST', '/api/codebases'))[0], 201)
      const listed = callsTo(release, 'codebases', 'GET', '/api/codebases')[0]?.body
      assert.equal(field((listed as unknown[])[0], 'default_cwd'), '<project-path>')
      for (const call of callsOf(release, 'dashboard-runs-empty')) assert.deepEqual(field(call.body, 'runs'), [])
      for (const call of callsOf(release, 'dashboard-runs')) assert.ok((field(call.body, 'runs') as unknown[]).length > 0, call.path)
      assert.ok(callsOf(release, 'dashboard-runs').some((call) => call.path.includes('limit=1')))
      assert.deepEqual(field(callsOf(release, 'attention-empty')[0]?.body, 'runs'), [])
      assert.deepEqual(callsOf(release, 'conversations-empty')[0]?.body, [])
      const conversations = callsOf(release, 'conversations')
      assert.ok((conversations[0]?.body as unknown[]).length > 0)
      const messages = conversations.find((call) => call.path.includes('/messages'))?.body as unknown[]
      assert.ok(messages.some((message) => field(message, 'role') === 'user'))
      assert.ok(messages.some((message) => field(message, 'role') === 'assistant'))
    })

    test('a run is recorded: its detail, by its worker, its events and its artifacts with one text file', () => {
      assert.equal(field(callsOf(release, 'run-detail')[0]?.body, 'run', 'status'), 'completed')
      assert.ok(Array.isArray(field(callsOf(release, 'run-detail')[0]?.body, 'events')))
      assert.equal(callsOf(release, 'run-by-worker')[0]?.status, 200)
      assert.ok(Array.isArray(field(callsOf(release, 'run-provider-events')[0]?.body, 'events')))
      const [listed, file, missing] = callsOf(release, 'artifacts')
      assert.deepEqual(
        (field(listed?.body, 'files') as unknown[]).map((entry) => field(entry, 'path')),
        ['notes/recorded.md']
      )
      assert.equal(file?.status, 200)
      assert.match(String(file?.body), /^# Recorded\n/)
      assert.equal(missing?.status, 404)
      for (const call of callsOf(release, 'run-unknown')) assert.equal(call.status, 404, call.path)
    })

    test('every bundled workflow has its load answer and its YAML', () => {
      const bundled = bundledWorkflows(release)
      assert.ok(bundled.length > 0)
      const files = filesOf(release)
      for (const name of bundled) {
        assert.ok(files.includes(`workflows/${name}.json`), `${release} has no load answer for ${name}`)
        assert.ok(files.includes(`workflows/${name}.yaml`), `${release} has no YAML for ${name}`)
        const [loaded] = callsOf(release, `workflows/${name}`)
        assert.equal(loaded?.status, 200)
        assert.equal(field(loaded?.body, 'source'), 'bundled')
        assert.equal(field(loaded?.body, 'workflow', 'name'), name)
        assert.match(textOf(release, `workflows/${name}.yaml`), new RegExp(`^name: ${literal(name)}$`, 'm'))
      }
      assert.equal(files.filter((path) => path.startsWith('workflows/')).length, bundled.length * 2)
    })

    test('validate, config, providers and the update check are recorded', () => {
      const [valid, invalid, malformed] = callsOf(release, 'validate')
      assert.equal(field(valid?.body, 'valid'), true)
      assert.equal(field(invalid?.body, 'valid'), false)
      assert.equal(malformed?.status, 400)
      assert.ok(field(callsOf(release, 'config')[0]?.body, 'config') !== undefined)
      assert.ok(Array.isArray(field(callsOf(release, 'providers')[0]?.body, 'providers')))
      assert.equal(typeof field(callsOf(release, 'update-check')[0]?.body, 'updateAvailable'), 'boolean')
    })

    test('each config write is recorded as a merge, a null removal where the route has one, and a 400', () => {
      const assistants = callsTo(release, 'config-assistants', 'PATCH', '/api/config/assistants')
      assert.equal(assistants[0]?.status, 200)
      assert.ok(statuses(assistants).includes(400))
      for (const [scenario, key, name] of [
        ['config-tiers', 'tiers', 'small'],
        ['config-aliases', 'aliases', '@orchon-recorded']
      ] as const) {
        const writes = callsTo(release, scenario, 'PATCH', `/api/config/${key}`)
        const [merge, removal] = writes
        assert.equal(merge?.status, 200, scenario)
        assert.ok(field(merge?.body, 'config', key, name) !== undefined, `${scenario}: the merge is not in the answer`)
        assert.equal(field(removal?.requestBody, key, name), null, scenario)
        assert.equal(removal?.status, 200, scenario)
        assert.equal(field(removal?.body, 'config', key, name), undefined, `${scenario}: the removed entry is still there`)
        assert.ok(statuses(writes).includes(400), scenario)
      }
    })

    test('the auth routes answer 401, and a missing path answers the HTML page', () => {
      const auth = callsOf(release, 'auth')
      assert.ok(auth.filter((call) => call.status === 401 && isJson(call)).length >= 3)
      assert.ok(auth.every((call) => call.method === 'GET' && call.path.startsWith('/api/auth/')))
      const [missing] = callsOf(release, 'missing-path')
      assert.equal(missing?.status, 200)
      assert.ok(missing !== undefined && isHtml(missing))
    })

    test('the attention queue is recorded with a gate and with an attention wait', () => {
      const gate = field((field(callsOf(release, 'attention-gate')[0]?.body, 'runs') as unknown[])[0], 'attention')
      assert.equal(field(gate, 'kind'), 'awaiting_response')
      const wait = field((field(callsOf(release, 'attention-wait')[0]?.body, 'runs') as unknown[])[0], 'attention')
      assert.equal(field(wait, 'kind'), 'attention')
      assert.equal(field(wait, 'form'), 'select')
      assert.equal(typeof field(wait, 'occurrence'), 'string')
    })

    test('an accepted launch is recorded with its stream frames, start to finish', () => {
      const recording = recordingOf(release, 'launch-accepted')
      const frames = recording.log.filter((entry) => entry.kind === 'frame')
      const types = (label: string): unknown[] => frames.filter((frame) => frame.label === label).map((frame) => field(frame.data, 'type'))
      for (const type of ['conversation_lock', 'text', 'workflow_dispatch', 'workflow_status', 'dag_node']) {
        assert.ok(types('first').includes(type), `${release}: no ${type} frame on the conversation's stream`)
      }
      for (const type of ['workflow_status', 'dag_node']) assert.ok(types('dashboard').includes(type), `${release}: no ${type} frame on the dashboard stream`)
      for (const frame of frames) assert.equal(typeof frame.raw, 'string')
      assert.equal(callsTo(release, 'launch-accepted', 'POST', '/run')[0]?.status, 200)
      assert.ok(recording.log.some((entry) => entry.kind === 'run-found'))
      // A second reader ends the first reader's stream.
      assert.ok(recording.log.some((entry) => entry.kind === 'stream-end' && entry.label === 'first' && entry.by === 'server'))
    })

    test('launches refused after a 200 and a launch refused with a 400 are recorded', () => {
      for (const scenario of ['launch-undeclared', 'launch-missing-required']) {
        const recording = recordingOf(release, scenario)
        assert.equal(callsTo(release, scenario, 'POST', '/run')[0]?.status, 200, scenario)
        assert.deepEqual(field(callsTo(release, scenario, 'POST', '/run')[0]?.body, 'accepted'), true, scenario)
        assert.ok(recording.log.some((entry) => entry.kind === 'run-not-found'), `${scenario}: a run started`)
        const types = recording.log.filter((entry) => entry.kind === 'frame').map((frame) => field(frame.data, 'type'))
        assert.ok(types.includes('text') && !types.includes('workflow_dispatch'), scenario)
      }
      assert.ok(recordingOf(release, 'launch-undeclared-no-inputs-block').log.some((entry) => entry.kind === 'run-found'))
      const empty = callsTo(release, 'launch-empty-message', 'POST', '/run')[0]
      assert.equal(empty?.status, 400)
      assert.equal(field(empty?.requestBody, 'message'), '')
    })

    test('respond is recorded with both forms of expectedGate, a 409 on a mismatch and an accepted answer', () => {
      const responds = callsTo(release, 'respond', 'POST', '/respond')
      const guards = responds.map((call) => field(call.requestBody, 'expectedGate'))
      assert.ok(guards.some((guard) => typeof guard === 'string'))
      assert.ok(guards.some((guard) => typeof field(guard, 'nodeId') === 'string' && typeof field(guard, 'pauseId') === 'string'))
      assert.ok(statuses(responds).includes(409))
      const accepted = responds.filter((call) => call.status === 200)
      assert.equal(accepted.length, 1)
      assert.equal(field(accepted[0]?.body, 'success'), true)
      // Whichever form the release accepted, the log says so when the other could not be.
      if (typeof field(accepted[0]?.requestBody, 'expectedGate') !== 'string') {
        assert.match(textOf(release, 'RECORDED.md'), /^- respond accepted with a string expectedGate: /m)
      }
    })

    test('answer is recorded with its occurrence, and refused for another one', () => {
      const answers = callsTo(release, 'answer', 'POST', '/answer')
      const accepted = answers.filter((call) => call.status === 200)
      assert.equal(accepted.length, 1)
      assert.equal(typeof field(accepted[0]?.requestBody, 'occurrence'), 'string')
      assert.deepEqual(field(accepted[0]?.requestBody, 'choose'), ['first'])
      assert.ok(answers.some((call) => call.status === 409 && field(call.requestBody, 'occurrence') === 'orchon-recorder-other-occurrence'))
      assert.equal(field(callsOf(release, 'answer').at(-1)?.body, 'run', 'status'), 'completed')
    })

    test('cancel, abandon and resume are recorded as accepted and as refused', () => {
      const all = ['run-control-paused', 'run-control-running', 'run-failed'].flatMap((scenario) => callsOf(release, scenario))
      for (const action of ['cancel', 'abandon', 'resume']) {
        const calls = all.filter((call) => call.method === 'POST' && call.path.endsWith(`/${action}`))
        assert.ok(calls.some((call) => call.status === 200 && field(call.body, 'success') === true), `${release}: no accepted ${action}`)
        assert.ok(calls.some((call) => call.status >= 400), `${release}: no refused ${action}`)
      }
      assert.equal(statuses(callsTo(release, 'run-control-running', 'POST', '/cancel'))[0], 200)
      assert.ok(callsOf(release, 'run-failed').some((call) => field(call.body, 'run', 'status') === 'failed'))
    })
  })
}

describe('the recorded releases', () => {
  test('the machine checks find a planted machine detail and pass the placeholders', () => {
    const caught = (text: string): string[] => MACHINE_DETAILS.filter(([pattern]) => pattern.test(text)).map(([, what]) => what)
    // Archon writes the machine name as `host`, in a run's execution owner and in stream frames.
    assert.deepEqual(caught('{ "host": "DESKTOP-4F2K9" }'), ['a machine name'])
    assert.deepEqual(caught('{ "hostname": "build-box" }'), ['a machine name'])
    assert.deepEqual(caught('"data": "{\\"host\\":\\"DESKTOP-4F2K9\\"}"'), ['a machine name inside a stream frame'])
    assert.deepEqual(caught('{ "storeId": "6c1f0b2e" }'), ['a store id'])
    // The placeholder, and the address server.json says the release listens on, are not machine names.
    assert.deepEqual(caught('{ "host": "<host>", "storeId": "<store-id>" }'), [])
    assert.deepEqual(caught('{ "host": "0.0.0.0" }'), [])
    assert.deepEqual(caught('"data": "{\\"host\\":\\"<host>\\"}"'), [])
    assert.deepEqual(caught('{ \\\\\\"host\\\\\\": \\\\\\"tracker.example\\\\\\" }'), [])
    assert.deepEqual(caught('{ \\\\\\"host\\\\\\": \\\\\\"DESKTOP-4F2K9\\\\\\" }'), ['a machine name inside a stream frame'])
  })

  test('are the folders of fixtures/ that are named as a release', () => {
    const folders = readdirSync(join(repoRoot, 'fixtures'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
    assert.deepEqual(folders.sort(), [...RELEASES].sort())
  })
})
