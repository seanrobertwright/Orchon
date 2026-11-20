// One recording session: the fixtures gathered from one release, held in memory until all of
// them have been scrubbed, and the list of what could not be recorded.
import type { LoopbackClient } from './http.ts'
import { createTape, type Recording, type Tape } from './recording.ts'
import type { Scrubber } from './scrub.ts'

export interface FixtureFile {
  /** Path inside the release's fixture folder, with forward slashes. */
  path: string
  /** One line for the log: what the file holds. */
  holds: string
  text: string
}

export interface Gap {
  what: string
  why: string
}

export interface Session {
  readonly release: string
  readonly client: LoopbackClient
  readonly files: FixtureFile[]
  readonly gaps: Gap[]
  /** A new tape for one scenario. */
  tape(): Tape
  /** Keeps a tape as the fixture `<name>.json`. */
  save(name: string, holds: string, tape: Tape): void
  /** Keeps a file as the release wrote it, such as a workflow's YAML. */
  saveText(path: string, holds: string, text: string): void
  /** Notes something the ticket asks for that this release did not give. */
  missing(what: string, why: string): void
}

/** A JSON fixture larger than this as indented text is written on one line. */
export const INDENT_LIMIT_BYTES = 1024 * 1024

/**
 * A JSON fixture's text: indented, so a change reads well in a diff, unless that makes it larger
 * than `INDENT_LIMIT_BYTES`. Every fixture counts toward Orca's install limit of 50 MiB.
 */
export function fixtureText(value: unknown): string {
  const indented = `${JSON.stringify(value, null, 2)}\n`
  return indented.length > INDENT_LIMIT_BYTES ? `${JSON.stringify(value)}\n` : indented
}

/** A fixture name is lower-case words, so it is a safe file name on every system. */
const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/

/** `now` is the clock every tape of the session reads; a test passes one it moves by hand. */
export function createSession(release: string, client: LoopbackClient, now?: () => number): Session {
  const files: FixtureFile[] = []
  const gaps: Gap[] = []
  const add = (path: string, holds: string, text: string): void => {
    if (!NAME.test(path)) throw new Error(`"${path}" is not a safe fixture name.`)
    if (files.some((file) => file.path === path)) throw new Error(`The fixture ${path} was recorded twice.`)
    files.push({ path, holds, text })
  }
  return {
    release,
    client,
    files,
    gaps,
    tape: () => (now === undefined ? createTape(client) : createTape(client, now)),
    save(name, holds, tape) {
      const recording: Recording = { release, scenario: name, log: tape.log }
      add(`${name}.json`, holds, fixtureText(recording))
    },
    saveText: add,
    missing(what, why) {
      gaps.push({ what, why })
    }
  }
}

export interface Scrubbed {
  /** The fixtures ready to be written. */
  files: FixtureFile[]
  /** Fixtures that still held something after scrubbing, with what. They are not written. */
  refused: { path: string; holds: string[] }[]
}

/** Scrubs every fixture. JSON is scrubbed value by value, so a path inside a string stays valid JSON. */
export function scrubFiles(files: readonly FixtureFile[], scrubber: Scrubber): Scrubbed {
  const scrubbed: Scrubbed = { files: [], refused: [] }
  for (const file of files) {
    const text = file.path.endsWith('.json') ? fixtureText(scrubber.scrub(JSON.parse(file.text) as unknown)) : scrubber.scrub(file.text)
    const holds = scrubber.leftovers(text)
    if (holds.length > 0) scrubbed.refused.push({ path: file.path, holds })
    else scrubbed.files.push({ ...file, text })
  }
  return scrubbed
}
