// The builder's Save and Validate in the worker (#16, #28). The tab runs the local blocking rules
// and sends the definition; the worker does the rest, in order: it reads the workflow again and
// compares its authored form with the copy the tab opened (the outside-change check), has Archon
// validate the definition, and writes it with one `PUT /api/workflows/{name}`. That PUT is the
// only write: the worker never writes a workflow file itself. Each body holds only `definition`,
// a key that exists at the floor (Archon 0.12.1), and the definition reaches Archon as the tab
// sent it, so content the builder does not understand is written back unchanged. A save that
// times out is never sent again: the worker reads the workflow to learn whether it landed. One
// save runs at a time. Between the re-read and the PUT lie a few milliseconds in which an outside
// change is not seen; that is an accepted limit, stated in the README.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { BuilderDrafts } from './builder-drafts'
import { isDefinition, NOT_CONNECTED, parseBuilderIdentity, PROJECT_GONE, projectFolder, readWorkflowFile } from './builder'
import type { Client, ClientFailure } from './client'
import type { Connected, ConnectionView } from './connection-view'
import { cutAt } from './cutter'
import { readFailureText, unreadableAnswerText } from './read-failure'
import { isRecord, isText, own, refuseOtherKeys, refuseRequest } from './records'
import { LOCALE } from './run-graph'
import { SERVER_TEXT_CAP } from './run-control-view'
import { tabConnection } from './tab-screen'
import { WORKFLOWS_PATH } from './workflows-list'
import {
  DEFINITION_CAP_BYTES,
  mib,
  SCOPE_CAP,
  VALIDATION_ERRORS_CAP,
  type BuilderBase,
  type BuilderSaveAnswer,
  type BuilderSaveOutcome,
  type BuilderSaveRequest,
  type BuilderValidateAnswer,
  type BuilderValidateOutcome,
  type BuilderValidateRequest,
  type ValidationErrors
} from '../editors/builder/builder-view'
import { sameDefinition } from '../editors/builder/same-definition'
import type { TabConnection } from '../editors/run-graph/graph-view'

export const VALIDATE_PATH = `${WORKFLOWS_PATH}/validate`

export const SAVE_IN_FLIGHT = 'Another save is still waiting for Archon.'
export const VIEW_ONLY = 'This workflow is installed, so it can only be viewed here.'
export const BUNDLED_NEEDS_PROJECT =
  "A bundled workflow saves as a project's own copy, so it needs a project. Choose a project in the Workflows section and open the workflow from there."
export const PROJECT_NEEDS_PROJECT = "A project's workflow saves into its project, so it needs one. Open it from the Workflows section with its project chosen."
export const CHANGED_OUTSIDE = 'This workflow changed outside the builder since you opened it, so nothing was written.'
export const REMOVED_OUTSIDE = 'Archon no longer serves this workflow here: it was removed or replaced outside the builder, so nothing was written.'
export const NOT_VALIDATED = 'Archon did not say whether the definition is valid, so nothing was written.'
export const LANDED = 'The save was not answered in time and was not sent again. Archon holds the workflow as you saved it.'
export const NOT_LANDED = 'The save was not answered in time and was not sent again. Archon does not hold your changes; they are still here.'
export const LANDED_UNKNOWN = 'The save was not answered in time and was not sent again. Orchon could not read the workflow to learn whether it was saved.'
const tooLarge = (what: string): string => `${what} is over ${mib(DEFINITION_CAP_BYTES)}, the most the builder sends.`

const encoder = new TextEncoder()
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

/** A definition from the tab: a record with a list of node records, within the open limit, or a refusal. */
export function parseDefinition(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value) || !isDefinition(value)) refuseRequest(`${what} must be a workflow definition: a record with a list of nodes.`)
  if (bytesOf(value) > DEFINITION_CAP_BYTES) refuseRequest(tooLarge(what))
  return value
}

const parseLocale = (input: Record<string, unknown>): string => {
  const locale = own(input, 'locale')
  if (typeof locale !== 'string' || !LOCALE.test(locale)) refuseRequest('The language must be a language tag such as en-US.')
  return locale
}

/** The tab's Save, or a refusal: the identity, the definition, the copy expected, a language, and nothing else. */
export function parseSaveRequest(input: unknown): BuilderSaveRequest {
  const identity = parseBuilderIdentity(input, 'Save', ['definition', 'base', 'locale'])
  const record = input as Record<string, unknown>
  const definition = parseDefinition(own(record, 'definition'), 'The definition')
  if (!Object.hasOwn(record, 'base')) refuseRequest('Save takes the copy Archon is expected to serve, or null for none.')
  return { ...identity, definition, base: parseBase(own(record, 'base')), locale: parseLocale(record) }
}

/** A copy Archon is expected to serve: null for none, or a source and an authored definition within the open limit, or a refusal. */
export function parseBase(rawBase: unknown): BuilderBase | null {
  if (rawBase === null) return null
  if (!isRecord(rawBase)) refuseRequest('The expected copy must be a source and an authored definition.')
  refuseOtherKeys(rawBase, ['source', 'authored'], 'The expected copy')
  const source = own(rawBase, 'source')
  if (!isText(source) || source.length > SCOPE_CAP) refuseRequest(`The expected source must be text of 1 to ${String(SCOPE_CAP)} characters.`)
  return { source, authored: parseDefinition(own(rawBase, 'authored'), 'The expected copy') }
}

/** The tab's Validate, or a refusal: a definition and a language, and nothing else. */
export function parseValidateRequest(input: unknown): BuilderValidateRequest {
  if (!isRecord(input)) refuseRequest('Validate takes a definition and a language.')
  refuseOtherKeys(input, ['definition', 'locale'], 'Validate')
  return { definition: parseDefinition(own(input, 'definition'), 'The definition'), locale: parseLocale(input) }
}

/** Archon's own sentence on a refused call, with its detail, cut to fit; or the failure in words. */
function failureText(failure: ClientFailure): string {
  if (failure.kind === 'status' && isRecord(failure.body)) {
    const error = own(failure.body, 'error')
    const detail = own(failure.body, 'detail')
    if (isText(error)) return cutAt(isText(detail) ? `${error}: ${detail}` : error, SERVER_TEXT_CAP)
  }
  return readFailureText(failure)
}

/** Archon's validation sentences, each cut to fit, at most the cap of them. */
function errorsOf(value: unknown[]): ValidationErrors {
  const sentences = value.filter(isText).map((sentence) => cutAt(sentence, SERVER_TEXT_CAP))
  return { errors: sentences.slice(0, VALIDATION_ERRORS_CAP), more: Math.max(0, sentences.length - VALIDATION_ERRORS_CAP) }
}

/** `POST /api/workflows/validate` on a definition, with only `definition` in the body. */
async function validateIn(client: Client, server: Connected, definition: Record<string, unknown>): Promise<BuilderValidateOutcome> {
  const answer = await client.request({ baseUrl: server.baseUrl, path: VALIDATE_PATH, method: 'POST', body: { definition }, timeout: 'read', errorBody: true })
  if (!answer.ok) return { kind: 'failed', message: failureText(answer.failure) }
  const valid = isRecord(answer.value) ? own(answer.value, 'valid') : undefined
  if (valid === true) return { kind: 'valid' }
  if (valid !== false) return { kind: 'failed', message: unreadableAnswerText(server.version) }
  const errors = own(answer.value as Record<string, unknown>, 'errors')
  return { kind: 'invalid', ...errorsOf(Array.isArray(errors) ? (errors as unknown[]) : []) }
}

/** What Archon serves by this name now, as a base a save compares with: none, a copy, or why it could not be read. */
async function servedNow(client: Client, server: Connected, name: string, cwd: string | null): Promise<{ kind: 'served'; base: BuilderBase | null } | { kind: 'failed'; message: string }> {
  const read = await readWorkflowFile(client, server, name, cwd)
  if (read.kind === 'gone') return { kind: 'served', base: null }
  if (read.kind === 'too-large') return { kind: 'failed', message: tooLarge('The workflow Archon serves now') }
  if (read.kind === 'failed') return read
  const { source, authored } = read.file
  if (authored === null || !isDefinition(authored)) return { kind: 'failed', message: unreadableAnswerText(server.version) }
  if (bytesOf(authored) > DEFINITION_CAP_BYTES) return { kind: 'failed', message: tooLarge('The workflow Archon serves now') }
  return { kind: 'served', base: { source, authored } }
}

const sameBase = (first: BuilderBase | null, second: BuilderBase | null): boolean =>
  first === null || second === null ? first === second : first.source === second.source && sameDefinition(first.authored, second.authored)

async function saveIn(client: Client, server: Connected, request: BuilderSaveRequest): Promise<BuilderSaveOutcome> {
  const { name, codebaseId, scope, definition } = request
  if (scope === 'installed') return { kind: 'refused', message: VIEW_ONLY }
  if (codebaseId === null && scope === 'bundled') return { kind: 'refused', message: BUNDLED_NEEDS_PROJECT }
  if (codebaseId === null && scope !== 'global') return { kind: 'refused', message: PROJECT_NEEDS_PROJECT }
  let cwd: string | null = null
  if (codebaseId !== null) {
    const folder = await projectFolder(client, server, codebaseId)
    if (folder.kind === 'gone') return { kind: 'refused', message: PROJECT_GONE }
    if (folder.kind === 'failed') return folder
    cwd = folder.cwd
  }
  // 1. The outside-change check: what Archon serves now against the copy the tab opened.
  const before = await servedNow(client, server, name, cwd)
  if (before.kind === 'failed') return before
  if (!sameBase(before.base, request.base)) return { kind: 'changed', message: before.base === null ? REMOVED_OUTSIDE : CHANGED_OUTSIDE, current: before.base }
  // 2. Archon's validation, which is final.
  const validation = await validateIn(client, server, definition)
  if (validation.kind === 'invalid') return validation
  if (validation.kind !== 'valid') return { kind: 'failed', message: validation.kind === 'failed' ? `${validation.message} ${NOT_VALIDATED}` : validation.message }
  // 3. The one write. A global workflow goes to Archon's home folder; any other, a bundled one
  // as the project's own copy, to its project's folder, always named by `cwd`.
  const source = scope === 'global' ? 'global' : 'project'
  const query = source === 'global' ? 'source=global' : `source=project&cwd=${encodeURIComponent(cwd ?? '')}`
  const written = await client.request({
    baseUrl: server.baseUrl,
    path: `${WORKFLOWS_PATH}/${encodeURIComponent(name)}?${query}`,
    method: 'PUT',
    body: { definition },
    timeout: 'write',
    errorBody: true
  })
  if (written.ok) return { kind: 'saved', source }
  if (written.failure.kind !== 'timeout') return { kind: 'failed', message: failureText(written.failure) }
  // Never sent again: the write may have landed. Reading the workflow tells.
  const after = await servedNow(client, server, name, cwd)
  if (after.kind === 'failed') return { kind: 'timeout', landed: null, message: LANDED_UNKNOWN, source: null }
  const landed = after.base !== null && sameDefinition(after.base.authored, definition)
  return { kind: 'timeout', landed, message: landed ? LANDED : NOT_LANDED, source: landed ? (after.base?.source ?? null) : null }
}

export type BuilderSavePorts = {
  client: Client
  current(): Promise<ConnectionView>
  /** The drafts kept: a save Archon holds deletes its workflow's draft, and a draft made on another Archon is never saved. */
  drafts?: Pick<BuilderDrafts, 'find' | 'remove'>
}

export const OTHER_ARCHON = 'This draft was made on a different Archon.'
export const DRAFT_NOT_SAVED = `${OTHER_ARCHON} It is not saved here, and it is kept.`

/**
 * Answers a write request with the connection read fresh afterwards: `run`'s outcome while
 * Connected, else a refusal that says Orchon is not connected.
 */
async function whenConnected<O>(
  ports: BuilderSavePorts,
  locale: string,
  run: (connection: Connected) => Promise<O | { kind: 'refused'; message: string }>
): Promise<{ connection: TabConnection; outcome: O | { kind: 'refused'; message: string } }> {
  const connection = await ports.current()
  if (connection.kind !== 'connected') return { connection: tabConnection(connection, locale), outcome: { kind: 'refused', message: NOT_CONNECTED } }
  const outcome = await run(connection)
  return { connection: tabConnection(await ports.current(), locale), outcome }
}

/** Answers the builder tabs' `builder.save` and `builder.validate`. */
export function startBuilderSave(orca: OrcaWorkerApi, ports: BuilderSavePorts): Disposable {
  let saving = false
  const subscriptions = [
    orca.panels.handle('builder.save', async (input): Promise<BuilderSaveAnswer> => {
      const request = parseSaveRequest(input)
      const { connection, outcome } = await whenConnected<BuilderSaveOutcome>(ports, request.locale, async (server) => {
        if (saving) return { kind: 'refused', message: SAVE_IN_FLIGHT }
        saving = true
        try {
          const identity = { name: request.name, codebaseId: request.codebaseId, scope: request.scope }
          const draft = await ports.drafts?.find(identity)
          if (draft !== undefined && draft.storeId !== server.storeId) return { kind: 'refused', message: DRAFT_NOT_SAVED }
          const outcome = await saveIn(ports.client, server, request)
          // Archon holds the copy now, so its draft goes.
          if (outcome.kind === 'saved' || (outcome.kind === 'timeout' && outcome.landed === true)) await ports.drafts?.remove(identity)
          return outcome
        } finally {
          saving = false
        }
      })
      return { connection, save: outcome }
    }),
    orca.panels.handle('builder.validate', async (input): Promise<BuilderValidateAnswer> => {
      const request = parseValidateRequest(input)
      const { connection, outcome } = await whenConnected<BuilderValidateOutcome>(ports, request.locale, (server) => validateIn(ports.client, server, request.definition))
      return { connection, validate: outcome }
    })
  ]
  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }
}
