// The disk module's own seam, on real folders made for each test: what it reads, and the paths
// it refuses because they resolve outside its allowed roots.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, describe, test } from 'orca/testing'
import { openDisk } from './disk'

let sandbox = ''
let home = ''
let outside = ''

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'orchon-disk-')))
  home = join(sandbox, 'home', '.archon')
  outside = join(sandbox, 'outside')
  mkdirSync(home, { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(home, 'server.json'), '{"port":3090}')
  writeFileSync(join(outside, 'server.json'), '{"port":1}')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/** A folder link that needs no special right on Windows; an ordinary symlink elsewhere. */
function linkFolder(target: string, path: string): void {
  symlinkSync(target, path, 'junction')
}

describe('the disk module', () => {
  test('reads a text file inside an allowed root', async () => {
    const disk = openDisk([home])
    assert.deepEqual(await disk.readText(join(home, 'server.json'), 1024), { kind: 'text', text: '{"port":3090}' })
  })

  test('says whether a folder exists', async () => {
    const disk = openDisk([home])
    assert.equal(await disk.folderState(home), 'exists')
    assert.equal(await disk.folderState(join(home, 'logs')), 'missing')
    // A file is not a folder.
    assert.equal(await disk.folderState(join(home, 'server.json')), 'missing')
  })

  test('answers missing for a root that does not exist yet, and reads it once it does', async () => {
    const later = join(sandbox, 'later', '.archon')
    const disk = openDisk([later])
    assert.equal(await disk.folderState(later), 'missing')
    assert.deepEqual(await disk.readText(join(later, 'server.json'), 1024), { kind: 'missing' })
    mkdirSync(later, { recursive: true })
    writeFileSync(join(later, 'server.json'), '{}')
    assert.equal(await disk.folderState(later), 'exists')
    assert.deepEqual(await disk.readText(join(later, 'server.json'), 1024), { kind: 'text', text: '{}' })
  })

  test('answers missing for a file that is not there, and for a folder read as a file', async () => {
    const disk = openDisk([home])
    assert.deepEqual(await disk.readText(join(home, 'absent.json'), 1024), { kind: 'missing' })
    mkdirSync(join(home, 'logs'))
    assert.deepEqual(await disk.readText(join(home, 'logs'), 1024), { kind: 'missing' })
  })

  test('refuses a path outside its roots', async () => {
    const disk = openDisk([home])
    assert.deepEqual(await disk.readText(join(outside, 'secret.txt'), 1024), { kind: 'refused' })
    assert.equal(await disk.folderState(outside), 'refused')
    assert.equal(await disk.folderState(sandbox), 'refused')
    // A sibling whose name only starts like the root is outside it.
    mkdirSync(`${home}-other`)
    assert.equal(await disk.folderState(`${home}-other`), 'refused')
  })

  test('resolves .. before it decides', async () => {
    const disk = openDisk([home])
    const escaping = [home, '..', '..', 'outside', 'secret.txt'].join('/')
    assert.deepEqual(await disk.readText(escaping, 1024), { kind: 'refused' })
    assert.equal(await disk.folderState([home, '..'].join('/')), 'refused')
    // The same dots that stay inside the root are fine.
    const staying = [home, 'logs', '..', 'server.json'].join('/')
    assert.deepEqual(await disk.readText(staying, 1024), { kind: 'text', text: '{"port":3090}' })
  })

  test('resolves a link before it decides: a link out of the root is refused', async () => {
    linkFolder(outside, join(home, 'linked'))
    const disk = openDisk([home])
    assert.deepEqual(await disk.readText(join(home, 'linked', 'secret.txt'), 1024), { kind: 'refused' })
    assert.equal(await disk.folderState(join(home, 'linked')), 'refused')
    assert.deepEqual(await disk.readText(join(home, 'linked', 'not-there.txt'), 1024), { kind: 'refused' })
  })

  test('follows a root that is itself a link, and a link that stays inside the root', async () => {
    const real = join(sandbox, 'real-home')
    mkdirSync(join(real, 'data'), { recursive: true })
    writeFileSync(join(real, 'server.json'), '{"port":4000}')
    const linkedRoot = join(sandbox, 'linked-home')
    linkFolder(real, linkedRoot)
    linkFolder(join(real, 'data'), join(real, 'alias'))
    const disk = openDisk([linkedRoot])
    assert.equal(await disk.folderState(linkedRoot), 'exists')
    assert.deepEqual(await disk.readText(join(linkedRoot, 'server.json'), 1024), { kind: 'text', text: '{"port":4000}' })
    assert.equal(await disk.folderState(join(linkedRoot, 'alias')), 'exists')
  })

  test('allows each of several roots and nothing between them', async () => {
    const disk = openDisk([home, outside])
    assert.deepEqual(await disk.readText(join(outside, 'secret.txt'), 1024), { kind: 'text', text: 'secret' })
    assert.equal(await disk.folderState(sandbox), 'refused')
  })

  test('refuses everything when it has no roots', async () => {
    const disk = openDisk([])
    assert.equal(await disk.folderState(home), 'refused')
    assert.deepEqual(await disk.readText(join(home, 'server.json'), 1024), { kind: 'refused' })
  })

  test('refuses a path or a root that is not a full path', async () => {
    assert.equal(await openDisk([home]).folderState('server.json'), 'refused')
    assert.equal(await openDisk(['.']).folderState(process.cwd()), 'refused')
  })

  test('does not read a file past the size it was told', async () => {
    const disk = openDisk([home])
    writeFileSync(join(home, 'big.json'), 'x'.repeat(65))
    assert.deepEqual(await disk.readText(join(home, 'big.json'), 64), { kind: 'too-large' })
    writeFileSync(join(home, 'fits.json'), 'x'.repeat(64))
    assert.deepEqual(await disk.readText(join(home, 'fits.json'), 64), { kind: 'text', text: 'x'.repeat(64) })
  })
})

describe('the disk module, writing', () => {
  let workspace = ''
  let folder = ''
  beforeEach(() => {
    workspace = join(sandbox, 'workspace')
    folder = join(workspace, '.orchon')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'keep.txt'), 'mine')
  })

  test('makes the root folder, once, and writes a text file inside it', async () => {
    const disk = openDisk([folder])
    assert.equal(await disk.makeFolder(folder), 'ok')
    assert.equal(await disk.makeFolder(folder), 'ok')
    assert.equal(await disk.writeText(join(folder, 'a.orchonrun'), '{"x":1}\n'), 'ok')
    assert.equal(readFileSync(join(folder, 'a.orchonrun'), 'utf8'), '{"x":1}\n')
    assert.equal(await disk.writeText(join(folder, 'a.orchonrun'), 'again'), 'ok')
    assert.equal(readFileSync(join(folder, 'a.orchonrun'), 'utf8'), 'again')
  })

  test('refuses to make, write or delete outside its roots, and writes nothing there', async () => {
    const disk = openDisk([folder])
    assert.equal(await disk.makeFolder(join(workspace, 'other')), 'refused')
    assert.equal(await disk.writeText(join(workspace, 'keep.txt'), 'changed'), 'refused')
    assert.equal(await disk.writeText([folder, '..', 'new.txt'].join('/'), 'x'), 'refused')
    assert.equal(await disk.remove(join(workspace, 'keep.txt')), 'refused')
    assert.equal(readFileSync(join(workspace, 'keep.txt'), 'utf8'), 'mine')
    assert.equal(existsSync(join(workspace, 'other')), false)
    assert.equal(existsSync(join(workspace, 'new.txt')), false)
  })

  test('will not use a root folder that is a link, or a file in its place', async () => {
    linkFolder(outside, folder)
    const disk = openDisk([folder])
    assert.equal(await disk.makeFolder(folder), 'failed')
    rmSync(folder, { recursive: true, force: true })
    writeFileSync(folder, 'not a folder')
    assert.equal(await disk.makeFolder(folder), 'failed')
  })

  test('says a write failed when the folder is not there', async () => {
    const disk = openDisk([folder])
    assert.equal(await disk.writeText(join(folder, 'a.orchonrun'), 'x'), 'failed')
  })

  test('lists a folder with each entry, its time and whether it is a file', async () => {
    const disk = openDisk([folder])
    assert.equal(await disk.listFolder(folder), null)
    mkdirSync(join(folder, 'inner'), { recursive: true })
    writeFileSync(join(folder, 'a.orchonrun'), 'x')
    const when = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    utimesSync(join(folder, 'a.orchonrun'), when, when)
    const listed = await disk.listFolder(folder)
    assert.deepEqual(
      listed?.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'a.orchonrun', modifiedMs: when.getTime(), file: true },
        { name: 'inner', modifiedMs: listed?.find((entry) => entry.name === 'inner')?.modifiedMs ?? 0, file: false }
      ]
    )
    assert.equal(await disk.listFolder(workspace), null)
  })

  test('a link inside the folder is listed as not a file', async () => {
    mkdirSync(folder)
    linkFolder(outside, join(folder, 'linked.orchonrun'))
    const listed = await openDisk([folder]).listFolder(folder)
    assert.equal(listed?.find((entry) => entry.name === 'linked.orchonrun')?.file, false)
  })

  test('deletes a file inside the folder, and never a folder', async () => {
    mkdirSync(join(folder, 'inner'), { recursive: true })
    writeFileSync(join(folder, 'a.orchonrun'), 'x')
    const disk = openDisk([folder])
    assert.equal(await disk.remove(join(folder, 'a.orchonrun')), 'ok')
    assert.equal(await disk.remove(join(folder, 'inner')), 'failed')
    assert.equal(await disk.remove(join(folder, 'gone.orchonrun')), 'failed')
    assert.deepEqual(readdirSync(folder), ['inner'])
  })
})
