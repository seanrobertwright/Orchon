// The builder's reads in the worker (#16, #28): one workflow as `GET /api/workflows/{name}`
// answers it, with the project's folder as `cwd`, checked here before anything reaches a frame.
// Open in builder reads it to learn the workflow's scope; a builder tab reads it to draw it.
import type { Client } from './client'
import { CODEBASES_PATH, parseCodebases } from './codebases'
import type { Connected } from './connection-view'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { cappedTextRefusal, isCappedText, isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { PROJECT_ID_CAP } from './scope-view'
import { WORKFLOWS_PATH } from './workflows-list'

/** The most characters of a workflow name the builder's requests take. */
export const WORKFLOW_NAME_CAP = 200

/** The largest definition the builder opens, in bytes of its JSON text (#16). */
export const DEFINITION_CAP_BYTES = 1024 * 1024

export const PROJECT_GONE = 'Archon no longer lists that project.'
export const goneText = (name: string): string => `Archon has no workflow named ${name} here.`

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
