// Builder drafts in the worker (#61): the unsaved copy of each workflow a builder tab edits, kept
// in plugin storage so it survives the tab closing, another tab showing and Orca restarting. A
// draft is keyed by its workflow's identity (the name, the Archon project or none, and the scope)
// under the store id of the Archon it was made on, so each Archon has its own draft of a workflow;
// it holds the copy the edit started from and the file in words. Each draft is one storage key,
// so a write rewrites one draft and not all of them; the worker holds the drafts in memory and
// writes a changed one after a pause. At most
// `BUILDER_DRAFTS_CAP` drafts exist: at the cap a draft of another workflow is refused, with a
// sentence, until one is saved or discarded. Drafts are never removed by age. A stored draft is
// read through the same parsers as a tab's write; one that cannot be read at all is deleted, and
// the Workflows section says how many were. A readable one is never deleted but by a save or a
// discard: a second stored draft of a workflow and Archon already loaded is left in storage.
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { parseBuilderIdentity } from './builder'
import { parseBase, parseDefinition, parseDraftStore, STORE_ID_CAP } from './builder-save'
import type { Timers } from './client'
import type { ConnectionView } from './connection-view'
import { cappedTextRefusal, isCappedText, isRecord, own, refuseRequest } from './records'
import { nameInUse } from './workflows-section-view'
import {
  BUILDER_DRAFT_WRITE_PAUSE_MS,
  BUILDER_DRAFTS_CAP,
  DRAFT_FILE_CAP,
  type BuilderBase,
  sameIdentity,
  type BuilderDraftDiscard,
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

/** Whether a draft is this workflow's, made on this Archon. */
const sameDraft = (draft: BuilderDraft, identity: BuilderIdentity, storeId: string | null): boolean => sameIdentity(draft, identity) && draft.storeId === storeId

/** A tab's draft write, or a refusal. */
export function parseDraftWrite(input: unknown): BuilderDraftWrite {
  const identity = parseBuilderIdentity(input, 'A draft', ['definition', 'base', 'file', 'storeId'])
  const record = input as Record<string, unknown>
  const definition = parseDefinition(own(record, 'definition'), 'The draft')
  if (!Object.hasOwn(record, 'base')) refuseRequest('A draft takes the copy its edit started from, or null for none.')
  const base = parseBase(own(record, 'base'))
  const file = own(record, 'file')
  if (!isCappedText(file, DRAFT_FILE_CAP)) refuseRequest(cappedTextRefusal('The file words', DRAFT_FILE_CAP))
  return { ...identity, definition, base, file, ...parseDraftStore(record) }
}

/** What storage held under a draft's key, or null when it cannot be read as one. */
export function parseStoredDraft(value: unknown): BuilderDraft | null {
  try {
    if (!isRecord(value)) return null
    const { storeId, isNew, ...rest } = value
    if (storeId !== null && !isCappedText(storeId, STORE_ID_CAP)) return null
    if (typeof isNew !== 'boolean') return null
    return { ...parseDraftWrite(rest), storeId, isNew }
  } catch {
    return null
  }
}

/** A draft discard from a frame, or a refusal. */
export const parseDraftDiscard = (input: unknown): BuilderDraftDiscard => ({
  ...parseBuilderIdentity(input, 'A draft', ['storeId']),
  ...parseDraftStore(input as Record<string, unknown>)
})

export type BuilderDrafts = Disposable & {
  /**
   * The draft of this workflow a tab's read gives back, or null: the one made on the Archon
   * connected now (or last connected), else one made on another Archon, marked so.
   */
  view(identity: BuilderIdentity, connection: ConnectionView): Promise<BuilderDraftView | null>
  /**
   * Keeps a draft, as the tab sent it or a new workflow, under the store id it names, or else the
   * Archon connected now or last: refused at the cap, or when no Archon's store id is known.
   */
  keep(draft: BuilderDraftWrite, isNew?: boolean): Promise<BuilderDraftWriteAnswer>
  /** Removes, at once, the draft of this workflow made on the Archon it names, or else on the one connected now or last: it was saved or discarded. */
  remove(draft: BuilderDraftDiscard): Promise<void>
  /** Every draft kept, and how many stored drafts could not be read and were deleted. */
  list(): Promise<{ drafts: BuilderDraft[]; dropped: number }>
}

export type BuilderDraftsPorts = { timers: Timers; current(): Promise<ConnectionView> }

/** Keeps the builder drafts, and answers the tabs' `builder.draft.write` and `builder.draft.discard`. */
export function startBuilderDrafts(orca: OrcaWorkerApi, ports: BuilderDraftsPorts): BuilderDrafts {
  /** The drafts by slot: the number in their storage key. */
  const slots = new Map<number, BuilderDraft>()
  /** The slots of readable stored drafts left in storage because a draft of their workflow and Archon was loaded first: never reused. */
  const shadowed = new Set<number>()
  const pending = new Map<number, unknown>()
  let dropped = 0
  let held: Promise<void> | undefined
  /** The store id of the Archon last seen connected, or undefined before one. */
  let lastStore: string | null | undefined

  const slotOf = (identity: BuilderIdentity, storeId: string | null): number | undefined =>
    [...slots].find(([, draft]) => sameDraft(draft, identity, storeId))?.[0]

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
      if (draft === null) {
        dropped += 1
        orca.log(`Orchon could not read the builder draft kept under ${key}, so it was deleted.`)
        await orca.storage.delete(key).catch(() => {})
        continue
      }
      if (slotOf(draft, draft.storeId) !== undefined) {
        shadowed.add(slot)
        orca.log(`Orchon holds a second builder draft of ${draft.name} under ${key}; it is left in storage and not opened.`)
        continue
      }
      slots.set(slot, draft)
    }
  }
  const load = (): Promise<void> => (held ??= readAll())


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
    // A write that names its draft's Archon updates that draft; any other is the current Archon's.
    const named = write.storeId === undefined ? undefined : slotOf(write, write.storeId)
    let slot = named ?? (storeId === undefined ? undefined : slotOf(write, storeId))
    let draft: BuilderDraft
    // A new workflow is new once: a second of one identity, on any Archon, is refused.
    if (isNew && [...slots.values()].some((kept) => sameIdentity(kept, write))) return { kept: false, reason: nameInUse(name) }
    if (slot === undefined) {
      if (slots.size >= BUILDER_DRAFTS_CAP) return { kept: false, reason: DRAFTS_FULL }
      if (storeId === undefined) return { kept: false, reason: NO_STORE_KNOWN }
      slot = 1
      while (slots.has(slot) || shadowed.has(slot)) slot += 1
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

  async function remove(discard: BuilderDraftDiscard): Promise<void> {
    await load()
    const storeId = discard.storeId === undefined ? await storeNow() : discard.storeId
    const slot = storeId === undefined ? undefined : slotOf(discard, storeId)
    if (slot === undefined) return
    const handle = pending.get(slot)
    if (handle !== undefined) ports.timers.clear(handle)
    pending.delete(slot)
    slots.delete(slot)
    await orca.storage.delete(`${BUILDER_DRAFT_PREFIX}${String(slot)}`).catch((error: unknown) => orca.log(`Orchon could not delete a builder draft: ${String(error)}`))
  }

  const subscriptions = [
    orca.panels.handle('builder.draft.write', (input) => keep(parseDraftWrite(input))),
    orca.panels.handle('builder.draft.discard', async (input): Promise<null> => {
      await remove(parseDraftDiscard(input))
      return null
    })
  ]

  return {
    async view(identity, connection) {
      if (connection.kind === 'connected') lastStore = connection.storeId
      await load()
      const mine = lastStore === undefined ? undefined : slotOf(identity, lastStore)
      const draft = mine === undefined ? [...slots.values()].find((kept) => sameIdentity(kept, identity)) : slots.get(mine)
      if (draft === undefined) return null
      const otherArchon = connection.kind === 'connected' && connection.storeId !== draft.storeId
      return { definition: draft.definition, base: draft.base, file: draft.file, isNew: draft.isNew, otherArchon, storeId: draft.storeId }
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
