// A step's activity: Archon's provider events for one step, parsed at the boundary and folded into
// items as #17's table sets. Agent text that follows agent text in one attempt is one item, and
// thinking the same; a tool call and its update are one item per `toolCallId`; a subtask is one
// item per `taskId` with its latest status; a warning is one item; a hook is listed only when its
// latest status is `failed`. Every other hook event, `state_update` and any type this version does
// not know are counted and not listed, and an event that cannot be read is dropped and counted.
// The fold is built once per event and kept by the worker; a page is cut from it on request. It is
// pure logic: no host and no network.
import { BLOCK_LIMIT, cutAt, oneLine } from './cutter'
import { parseInstant } from './dates'
import { isRecord, isText, own } from './records'
import {
  ACTIVITY_PAGE,
  ACTIVITY_PAGES_CAP,
  ITEM_LINE_CAP,
  type ActivityRow,
  type ActivityView,
  type AttemptRows,
  type CutText,
  type ItemView
} from './step-view'

/** One provider event as the worker reads it: where it sits, when, and its own fields. */
export type ProviderEvent = {
  /** Null for an event recorded before Archon stamped attempts. */
  attemptId: string | null
  seq: number
  at: number | null
  event: Record<string, unknown> & { type: string }
}

const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

/** One record of the route's `events`, or null when it cannot be read. */
function parseRecord(value: unknown): ProviderEvent | null {
  if (!isRecord(value)) return null
  const attemptId = own(value, 'attemptId')
  const seq = own(value, 'seq')
  const event = own(value, 'event')
  if (!(attemptId === null || attemptId === undefined || isText(attemptId)) || !isSeq(seq)) return null
  if (!isRecord(event) || !isText(own(event, 'type'))) return null
  if (!eventFieldsRead(event)) return null
  return { attemptId: attemptId ?? null, seq, at: parseInstant(own(value, 'observedAt')), event: event as ProviderEvent['event'] }
}

const optional = (event: Record<string, unknown>, key: string, test: (value: unknown) => boolean): boolean => {
  const value = own(event, key)
  return value === undefined || test(value)
}
const isString = (value: unknown): boolean => typeof value === 'string'

/** Whether a listed type's fields are the types Archon's contract gives them. Other types pass. */
function eventFieldsRead(event: Record<string, unknown>): boolean {
  switch (own(event, 'type')) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return isText(own(event, 'text'))
    case 'tool_call':
      return isText(own(event, 'toolCallId')) && isString(own(event, 'name')) && optional(event, 'title', isString)
    case 'tool_call_update':
      return (
        isText(own(event, 'toolCallId')) &&
        ['completed', 'failed', 'cancelled'].includes(own(event, 'status') as string) &&
        optional(event, 'output', isString) &&
        optional(event, 'outputTruncated', (value) => value === true) &&
        optional(event, 'exitCode', isWhole)
      )
    case 'subtask':
      return (
        isText(own(event, 'taskId')) &&
        ['started', 'running', 'completed', 'failed', 'stopped'].includes(own(event, 'status') as string) &&
        optional(event, 'description', isString) &&
        optional(event, 'summary', isString)
      )
    case 'warning':
      return isString(own(event, 'message')) && optional(event, 'code', isString)
    case 'hook':
      return (
        isText(own(event, 'hookId')) &&
        isString(own(event, 'hookName')) &&
        ['started', 'succeeded', 'failed', 'cancelled'].includes(own(event, 'status') as string) &&
        optional(event, 'hookEvent', isString) &&
        optional(event, 'exitCode', isWhole)
      )
    default:
      return true
  }
}

/** The route's answer: its readable events in Archon's order, and how many could not be read. Null when it is not the route's shape. */
export function parseProviderEvents(value: unknown): { events: ProviderEvent[]; unreadable: number } | null {
  if (!isRecord(value)) return null
  const list = own(value, 'events')
  if (!Array.isArray(list)) return null
  const events: ProviderEvent[] = []
  let unreadable = 0
  for (const entry of list as unknown[]) {
    const event = parseRecord(entry)
    if (event === null) unreadable += 1
    else events.push(event)
  }
  return { events, unreadable }
}

/** A text kept at most 16 KiB long. */
function keep(text: string): CutText {
  return text.length > BLOCK_LIMIT ? { text: cutAt(text, BLOCK_LIMIT), cut: true } : { text, cut: false }
}

/** Appends to a kept text, stopping at 16 KiB. */
function append(held: CutText, more: string): CutText {
  if (held.cut) return held
  return keep(held.text + more)
}

type ToolState = 'running' | 'completed' | 'failed' | 'cancelled'

/** One folded item, with what its preview shows, each text kept at most 16 KiB. */
type Item =
  | { kind: 'text' | 'thinking'; key: string; at: number | null; text: CutText }
  | {
      kind: 'tool'
      key: string
      at: number | null
      name: string
      title: string | null
      state: ToolState
      input: CutText | null
      output: CutText | null
      outputTruncated: boolean
      exitCode: number | null
    }
  | { kind: 'subtask'; key: string; at: number | null; status: string; description: string | null; summary: CutText | null }
  | { kind: 'warning'; key: string; at: number | null; code: string | null; text: CutText }
  | { kind: 'hook'; key: string; at: number | null; name: string; event: string | null; status: string; exitCode: number | null; events: number }

type Attempt = {
  key: string
  number: number
  items: Item[]
  /** The highest seq held, for the cursor and to drop an event read twice. */
  lastSeq: number
  /** The item the last listed-kind event went to: text joins it when it is text of the same kind. */
  last: Item | null
  byTool: Map<string, Extract<Item, { kind: 'tool' }>>
  byTask: Map<string, Extract<Item, { kind: 'subtask' }>>
  byHook: Map<string, Extract<Item, { kind: 'hook' }>>
}

/** The input of a tool call as text: a string as it is, anything else as indented JSON. */
function inputText(value: unknown): CutText | null {
  if (value === undefined) return null
  if (typeof value === 'string') return keep(value)
  try {
    return keep(JSON.stringify(value, null, 2) ?? '')
  } catch {
    return null
  }
}

const TOOL_WORD: Record<ToolState, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }
const SUBTASK_WORD: Record<string, string> = { started: 'Started', running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' }

/** The first line of a text, on one line and cut for a row. */
const firstLine = (text: string): string => cutAt(oneLine(text.split('\n').find((line) => line.trim() !== '') ?? ''), ITEM_LINE_CAP)

/** One item's row. */
function rowOf(item: Item): ActivityRow {
  const row = (label: string, detail: string): ActivityRow => ({ key: item.key, kind: item.kind, label: cutAt(oneLine(label), ITEM_LINE_CAP), detail, at: item.at })
  switch (item.kind) {
    case 'text':
      return row(firstLine(item.text.text), 'Agent text')
    case 'thinking':
      return row(firstLine(item.text.text), 'Thinking')
    case 'tool':
      return row(item.title === null || item.title === '' ? item.name : item.title, TOOL_WORD[item.state])
    case 'subtask': {
      const summary = item.summary === null ? '' : firstLine(item.summary.text)
      return row(item.description ?? 'Subtask', [`Subtask ${(SUBTASK_WORD[item.status] ?? item.status).toLowerCase()}`, summary].filter((part) => part !== '').join(' · '))
    }
    case 'warning':
      return row(firstLine(item.text.text), 'Warning')
    case 'hook':
      return row(`Hook ${item.name}`, item.exitCode === null ? 'Failed' : `Failed with exit code ${String(item.exitCode)}`)
  }
}

/** Whether an item is listed: every kind but a hook whose latest status is not `failed`. */
const listed = (item: Item): boolean => item.kind !== 'hook' || item.status === 'failed'

/** A step's folded activity, which grows as events arrive. */
export type Fold = {
  /** Folds more events, in Archon's order, and says how many were new. An event already held is dropped. */
  add(events: readonly ProviderEvent[], unreadable: number): number
  /** The cursor after the last event held, or null when none is held. */
  cursor(): { attemptId: string; seq: number } | null
  /** The newest `pages` pages, newest first, grouped by attempt. */
  page(pages: number, live: boolean): Extract<ActivityView, { kind: 'ready' }>
  /** One item's preview, or null when no item has the key. */
  item(key: string): ItemView | null
}

export function createFold(): Fold {
  const attempts: Attempt[] = []
  const byId = new Map<string | null, Attempt>()
  const byKey = new Map<string, Item>()
  /** Events of kinds not listed, hook events apart. */
  let hiddenOther = 0
  let unreadable = 0
  let lastCursor: { attemptId: string; seq: number } | null = null

  function attemptOf(id: string | null): Attempt {
    let attempt = byId.get(id)
    if (attempt === undefined) {
      attempt = { key: `attempt:${id ?? 'none'}`, number: attempts.length + 1, items: [], lastSeq: -1, last: null, byTool: new Map(), byTask: new Map(), byHook: new Map() }
      attempts.push(attempt)
      byId.set(id, attempt)
    }
    return attempt
  }

  function push(attempt: Attempt, item: Item): void {
    attempt.items.push(item)
    byKey.set(item.key, item)
  }

  /** Folds one event, or returns false when it is held already. */
  function fold(record: ProviderEvent): boolean {
    const attempt = attemptOf(record.attemptId)
    if (record.seq <= attempt.lastSeq) return false
    attempt.lastSeq = record.seq
    if (record.attemptId !== null) lastCursor = { attemptId: record.attemptId, seq: record.seq }
    foldNew(attempt, record)
    return true
  }

  function foldNew(attempt: Attempt, record: ProviderEvent): void {
    const { event } = record
    const prefix = `${record.attemptId ?? 'none'}:`
    const text = (key: string): string => own(event, key) as string
    const maybe = (key: string): string | null => {
      const value = own(event, key)
      return typeof value === 'string' ? value : null
    }
    switch (event.type) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const kind = event.type === 'agent_message_chunk' ? 'text' : 'thinking'
        const last = attempt.last
        if (last !== null && last.kind === kind) {
          last.text = append(last.text, own(event, 'continuesPreviousBlock') === true ? text('text') : `\n\n${text('text')}`)
          return
        }
        const item: Item = { kind, key: `${prefix}${kind}:${String(record.seq)}`, at: record.at, text: keep(text('text')) }
        push(attempt, item)
        attempt.last = item
        return
      }
      case 'tool_call': {
        const id = text('toolCallId')
        const held = attempt.byTool.get(id)
        if (held !== undefined) {
          held.name = text('name')
          held.title = maybe('title')
          held.input = inputText(own(event, 'rawInput')) ?? held.input
          attempt.last = held
          return
        }
        const item: Extract<Item, { kind: 'tool' }> = {
          kind: 'tool',
          key: `${prefix}tool:${id}`,
          at: record.at,
          name: text('name'),
          title: maybe('title'),
          state: 'running',
          input: inputText(own(event, 'rawInput')),
          output: null,
          outputTruncated: false,
          exitCode: null
        }
        attempt.byTool.set(id, item)
        push(attempt, item)
        attempt.last = item
        return
      }
      case 'tool_call_update': {
        const id = text('toolCallId')
        let item = attempt.byTool.get(id)
        if (item === undefined) {
          // An update whose call was not read: the item still shows, under no name.
          item = { kind: 'tool', key: `${prefix}tool:${id}`, at: record.at, name: 'Tool call', title: null, state: 'running', input: null, output: null, outputTruncated: false, exitCode: null }
          attempt.byTool.set(id, item)
          push(attempt, item)
        }
        item.state = own(event, 'status') as ToolState
        const output = maybe('output')
        if (output !== null) item.output = keep(output)
        item.outputTruncated = own(event, 'outputTruncated') === true
        const exitCode = own(event, 'exitCode')
        if (isWhole(exitCode)) item.exitCode = exitCode
        attempt.last = item
        return
      }
      case 'subtask': {
        const id = text('taskId')
        let item = attempt.byTask.get(id)
        if (item === undefined) {
          item = { kind: 'subtask', key: `${prefix}subtask:${id}`, at: record.at, status: text('status'), description: null, summary: null }
          attempt.byTask.set(id, item)
          push(attempt, item)
        }
        item.status = text('status')
        const description = maybe('description')
        if (description !== null) item.description = description
        const summary = maybe('summary')
        if (summary !== null) item.summary = keep(summary)
        attempt.last = item
        return
      }
      case 'warning': {
        const item: Item = { kind: 'warning', key: `${prefix}warning:${String(record.seq)}`, at: record.at, code: maybe('code'), text: keep(text('message')) }
        push(attempt, item)
        attempt.last = item
        return
      }
      case 'hook': {
        const id = text('hookId')
        let item = attempt.byHook.get(id)
        if (item === undefined) {
          item = { kind: 'hook', key: `${prefix}hook:${id}`, at: record.at, name: text('hookName'), event: null, status: text('status'), exitCode: null, events: 0 }
          attempt.byHook.set(id, item)
          push(attempt, item)
        }
        item.events += 1
        item.status = text('status')
        item.name = text('hookName')
        const hookEvent = maybe('hookEvent')
        if (hookEvent !== null) item.event = hookEvent
        const exitCode = own(event, 'exitCode')
        if (isWhole(exitCode)) item.exitCode = exitCode
        return
      }
      default:
        hiddenOther += 1
    }
  }

  return {
    add(events, bad) {
      unreadable += bad
      let added = bad
      for (const event of events) if (fold(event)) added += 1
      return added
    },
    cursor: () => lastCursor,
    page(pages, live) {
      const shownPages = Math.min(Math.max(1, pages), ACTIVITY_PAGES_CAP)
      // Newest first: the newest attempt's newest item first.
      const newest: { attempt: Attempt; item: Item }[] = []
      let hidden = hiddenOther
      for (const attempt of attempts) {
        for (const item of attempt.items) {
          if (listed(item)) newest.push({ attempt, item })
          else if (item.kind === 'hook') hidden += item.events
        }
      }
      newest.reverse()
      const total = newest.length
      const loaded = Math.min(total, shownPages * ACTIVITY_PAGE)
      const reachable = Math.min(total, ACTIVITY_PAGES_CAP * ACTIVITY_PAGE)
      const groups: AttemptRows[] = []
      for (const { attempt, item } of newest.slice(0, loaded)) {
        const group = groups.at(-1)
        if (group?.key === attempt.key) group.rows.push(rowOf(item))
        else groups.push({ key: attempt.key, number: attempt.number, rows: [rowOf(item)] })
      }
      return { kind: 'ready', attempts: groups, loaded, total, earlier: reachable - loaded, pastCap: total - reachable, hidden, unreadable, live }
    },
    item(key) {
      const item = byKey.get(key)
      if (item === undefined || !listed(item)) return null
      switch (item.kind) {
        case 'text':
        case 'thinking':
          return { kind: item.kind, text: item.text }
        case 'tool':
          return {
            kind: 'tool',
            name: item.name,
            title: item.title,
            state: item.state,
            input: item.input,
            output: item.output,
            outputTruncated: item.outputTruncated,
            exitCode: item.exitCode
          }
        case 'subtask':
          return { kind: 'subtask', status: item.status, description: item.description, summary: item.summary }
        case 'warning':
          return { kind: 'warning', code: item.code, text: item.text }
        case 'hook':
          return { kind: 'hook', name: item.name, event: item.event, exitCode: item.exitCode }
      }
    }
  }
}

