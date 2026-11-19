// The throwaway Archon home: the recorder boots a release only against a home it made itself.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import {
  assertOwnHome,
  createThrowawayHome,
  HOME_MARKER,
  NotOwnHome,
  removeThrowawayHome,
  type ThrowawayHome
} from './home.ts'
import { isA, scratchFolders } from './testing.ts'

const scratch = scratchFolders()

/** Somebody's real Archon home, as far as the recorder can tell: a folder with a config in it. */
function developerHome(parent: string): string {
  const home = join(parent, '.archon')
  mkdirSync(home)
  writeFileSync(join(home, 'config.yaml'), 'assistants: {}\n')
  return home
}

describe('the throwaway Archon home', () => {
  test('is a new folder under the temp folder, with an empty Archon home and a marker', () => {
    const temp = scratch()
    const home = createThrowawayHome({ tempFolder: temp, developerHomes: [] })
    assert.equal(home.root.startsWith(temp), true)
    assert.equal(home.archonHome, join(home.root, 'archon-home'))
    assert.deepEqual(readdirSync(home.archonHome), [])
    assert.equal(existsSync(join(home.root, HOME_MARKER)), true)
    assertOwnHome(home)
  })

  test('holds an empty Claude config folder of its own, where a hidden login points', () => {
    const home = createThrowawayHome({ tempFolder: scratch(), developerHomes: [] })
    assert.equal(home.emptyClaudeConfig, join(home.root, 'claude-config-empty'))
    assert.deepEqual(readdirSync(home.emptyClaudeConfig), [])
  })

  test('two homes never share a folder', () => {
    const temp = scratch()
    const first = createThrowawayHome({ tempFolder: temp, developerHomes: [] })
    const second = createThrowawayHome({ tempFolder: temp, developerHomes: [] })
    assert.notEqual(first.root, second.root)
  })

  test('refuses a folder that has no marker', () => {
    const temp = scratch()
    const home = createThrowawayHome({ tempFolder: temp, developerHomes: [] })
    rmSync(join(home.root, HOME_MARKER))
    assert.throws(() => assertOwnHome(home), isA(NotOwnHome))
  })

  test('refuses a marker another run wrote', () => {
    const temp = scratch()
    const mine = createThrowawayHome({ tempFolder: temp, developerHomes: [] })
    const other = createThrowawayHome({ tempFolder: temp, developerHomes: [] })
    const forged: ThrowawayHome = { ...mine, root: other.root, archonHome: other.archonHome }
    assert.throws(() => assertOwnHome(forged), isA(NotOwnHome))
  })

  test('refuses an Archon home that is not the one inside its own root', () => {
    const temp = scratch()
    const home = createThrowawayHome({ tempFolder: temp, developerHomes: [] })
    const elsewhere = developerHome(temp)
    assert.throws(() => assertOwnHome({ ...home, archonHome: elsewhere }), isA(NotOwnHome))
    assert.throws(() => assertOwnHome({ ...home, archonHome: join(home.archonHome, '..', '..', '.archon') }), isA(NotOwnHome))
  })

  test('refuses the developer home, and any home that holds it or lies inside it, without reading it', () => {
    const temp = scratch()
    const real = developerHome(temp)
    const before = readdirSync(real)
    // A temp folder inside the developer's own home: everything made there would be theirs.
    assert.throws(() => createThrowawayHome({ tempFolder: real, developerHomes: [real] }), isA(NotOwnHome))
    assert.throws(() => createThrowawayHome({ tempFolder: join(real, 'tmp'), developerHomes: [real] }), isA(NotOwnHome))
    assert.deepEqual(readdirSync(real), before)

    const home = createThrowawayHome({ tempFolder: temp, developerHomes: [real] })
    for (const archonHome of [real, real.toUpperCase(), join(real, 'nested'), temp]) {
      assert.throws(() => assertOwnHome({ ...home, archonHome }), isA(NotOwnHome))
    }
    assert.deepEqual(readdirSync(real), before)
  })

  test('removes its own home, and nothing it did not make', () => {
    const temp = scratch()
    const real = developerHome(temp)
    const home = createThrowawayHome({ tempFolder: temp, developerHomes: [real] })
    writeFileSync(join(home.archonHome, 'archon.db'), 'x')
    assert.throws(() => removeThrowawayHome({ ...home, root: real, archonHome: real }), isA(NotOwnHome))
    assert.equal(existsSync(join(real, 'config.yaml')), true)
    removeThrowawayHome(home)
    assert.equal(existsSync(home.root), false)
  })
})
