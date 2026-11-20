// The frozen approval surface: what Orca compares when it decides whether an update asks the
// user to approve again. Between two releases the surface may change only when the minor version
// rises and the changelog says, under that version, what the user is asked to approve again.
//
//   node scripts/check-approval-surface.ts                       (no release tagged yet)
//   git show <tag>:orca-plugin.json | node scripts/check-approval-surface.ts --tag <tag>
//
// It starts no process: CI finds the last released tag and pipes that tag's manifest in.
import { readFileSync } from 'node:fs'
import { readRepoText } from './repo-files.ts'

export interface ApprovalSurfaceInput {
  /** The last released tag and its manifest's text, or null when no release has been tagged. */
  released: { tag: string; manifest: string } | null
  /** This tree's manifest, as text. */
  manifest: string
  /** This tree's CHANGELOG.md. */
  changelog: string
}

/** The heading, under a version's section of the changelog, of what that version asks again. */
export const ASKS_AGAIN_HEADING = '### Asks you to approve again'

/** The contribution kinds identified by one field of each entry; every other kind by its whole entry. */
const IDENTIFIED_BY: Readonly<Record<string, string>> = {
  panels: 'id',
  commands: 'id',
  events: 'on',
  customEditors: 'extensions'
}

interface Version {
  text: string
  major: number
  minor: number
}

/** The surface, part by part: each part a sorted list of canonical JSON texts. */
type Surface = Map<string, string[]>

class ManifestError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

/** JSON with every object's keys sorted, so the order a manifest writes them in changes nothing. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function parseVersion(value: unknown, where: string): Version {
  const match = typeof value === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value) : null
  if (match === null) throw new ManifestError(`${where}: "version" is not a version such as 0.1.0.`)
  return { text: value as string, major: Number(match[1]), minor: Number(match[2]) }
}

function entries(value: unknown, where: string, key: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ManifestError(`${where}: "${key}" is not a list.`)
  return value
}

/** The manifest's version and approval surface, or a refusal naming what is not readable. */
function parseManifest(text: string, where: string): { version: Version; surface: Surface } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ManifestError(`${where} is not JSON.`)
  }
  if (!isObject(parsed)) throw new ManifestError(`${where} is not a JSON object.`)
  const version = parseVersion(field(parsed, 'version'), where)
  const surface: Surface = new Map()
  surface.set('execution', [canonical(field(parsed, 'execution') ?? null)])
  surface.set(
    'capabilities',
    entries(field(parsed, 'capabilities'), where, 'capabilities').map((entry) => {
      const kind = isObject(entry) ? field(entry, 'kind') : undefined
      if (typeof kind !== 'string') throw new ManifestError(`${where}: a capability has no "kind".`)
      return canonical(kind)
    })
  )
  const contributes = field(parsed, 'contributes') ?? {}
  if (!isObject(contributes)) throw new ManifestError(`${where}: "contributes" is not an object.`)
  for (const kind of Object.keys(contributes)) {
    const identity = Object.hasOwn(IDENTIFIED_BY, kind) ? IDENTIFIED_BY[kind] : undefined
    surface.set(
      kind,
      entries(contributes[kind], where, `contributes.${kind}`).map((entry) => {
        if (identity === undefined) return canonical(entry)
        const value = isObject(entry) ? field(entry, identity) : undefined
        if (value === undefined) throw new ManifestError(`${where}: an entry of "contributes.${kind}" has no "${identity}".`)
        return canonical(Array.isArray(value) ? [...value].map(canonical).sort() : value)
      })
    )
  }
  for (const [part, list] of surface) surface.set(part, [...list].sort())
  return { version, surface }
}

/** The parts of the surface that differ, in a fixed order. */
function differingParts(released: Surface, current: Surface): string[] {
  const parts = [...new Set([...released.keys(), ...current.keys()])].sort()
  return parts.filter((part) => canonical(released.get(part) ?? []) !== canonical(current.get(part) ?? []))
}

/** The lines of one version's section of the changelog: from its `## ` heading to the next one. */
function versionSection(changelog: string, version: string): string[] | null {
  const lines = changelog.split(/\r?\n/)
  const heading = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `))
  if (heading === -1) return null
  const rest = lines.slice(heading + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return end === -1 ? rest : rest.slice(0, end)
}

/** Whether the version's section has the "Asks you to approve again" heading with text under it. */
function asksAgain(changelog: string, version: string): boolean {
  const section = versionSection(changelog, version)
  if (section === null) return false
  const start = section.indexOf(ASKS_AGAIN_HEADING)
  if (start === -1) return false
  const after = section.slice(start + 1)
  const end = after.findIndex((line) => line.startsWith('#'))
  return (end === -1 ? after : after.slice(0, end)).some((line) => line.trim() !== '')
}

/** One sentence for each reason the surface may not change as it does; empty when it passes. */
export function checkApprovalSurface(input: ApprovalSurfaceInput): string[] {
  if (input.released === null) return []
  const { tag } = input.released
  let released: ReturnType<typeof parseManifest>
  let current: ReturnType<typeof parseManifest>
  try {
    released = parseManifest(input.released.manifest, `The manifest of ${tag}`)
    current = parseManifest(input.manifest, 'orca-plugin.json')
  } catch (error) {
    if (error instanceof ManifestError) return [error.message]
    throw error
  }
  const parts = differingParts(released.surface, current.surface)
  if (parts.length === 0) return []
  const reasons: string[] = []
  const rises =
    current.version.major > released.version.major ||
    (current.version.major === released.version.major && current.version.minor > released.version.minor)
  if (!rises) {
    reasons.push(
      `A change to the approval surface needs a higher minor version than ${released.version.text}; this tree is ${current.version.text}.`
    )
  }
  if (!asksAgain(input.changelog, current.version.text)) {
    reasons.push(`CHANGELOG.md has no "Asks you to approve again" entry under ${current.version.text}.`)
  }
  if (reasons.length === 0) return []
  return [`The approval surface differs from ${tag} in: ${parts.join(', ')}.`, ...reasons]
}

/** The tag named by `--tag`, or null when none is named. An empty or flag-like tag is refused. */
export function parseTagArgument(args: readonly string[]): string | null {
  if (args.length === 0) return null
  if (args.length !== 2 || args[0] !== '--tag') throw new Error('Usage: node scripts/check-approval-surface.ts [--tag <tag>]')
  const tag = args[1] as string
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`"${tag}" is not a release tag such as v0.1.0.`)
  return tag
}

function main(): number {
  let tag: string | null
  try {
    tag = parseTagArgument(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  if (tag === null) {
    console.log('No release has been tagged yet, so the approval surface has nothing to be compared with.')
    return 0
  }
  const problems = checkApprovalSurface({
    released: { tag, manifest: readFileSync(0, 'utf8') },
    manifest: readRepoText('orca-plugin.json'),
    changelog: readRepoText('CHANGELOG.md')
  })
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) return 1
  console.log(`The approval surface is the same as ${tag}'s, or its change is a new minor version that asks you to approve again.`)
  return 0
}

if (import.meta.main) process.exitCode = main()
