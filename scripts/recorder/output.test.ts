// Writing a release's fixtures: an earlier recording is replaced, and nothing else is.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { LOG_FILE, NotARecordingFolder, writeFixtures, writeRecording } from './output.ts'
import { isA, scratchFolders } from './testing.ts'

const scratch = scratchFolders()

describe('writing fixtures', () => {
  test('writes every file and the log into a new folder', () => {
    const folder = join(scratch(), 'fixtures', '0.12.1')
    writeFixtures(
      folder,
      [
        { path: 'health.json', text: '{}\n' },
        { path: 'workflows/archon-assist.json', text: '{"a":1}\n' }
      ],
      '# Log\n'
    )
    assert.deepEqual(readdirSync(folder).sort(), [LOG_FILE, 'health.json', 'workflows'])
    assert.equal(readFileSync(join(folder, 'workflows', 'archon-assist.json'), 'utf8'), '{"a":1}\n')
    assert.equal(readFileSync(join(folder, LOG_FILE), 'utf8'), '# Log\n')
  })

  test('replaces an earlier recording, so a fixture that is no longer recorded goes', () => {
    const folder = scratch()
    writeFixtures(folder, [{ path: 'old.json', text: '{}\n' }], '# Log\n')
    writeFixtures(folder, [{ path: 'new.json', text: '{}\n' }], '# Log\n')
    assert.deepEqual(readdirSync(folder).sort(), [LOG_FILE, 'new.json'])
  })

  test('refuses a folder that holds something other than a recording', () => {
    const folder = scratch()
    writeFileSync(join(folder, 'notes.txt'), 'mine')
    assert.throws(() => writeFixtures(folder, [{ path: 'new.json', text: '{}\n' }], '# Log\n'), isA(NotARecordingFolder))
    assert.equal(existsSync(join(folder, 'notes.txt')), true)
    assert.equal(existsSync(join(folder, 'new.json')), false)
  })

  test('a complete recording replaces an earlier one and leaves nothing beside it', () => {
    const parent = scratch()
    const folder = join(parent, '0.12.1')
    writeFixtures(folder, [{ path: 'old.json', text: '{}\n' }], '# Old\n')
    assert.equal(writeRecording(folder, { files: [{ path: 'new.json', text: '{}\n' }], log: '# New\n', complete: true }), 'written')
    assert.deepEqual(readdirSync(folder).sort(), [LOG_FILE, 'new.json'])
    assert.deepEqual(readdirSync(parent), ['0.12.1'])
  })

  test('a failed or interrupted recording leaves an earlier one as it was', () => {
    const folder = scratch()
    writeFixtures(folder, [{ path: 'old.json', text: '{"kept":true}\n' }], '# Old\n')
    assert.equal(writeRecording(folder, { files: [{ path: 'new.json', text: '{}\n' }], log: '# New\n', complete: false }), 'kept')
    assert.deepEqual(readdirSync(folder).sort(), [LOG_FILE, 'old.json'])
    assert.equal(readFileSync(join(folder, 'old.json'), 'utf8'), '{"kept":true}\n')
    assert.equal(readFileSync(join(folder, LOG_FILE), 'utf8'), '# Old\n')
  })

  test('a failed or interrupted recording makes no folder', () => {
    const folder = join(scratch(), '0.12.1')
    assert.equal(writeRecording(folder, { files: [{ path: 'new.json', text: '{}\n' }], log: '# New\n', complete: false }), 'kept')
    assert.equal(existsSync(folder), false)
  })
})
