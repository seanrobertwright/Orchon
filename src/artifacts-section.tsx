// Artifacts in run detail: a name filter over a tree of the run's files by folder, and the file
// chosen in it shown underneath. It draws only the worker's view models. The list is asked for
// when Artifacts is chosen, a folder's entries when it is opened, the matches when the filter
// changes (after a pause in typing) and a file when it is selected. An answer is applied only
// when it is the newest one asked for in its place.
import {
  atom,
  CodeView,
  env,
  Input,
  KeyValue,
  Markdown,
  plugin,
  read,
  set,
  Spinner,
  Stack,
  Text,
  Tree,
  type KeyValueItem,
  type OrcaNode,
  type PanelContext,
  type TreeItem
} from 'orca'
import {
  ARTIFACT_FILTER_CAP,
  ARTIFACT_TEXT_CAP_BYTES,
  type ArtifactEntry,
  type ArtifactFile,
  type ArtifactsRequest,
  type ArtifactsView,
  type ArtifactView
} from './artifacts-view'
import { formatDateTime } from './dates'
import { frameTimers } from './frame-timers'
import { rejectionOf } from './view-fetch'
import { warningLine } from './view-notices'
import { CONSENT_TEXT, UNREACHABLE_TEXT } from './worker-words'

/** How long the filter waits after the last key before it asks the worker. */
export const FILTER_PAUSE_MS = 300

/** A folder's place in the tree: asked for, answered or failed. */
type FolderState =
  | { kind: 'loading' }
  | { kind: 'loaded'; entries: readonly ArtifactEntry[]; notShown: number }
  | { kind: 'failed'; message: string }

type Matches = Extract<ArtifactsView, { kind: 'matches' }>

/** The run whose artifacts are held, or null before Artifacts is first chosen. */
const heldRun = atom<string | null>(null)
/** Each folder asked for, the top level under the empty path. */
const folders = atom<ReadonlyMap<string, FolderState>>(new Map())
/** The run's file count and its unreadable entries, from the newest list answer. */
const counts = atom<{ total: number; unreadable: number } | null>(null)
/** Set when Archon answered that the run does not exist. */
const runGone = atom(false)
const expanded = atom<readonly string[]>([])
const filterText = atom('')
const matches = atom<Matches | { kind: 'loading' } | { kind: 'failed'; message: string } | null>(null)
/** The path of the file chosen, and what the worker answered for it. */
const chosen = atom<string | null>(null)
const chosenFile = atom<ArtifactView | { kind: 'loading' } | { kind: 'trouble'; message: string } | null>(null)

/** Rises with every request in a place; an answer is applied only when it carries the newest. */
const newest = new Map<string, number>()
let asked = 0
function ask(place: string): () => boolean {
  asked += 1
  const mine = asked
  newest.set(place, mine)
  return () => newest.get(place) === mine
}

let filterTimer: unknown

/** What a rejected request to the worker says. */
function troubleOf(error: unknown): string {
  const rejection = rejectionOf(error)
  if (rejection.kind === 'consent') return CONSENT_TEXT
  if (rejection.kind === 'rate-limited') return 'Orca asked Orchon to send fewer requests. Try again in a moment.'
  return UNREACHABLE_TEXT
}

/** Stops the filter's timer when the panel closes. */
export function startArtifactsView(ctx: PanelContext): void {
  ctx.subscriptions.push({
    dispose() {
      if (filterTimer !== undefined) frameTimers.clear(filterTimer)
      filterTimer = undefined
    }
  })
}

/** A run opens with nothing held: its list is asked for once Artifacts is chosen. */
export function resetArtifacts(): void {
  if (filterTimer !== undefined) frameTimers.clear(filterTimer)
  filterTimer = undefined
  newest.clear()
  set(heldRun, null)
  set(folders, new Map())
  set(counts, null)
  set(runGone, false)
  set(expanded, [])
  set(filterText, '')
  set(matches, null)
  set(chosen, null)
  set(chosenFile, null)
}

function setFolder(folder: string, state: FolderState): void {
  const next = new Map(read(folders))
  next.set(folder, state)
  set(folders, next)
}

/** Asks for one folder's entries; `open` reads the run's list from Archon again. */
async function loadFolder(runId: string, folder: string, open: boolean): Promise<void> {
  const current = ask(`folder:${folder}`)
  setFolder(folder, { kind: 'loading' })
  const request: ArtifactsRequest = folder === '' ? { runId } : { runId, folder }
  if (open) request.open = true
  try {
    const answer = await plugin.request('artifacts.read', request)
    if (!current() || read(heldRun) !== runId) return
    const view = answer.artifacts
    if (view.kind === 'folder') {
      setFolder(folder, { kind: 'loaded', entries: view.entries, notShown: view.notShown })
      set(counts, { total: view.total, unreadable: view.unreadable })
    } else if (view.kind === 'gone') {
      set(runGone, true)
    } else if (view.kind === 'failed') {
      setFolder(folder, { kind: 'failed', message: view.message })
    } else {
      setFolder(folder, { kind: 'failed', message: 'Orchon is not connected to Archon.' })
    }
  } catch (error) {
    if (current() && read(heldRun) === runId) setFolder(folder, { kind: 'failed', message: troubleOf(error) })
  }
}

/** Artifacts was chosen: the list is read again from Archon and its top level shown. */
export function openArtifacts(runId: string): void {
  resetArtifacts()
  set(heldRun, runId)
  void loadFolder(runId, '', true)
}

async function loadMatches(runId: string, filter: string): Promise<void> {
  const current = ask('matches')
  set(matches, { kind: 'loading' })
  try {
    const answer = await plugin.request('artifacts.read', { runId, filter })
    if (!current() || read(heldRun) !== runId) return
    const view = answer.artifacts
    if (view.kind === 'matches') set(matches, view)
    else if (view.kind === 'gone') set(runGone, true)
    else set(matches, { kind: 'failed', message: view.kind === 'failed' ? view.message : 'Orchon is not connected to Archon.' })
  } catch (error) {
    if (current() && read(heldRun) === runId) set(matches, { kind: 'failed', message: troubleOf(error) })
  }
}

function changeFilter(value: string): void {
  set(filterText, value)
  if (filterTimer !== undefined) frameTimers.clear(filterTimer)
  filterTimer = undefined
  const runId = read(heldRun)
  if (value === '' || runId === null) {
    ask('matches')
    set(matches, null)
    return
  }
  set(matches, { kind: 'loading' })
  filterTimer = frameTimers.set(() => {
    filterTimer = undefined
    void loadMatches(runId, value)
  }, FILTER_PAUSE_MS)
}

async function loadFile(runId: string, path: string): Promise<void> {
  const current = ask('file')
  set(chosen, path)
  set(chosenFile, { kind: 'loading' })
  try {
    const answer = await plugin.request('artifact.read', { runId, path })
    if (current() && read(heldRun) === runId) set(chosenFile, answer.artifact)
  } catch (error) {
    if (current() && read(heldRun) === runId) set(chosenFile, { kind: 'trouble', message: troubleOf(error) })
  }
}

const FOLDER_KEY = 'folder:'
const FILE_KEY = 'file:'
const MORE_KEY = 'more:'
const FAILED_KEY = 'failed:'

const count = (value: number): string => value.toLocaleString('en-US')

/** A size in bytes, KiB, MiB or GiB, as a row and the facts show it. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${count(bytes)} bytes`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${units[unit] ?? 'TiB'}`
}

const filesText = (files: number): string => (files === 1 ? '1 file' : `${count(files)} files`)

const moreRow = (folder: string, notShown: number): TreeItem => ({
  key: `${MORE_KEY}${folder}`,
  label: notShown === 1 ? '1 more entry is not shown' : `${count(notShown)} more entries are not shown`,
  description: 'Use the filter to find it',
  disabled: true
})

/** The tree's items, built again only when the folders held change. */
let built: { from: ReadonlyMap<string, FolderState>; items: TreeItem[] } | undefined

function itemsOf(held: ReadonlyMap<string, FolderState>, folder: string): TreeItem[] {
  const state = held.get(folder)
  if (state === undefined || state.kind === 'loading') return []
  if (state.kind === 'failed') return [{ key: `${FAILED_KEY}${folder}`, label: state.message, disabled: true }]
  const items = state.entries.map((entry): TreeItem => {
    if (entry.kind === 'file') return { key: `${FILE_KEY}${entry.path}`, label: entry.name, description: sizeText(entry.size), icon: 'file' }
    const inside = held.get(entry.path)
    const item: TreeItem = { key: `${FOLDER_KEY}${entry.path}`, label: entry.name, description: filesText(entry.files), icon: 'folder' }
    if (inside === undefined || inside.kind === 'loading') item.hasChildren = true
    else item.children = itemsOf(held, entry.path)
    return item
  })
  if (state.notShown > 0) items.push(moreRow(folder, state.notShown))
  return items
}

function treeItems(): TreeItem[] {
  const held = read(folders)
  if (built?.from !== held) built = { from: held, items: itemsOf(held, '') }
  return built.items
}

function toggleFolder(key: string, open: boolean): void {
  const others = read(expanded).filter((held) => held !== key)
  set(expanded, open ? [...others, key] : others)
  const runId = read(heldRun)
  if (!open || runId === null || !key.startsWith(FOLDER_KEY)) return
  const folder = key.slice(FOLDER_KEY.length)
  const state = read(folders).get(folder)
  if (state === undefined || state.kind === 'failed') void loadFolder(runId, folder, false)
}

function selectItem(key: string): void {
  const runId = read(heldRun)
  if (runId === null || !key.startsWith(FILE_KEY)) return
  void loadFile(runId, key.slice(FILE_KEY.length))
}

const selectedKey = (): { selected: string } | Record<string, never> => {
  const path = read(chosen)
  return path === null ? {} : { selected: `${FILE_KEY}${path}` }
}

function matchesBody(): OrcaNode {
  const found = read(matches)
  if (found === null || found.kind === 'loading') return <Spinner label="Finding matching artifacts…" />
  if (found.kind === 'failed') return <Text>{found.message}</Text>
  const line =
    found.notShown > 0
      ? `${filesText(found.matches)} match; ${count(found.notShown)} are not shown. Type more of the name to narrow it.`
      : found.matches === 1
        ? '1 file matches.'
        : `${filesText(found.matches)} match.`
  return (
    <Stack gap="sm">
      <Text muted size="sm">
        {line}
      </Text>
      {found.files.length === 0 ? null : (
        <Tree
          label="Matching artifacts"
          items={found.files.map((file) => ({ key: `${FILE_KEY}${file.path}`, label: file.path, description: sizeText(file.size), icon: 'file' }))}
          maxHeight="lg"
          {...selectedKey()}
          onSelect={({ key }) => selectItem(key)}
        />
      )}
    </Stack>
  )
}

function treeBody(runId: string): OrcaNode {
  const top = read(folders).get('')
  if (top === undefined || top.kind === 'loading') return <Spinner label="Loading the artifacts…" />
  if (top.kind === 'failed') return warningLine(top.message, () => void loadFolder(runId, '', true))
  if (top.entries.length === 0) return <Text muted>This run has no artifacts.</Text>
  return (
    <Tree
      label="Artifacts"
      items={treeItems()}
      maxHeight="lg"
      expanded={read(expanded)}
      {...selectedKey()}
      onToggle={({ key, expanded: open }) => toggleFolder(key, open)}
      onSelect={({ key }) => selectItem(key)}
    />
  )
}

/** The facts of a file: its path and size, and its modified time when its contents are shown. */
function factsOf(file: ArtifactFile, withTime: boolean): OrcaNode {
  const items: KeyValueItem[] = [
    { label: 'Path', value: file.path, code: true },
    { label: 'Size', value: sizeText(file.size) }
  ]
  if (withTime) {
    const at = file.modifiedAt === null ? '' : formatDateTime(file.modifiedAt, env.locale)
    items.push({ label: 'Modified', value: at === '' ? 'Not known' : at })
  }
  return <KeyValue label="Artifact facts" items={items} />
}

/** The blocks of a file's contents, each keyed by where it starts in the file. */
function blocksOf(name: string, kind: 'markdown' | 'text', blocks: readonly string[]): OrcaNode[] {
  let at = 0
  return blocks.map((block, index) => {
    const key = `${kind}:${String(at)}`
    at += block.length
    if (kind === 'markdown') return <Markdown key={key} content={block} />
    const label = blocks.length === 1 ? `Contents of ${name}` : `Contents of ${name}, part ${String(index + 1)} of ${String(blocks.length)}`
    return <CodeView key={key} code={block} label={label} wrap />
  })
}

const CAP_TEXT = `${String(ARTIFACT_TEXT_CAP_BYTES / 1024)} KiB`

function fileBody(): OrcaNode {
  const path = read(chosen)
  const view = read(chosenFile)
  if (path === null || view === null) return null
  if (view.kind === 'loading') return <Spinner label={`Loading ${path}…`} />
  if (view.kind === 'trouble') return <Text>{view.message}</Text>
  if (view.kind === 'not-listed') return <Text>{`${path} is no longer in the run's list of artifacts.`}</Text>
  if (view.kind === 'gone') return <Text>{`${path} is no longer there.`}</Text>
  if (view.kind === 'failed') return <Text>{view.message}</Text>
  if (view.kind === 'not-connected') return <Text>Orchon is not connected to Archon.</Text>
  const { file, content } = view
  if (content.kind === 'too-large' || content.kind === 'not-text') {
    return (
      <Stack gap="xs">
        {factsOf(file, false)}
        <Text muted size="sm">
          {content.kind === 'too-large' ? `This file is larger than ${CAP_TEXT}, so it is not shown here.` : 'This file is not text, so it is not shown here.'}
        </Text>
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      {factsOf(file, true)}
      {content.blocks.length === 0 ? <Text muted>This file is empty.</Text> : blocksOf(file.name, content.kind, content.blocks)}
    </Stack>
  )
}

/** Artifacts in place of the step list. */
export function artifactsBody(runId: string): OrcaNode {
  if (read(heldRun) !== runId) return <Spinner label="Loading the artifacts…" />
  if (read(runGone)) return <Text>This run no longer exists.</Text>
  const held = read(counts)
  const filtering = read(filterText) !== ''
  return (
    <Stack gap="sm">
      <Input
        label="Filter artifacts by name"
        type="search"
        value={read(filterText)}
        placeholder="Filter by name"
        maxLength={ARTIFACT_FILTER_CAP}
        onChange={changeFilter}
      />
      {filtering ? matchesBody() : treeBody(runId)}
      {held !== null && held.unreadable > 0 ? (
        <Text muted size="sm">
          {held.unreadable === 1 ? '1 file could not be read and is not shown.' : `${count(held.unreadable)} files could not be read and are not shown.`}
        </Text>
      ) : null}
      {fileBody()}
    </Stack>
  )
}
