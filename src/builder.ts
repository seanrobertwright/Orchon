// The builder's reads in the worker (#16, #28): one workflow as `GET /api/workflows/{name}`
// answers it, with the project's folder as `cwd`, checked here before anything reaches a frame.
// Open in builder reads it to learn the workflow's scope; a builder tab reads it to draw it, with
// which file it shows and whether Open YAML can open that file in Orca. The worker serves the tab
// from the moment it starts, so a tab Orca restores is answered before any panel opens. A read
// also gives back the workflow's builder draft, when one is kept, in every connection state.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { workflowFileIn, yamlTarget, type YamlTarget, type YamlWorkspace } from './builder-file'
import type { BuilderDrafts } from './builder-drafts'
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected, ConnectionView } from './connection-view'
import { LOCALE } from './run-graph'
import { tabConnection } from './tab-screen'
import {
  DEFINITION_CAP_BYTES,
  identityOf,
  mib,
  SCOPE_CAP,
  WORKFLOW_NAME_CAP,
  type BuilderAnswer,
  type BuilderHeader,
  type BuilderIdentity,
  type BuilderRequest,
  type BuilderView,
  type YamlOpenAnswer
} from '../editors/builder/builder-view'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, errorText, isCappedText, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { PROJECT_ID_CAP } from './scope-view'
import { WORKFLOWS_PATH } from './workflows-list'

export const PROJECT_GONE = 'Archon no longer lists that project.'
const goneText = (name: string): string => `Archon has no workflow named ${name} here.`
const shadowedText = (name: string, served: string, scope: string): string =>
  `Archon serves the ${served} workflow named ${name} here in place of the ${scope} one, so the builder cannot open the ${scope} one.`

/** A workflow name of 1 to the cap and a project id or null, with no other key, or a refusal. */
export function parseWorkflowIdentity(input: unknown, what: string, extra: readonly string[] = []): { name: string; codebaseId: string | null } {
  if (!isRecord(input)) refuseRequest(`${what} takes a workflow name and a project.`)
  refuseOtherKeys(input, ['name', 'codebaseId', ...extra], what)
  const name = own(input, 'name')
  if (!isCappedText(name, WORKFLOW_NAME_CAP)) refuseRequest(cappedTextRefusal('The workflow name', WORKFLOW_NAME_CAP))
  if (!Object.hasOwn(input, 'codebaseId')) refuseRequest(`${what} takes a project id, or null for none.`)
  const codebaseId = own(input, 'codebaseId')
  if (codebaseId !== null && !isCappedText(codebaseId, PROJECT_ID_CAP)) refuseRequest(cappedTextRefusal('The project id', PROJECT_ID_CAP))
  return { name, codebaseId }
}

/** One workflow as Archon answered it, with only the fields the builder reads. */
export type WorkflowFile = {
  /** Where Archon read it from: `project`, `global`, `bundled` or `installed` at the tested releases. */
  source: string
  /** The file's name under its workflows folder, such as `sub/plan.yaml`, or null when Archon gave none. */
  filename: string | null
  /** The definition as authored, before Archon's normalising, or null when Archon sent none. */
  authored: Record<string, unknown> | null
  /** The definition as Archon normalised it, or null. */
  workflow: Record<string, unknown> | null
}

export type WorkflowRead =
  | { kind: 'found'; file: WorkflowFile }
  | { kind: 'gone' }
  /** The answer passed the client's read cap, so it is far past the builder's. */
  | { kind: 'too-large' }
  | { kind: 'failed'; message: string }

/** `GET /api/workflows/{name}`'s answer, or null when it is not one. */
export function parseWorkflowFile(value: unknown): WorkflowFile | null {
  if (!isRecord(value)) return null
  const source = own(value, 'source')
  if (!isText(source)) return null
  const filename = own(value, 'filename')
  if (filename !== undefined && filename !== null && typeof filename !== 'string') return null
  const authored = own(value, 'authored')
  const workflow = own(value, 'workflow')
  if (authored !== undefined && authored !== null && !isRecord(authored)) return null
  if (workflow !== undefined && workflow !== null && !isRecord(workflow)) return null
  return {
    source,
    filename: isText(filename) ? filename : null,
    authored: isRecord(authored) ? authored : null,
    workflow: isRecord(workflow) ? workflow : null
  }
}

/** The folder Archon reads a project's workflows from, or why there is none. */
export async function projectFolder(
  client: Client,
  server: Connected,
  codebaseId: string,
  signal?: AbortSignal
): Promise<{ kind: 'found'; cwd: string } | { kind: 'gone' } | { kind: 'failed'; message: string }> {
  const listed = await client.request({ baseUrl: server.baseUrl, path: CODEBASES_PATH, timeout: 'read', ...(signal === undefined ? {} : { signal }) })
  if (!listed.ok) return { kind: 'failed', message: readFailureText(listed.failure) }
  const projects = parseCodebases(listed.value)
  if (projects === null) return { kind: 'failed', message: unreadableAnswerText(server.version) }
  const project = projects.projects.find((entry) => entry.id === codebaseId)
  return project === undefined ? { kind: 'gone' } : { kind: 'found', cwd: project.defaultCwd }
}

/** Reads one workflow, for a project's folder or with none. */
export async function readWorkflowFile(client: Client, server: Connected, name: string, cwd: string | null, signal?: AbortSignal): Promise<WorkflowRead> {
  const query = cwd === null ? '' : `?cwd=${encodeURIComponent(cwd)}`
  const answer = await client.request({
    baseUrl: server.baseUrl,
    path: `${WORKFLOWS_PATH}/${encodeURIComponent(name)}${query}`,
    timeout: 'read',
    ...(signal === undefined ? {} : { signal })
  })
  if (!answer.ok) {
    if (answer.failure.kind === 'status' && answer.failure.status === 404) return { kind: 'gone' }
    if (answer.failure.kind === 'too-large') return { kind: 'too-large' }
    return { kind: 'failed', message: readFailureText(answer.failure) }
  }
  const file = parseWorkflowFile(answer.value)
  return file === null ? { kind: 'failed', message: unreadableAnswerText(server.version) } : { kind: 'found', file }
}

export const NOT_IN_WORKSPACE = 'This workflow file is not inside a workspace on this computer that Orca lists.'
const TOO_LARGE_TO_READ = `This workflow's definition is over ${mib(DEFINITION_CAP_BYTES)}, so the builder cannot open it.`

/** A workflow Archon serves, with the project folder it was asked for, or the one sentence that says why there is none. */
export type ResolvedWorkflow = { kind: 'found'; file: WorkflowFile; cwd: string | null } | { kind: 'gone' | 'failed'; message: string }

/**
 * The workflow Archon serves by this name for the project, or none: the project or the workflow
 * is gone, the read failed or passed the client's cap, or, when `scope` is given, Archon serves
 * another scope's workflow of that name in its place (the one Archon reads first shadows it).
 */
export async function resolveWorkflow(
  client: Client,
  server: Connected,
  identity: { name: string; codebaseId: string | null; scope?: string },
  signal?: AbortSignal
): Promise<ResolvedWorkflow> {
  let cwd: string | null = null
  if (identity.codebaseId !== null) {
    const folder = await projectFolder(client, server, identity.codebaseId, signal)
    if (folder.kind === 'gone') return { kind: 'gone', message: PROJECT_GONE }
    if (folder.kind === 'failed') return folder
    cwd = folder.cwd
  }
  const read = await readWorkflowFile(client, server, identity.name, cwd, signal)
  if (read.kind === 'gone') return { kind: 'gone', message: goneText(identity.name) }
  if (read.kind === 'failed') return read
  if (read.kind === 'too-large') return { kind: 'failed', message: TOO_LARGE_TO_READ }
  const { source } = read.file
  if (identity.scope !== undefined && source !== identity.scope) return { kind: 'gone', message: shadowedText(identity.name, source, identity.scope) }
  return { kind: 'found', file: read.file, cwd }
}
export const NOT_CONNECTED = 'Orchon is not connected to Archon.'

/** A workflow identity: a name, a project id or null, and a scope, with the keys `extra` names too. */
export function parseBuilderIdentity(input: unknown, what: string, extra: readonly string[] = []): BuilderIdentity {
  const { name, codebaseId } = parseWorkflowIdentity(input, what, ['scope', ...extra])
  const scope = own(input as Record<string, unknown>, 'scope')
  if (!isCappedText(scope, SCOPE_CAP)) refuseRequest(cappedTextRefusal('The scope', SCOPE_CAP))
  return { name, codebaseId, scope }
}

/** The tab's request, or a refusal: the workflow's identity and a language tag, and nothing else. */
export function parseBuilderRequest(input: unknown): BuilderRequest {
  const identity = parseBuilderIdentity(input, 'The builder request', ['locale'])
  const locale = own(input as Record<string, unknown>, 'locale')
  if (typeof locale !== 'string' || !LOCALE.test(locale)) refuseRequest('The language must be a language tag such as en-US.')
  return { ...identity, locale }
}

/** Whether a definition is one the builder reads: a record whose `nodes` is a list of records. */
export function isDefinition(value: Record<string, unknown>): boolean {
  const nodes = own(value, 'nodes')
  return Array.isArray(nodes) && (nodes as unknown[]).every(isRecord)
}

/** Which file the builder shows, in words. */
function fileWords(file: WorkflowFile, name: string, path: string | null): string {
  const filename = file.filename ?? name
  switch (file.source) {
    case 'project':
      return path ?? `${filename} in the project's .archon/workflows folder`
    case 'global':
      return `workflows/${filename} in Archon's home folder`
    case 'bundled':
      return `${filename}, bundled with Archon`
    case 'installed':
      return `${filename}, installed`
    default:
      return `${filename}, from ${file.source}`
  }
}

const encoder = new TextEncoder()

export type BuilderPorts = {
  client: Client
  current(): Promise<ConnectionView>
  /** Every workspace Orca lists. */
  workspaces(): Promise<readonly YamlWorkspace[]>
  /** `process.platform` of the worker: the WSL share test runs on Windows only. */
  platform: string
  /** The drafts kept, so a tab's read gives its draft back with what Archon serves. */
  drafts?: Pick<BuilderDrafts, 'view'>
}

/** A workflow found, with its file's path when it is a project's, and where Open YAML opens it. */
type Found = { kind: 'found'; file: WorkflowFile; path: string | null; target: YamlTarget | null }
type NotFound = Extract<BuilderView, { kind: 'gone' | 'failed' }>

/** Answers the builder tabs' `builder.read` and `builder.openYaml`. */
export function startBuilder(orca: OrcaWorkerApi, ports: BuilderPorts): Disposable {
  /** The workflow and where its file is, or why there is none. */
  async function find(server: Connected, identity: BuilderIdentity, signal?: AbortSignal): Promise<Found | NotFound> {
    const resolved = await resolveWorkflow(ports.client, server, identity, signal)
    if (resolved.kind !== 'found') return resolved
    const { file, cwd } = resolved
    const path = file.source === 'project' && cwd !== null && file.filename !== null ? workflowFileIn(cwd, file.filename) : null
    const target = path === null ? null : yamlTarget(path, await ports.workspaces(), ports.platform)
    return { kind: 'found', file, path, target }
  }

  async function read(server: Connected, request: BuilderRequest, signal: AbortSignal): Promise<BuilderView> {
    const found = await find(server, request, signal)
    if (found.kind !== 'found') return found
    const { file, path, target } = found
    const viewOnly = file.source === 'installed'
    const header: BuilderHeader = { name: request.name, source: file.source, file: fileWords(file, request.name, path), viewOnly, openYaml: target !== null }
    // Archon sends an installed workflow only as normalised; it is shown as that, view-only.
    const definition = file.authored ?? (viewOnly ? file.workflow : null)
    if (definition === null) return { kind: 'failed', message: 'Archon did not send this workflow as it is written, so the builder cannot show it.' }
    const bytes = encoder.encode(JSON.stringify(definition)).length
    if (bytes > DEFINITION_CAP_BYTES) return { kind: 'too-large', header, bytes, cap: DEFINITION_CAP_BYTES }
    if (!isDefinition(definition)) return { kind: 'failed', message: unreadableAnswerText(server.version) }
    return { kind: 'ready', header, definition }
  }

  async function openYaml(identity: BuilderIdentity): Promise<YamlOpenAnswer> {
    const connection = await ports.current()
    if (connection.kind !== 'connected') return { opened: false, reason: NOT_CONNECTED }
    const found = await find(connection, identity)
    if (found.kind !== 'found') return { opened: false, reason: found.message }
    if (found.target === null) return { opened: false, reason: NOT_IN_WORKSPACE }
    try {
      await orca.host.call('editor.open', found.target)
    } catch (error) {
      return { opened: false, reason: `Orca could not open the file: ${errorText(error)}` }
    }
    return { opened: true }
  }

  const subscriptions = [
    orca.panels.handle('builder.read', async (input, context): Promise<BuilderAnswer> => {
      const request = parseBuilderRequest(input)
      const identity = identityOf(request)
      const connection = await ports.current()
      const draftFor = async (now: ConnectionView) => (ports.drafts === undefined ? {} : { draft: await ports.drafts.view(identity, now) })
      if (connection.kind !== 'connected') return { connection: tabConnection(connection, request.locale), builder: { kind: 'not-connected' }, ...(await draftFor(connection)) }
      const builder = await read(connection, request, context.signal)
      const after = await ports.current()
      return { connection: tabConnection(after, request.locale), builder, ...(await draftFor(after)) }
    }),
    orca.panels.handle('builder.openYaml', (input) => openYaml(parseBuilderIdentity(input, 'Open YAML')))
  ]
  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
