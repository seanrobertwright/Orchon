// Builder drafts in the worker (#61): the unsaved copy of each workflow a builder tab edits, kept
// in plugin storage so it survives the tab closing, another tab showing and Orca restarting. A
// draft is keyed by its workflow's identity (the name, the Archon project or none, and the scope),
// and holds the store id of the Archon it was made on, the copy the edit started from, and the
// file in words. Each draft is one storage key, so a write rewrites one draft and not all of
// them; the worker holds the drafts in memory and writes a changed one after a pause. At most
// `BUILDER_DRAFTS_CAP` drafts exist: at the cap a draft of another workflow is refused, with a
// sentence, until one is saved or discarded. Drafts are never removed by age. A stored draft is
// read through the same parsers as a tab's write; one that cannot be read at all is deleted, and
// the Workflows section says how many were.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { parseBuilderIdentity } from './builder'
import { parseBase, parseDefinition } from './builder-save'
import type { Timers } from './client'
import type { ConnectionView } from './connection-view'
import { cappedTextRefusal, isCappedText, isRecord, own, refuseRequest } from './records'
import { nameInUse } from './workflows-section-view'
import {
  BUILDER_DRAFT_WRITE_PAUSE_MS,
  BUILDER_DRAFTS_CAP,
  DRAFT_FILE_CAP,
  type BuilderBase,
  type BuilderDraftView,
  type BuilderDraftWrite,
  type BuilderDraftWriteAnswer,
  type BuilderIdentity
} from '../editors/builder/builder-view'

/** The plugin storage keys drafts are kept under: this, then the draft's slot number. */
export const BUILDER_DRAFT_PREFIX = 'builder-draft:'

export const DRAFTS_FULL = `Orchon keeps at most ${String(BUILDER_DRAFTS_CAP)} builder drafts, so this one is not kept. Save or discard another draft first.`
export const NO_STORE_KNOWN = 'Orchon has not reached Archon since it started, so it cannot tell which Archon this draft belongs to, and it is not kept.'

/** A draft as the worker keeps it. */
export type BuilderDraft = BuilderIdentity & {
  /** The store id of the Archon the draft was made on; null when that Archon reported none. */
  storeId: string | null
  /** A new workflow, never saved: Archon is not expected to hold it. */
  isNew: boolean
  definition: Record<string, unknown>
  /** The copy the edit started from, which a save's outside-change check compares with; null when Archon held none. */
  base: BuilderBase | null
  file: string
}

const sameIdentity = (first: BuilderIdentity, second: BuilderIdentity): boolean =>
  first.name === second.name && first.codebaseId === second.codebaseId && first.scope === second.scope

/** A tab's draft write, or a refusal. */
export function parseDraftWrite(input: unknown): BuilderDraftWrite {
  const identity = parseBuilderIdentity(input, 'A draft', ['definition', 'base', 'file'])
  const record = input as Record<string, unknown>
  const definition = parseDefinition(own(record, 'definition'), 'The draft')
  if (!Object.hasOwn(record, 'base')) refuseRequest('A draft takes the copy its edit started from, or null for none.')
  const base = parseBase(own(record, 'base'))
  const file = own(record, 'file')
  if (!isCappedText(file, DRAFT_FILE_CAP)) refuseRequest(cappedTextRefusal('The file words', DRAFT_FILE_CAP))
  return { ...identity, definition, base, file }
}

/** What storage held under a draft's key, or null when it cannot be read as one. */
export function parseStoredDraft(value: unknown): BuilderDraft | null {
  try {
    if (!isRecord(value)) return null
    const { storeId, isNew, ...rest } = value
    if (storeId !== null && !isCappedText(storeId, 200)) return null
    if (typeof isNew !== 'boolean') return null
    return { ...parseDraftWrite(rest), storeId, isNew }
  } catch {
    return null
  }
}

/** A draft's identity from a frame, or a refusal. */
export const parseDraftIdentity = (input: unknown): BuilderIdentity => parseBuilderIdentity(input, 'A draft')

export type BuilderDrafts = Disposable & {
  /** The draft of this workflow, if one is kept. */
  find(identity: BuilderIdentity): Promise<BuilderDraft | undefined>
  /** The draft of this workflow as a tab's read gives it back, or null; `connection` decides whether it was made on another Archon. */
  view(identity: BuilderIdentity, connection: ConnectionView): Promise<BuilderDraftView | null>
  /** Keeps a draft, as the tab sent it or a new workflow: refused at the cap, or when no Archon's store id is known. */
  keep(draft: BuilderDraftWrite, isNew?: boolean): Promise<BuilderDraftWriteAnswer>
  /** Removes the draft of this workflow, at once: it was saved or discarded. */
  remove(identity: BuilderIdentity): Promise<void>
  /** Every draft kept, and how many stored drafts could not be read and were deleted. */
  list(): Promise<{ drafts: BuilderDraft[]; dropped: number }>
}

export type BuilderDraftsPorts = { timers: Timers; current(): Promise<ConnectionView> }

/** Keeps the builder drafts, and answers the tabs' `builder.draft.write` and `builder.draft.discard`. */
export function startBuilderDrafts(orca: OrcaWorkerApi, ports: BuilderDraftsPorts): BuilderDrafts {
  /** The drafts by slot: the number in their storage key. */
  const slots = new Map<number, BuilderDraft>()
  const pending = new Map<number, unknown>()
  let dropped = 0
  let held: Promise<void> | undefined
  /** The store id of the Archon last seen connected, or undefined before one. */
  let lastStore: string | null | undefined

  async function readAll(): Promise<void> {
    let keys: string[]
    try {
      keys = await orca.storage.keys()
    } catch (error) {
      orca.log(`Orchon could not list its builder drafts: ${String(error)}`)
      return
    }
    for (const key of keys) {
      if (!key.startsWith(BUILDER_DRAFT_PREFIX)) continue
      const slot = Number(key.slice(BUILDER_DRAFT_PREFIX.length))
      const value = await orca.storage.get(key).catch(() => undefined)
      const draft = Number.isSafeInteger(slot) && slot > 0 ? parseStoredDraft(value) : null
      if (draft === null || [...slots.values()].some((kept) => sameIdentity(kept, draft))) {
        dropped += 1
        orca.log(`Orchon could not read the builder draft kept under ${key}, so it was deleted.`)
        await orca.storage.delete(key).catch(() => {})
        continue
      }
      slots.set(slot, draft)
    }
  }
  const load = (): Promise<void> => (held ??= readAll())

  const slotOf = (identity: BuilderIdentity): number | undefined => [...slots].find(([, draft]) => sameIdentity(draft, identity))?.[0]

  function flush(slot: number): void {
    const handle = pending.get(slot)
    if (handle === undefined) return
    ports.timers.clear(handle)
    pending.delete(slot)
    const draft = slots.get(slot)
    if (draft === undefined) return
    const { storeId, name, codebaseId, scope, isNew, definition, base, file } = draft
    orca.storage
      .set(`${BUILDER_DRAFT_PREFIX}${String(slot)}`, { storeId, name, codebaseId, scope, isNew, definition, base, file } as never)
      .catch((error: unknown) => orca.log(`Orchon could not save a builder draft: ${String(error)}`))
  }

  async function storeNow(): Promise<string | null | undefined> {
    const connection = await ports.current()
    if (connection.kind === 'connected') lastStore = connection.storeId
    return lastStore
  }

  async function keep(write: BuilderDraftWrite, isNew = false): Promise<BuilderDraftWriteAnswer> {
    await load()
    const storeId = await storeNow()
    const { name, codebaseId, scope, definition, base, file } = write
    // Nothing is awaited from here on, so no other write slips in between the lookup and the keep.
    let slot = slotOf(write)
    let draft: BuilderDraft
    // A new workflow is new once: a second of one identity is refused.
    if (isNew && slot !== undefined) return { kept: false, reason: nameInUse(name) }
    if (slot === undefined) {
      if (slots.size >= BUILDER_DRAFTS_CAP) return { kept: false, reason: DRAFTS_FULL }
      if (storeId === undefined) return { kept: false, reason: NO_STORE_KNOWN }
      slot = 1
      while (slots.has(slot)) slot += 1
      draft = { name, codebaseId, scope, storeId, isNew, definition, base, file }
    } else {
      // A draft keeps the store id and the newness it was made with.
      const kept = slots.get(slot) as BuilderDraft
      draft = { ...kept, definition, base, file }
    }
    slots.set(slot, draft)
    const handle = pending.get(slot)
    if (handle !== undefined) ports.timers.clear(handle)
    const mine = slot
    pending.set(slot, ports.timers.set(() => flush(mine), BUILDER_DRAFT_WRITE_PAUSE_MS))
    return { kept: true }
  }

  async function remove(identity: BuilderIdentity): Promise<void> {
    await load()
    const slot = slotOf(identity)
    if (slot === undefined) return
    const handle = pending.get(slot)
    if (handle !== undefined) ports.timers.clear(handle)
    pending.delete(slot)
    slots.delete(slot)
    await orca.storage.delete(`${BUILDER_DRAFT_PREFIX}${String(slot)}`).catch((error: unknown) => orca.log(`Orchon could not delete a builder draft: ${String(error)}`))
  }

  async function find(identity: BuilderIdentity): Promise<BuilderDraft | undefined> {
    await load()
    const slot = slotOf(identity)
    return slot === undefined ? undefined : slots.get(slot)
  }

  const subscriptions = [
    orca.panels.handle('builder.draft.write', (input) => keep(parseDraftWrite(input))),
    orca.panels.handle('builder.draft.discard', async (input): Promise<null> => {
      await remove(parseDraftIdentity(input))
      return null
    })
  ]

  return {
    find,
    async view(identity, connection) {
      if (connection.kind === 'connected') lastStore = connection.storeId
      const draft = await find(identity)
      if (draft === undefined) return null
      const otherArchon = connection.kind === 'connected' && connection.storeId !== draft.storeId
      return { definition: draft.definition, base: draft.base, file: draft.file, isNew: draft.isNew, otherArchon }
    },
    keep,
    remove,
    async list() {
      await load()
      return { drafts: [...slots.values()], dropped }
    },
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
      // What waits for the pause is written now, so a draft outlives the worker.
      for (const slot of [...pending.keys()]) flush(slot)
    }
  }
}
