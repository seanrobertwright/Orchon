// The log beside a release's fixtures says what was recorded, when, from which binary and what is missing.
import { assert, describe, test } from 'orca/testing'
import { nowIso } from './clock.ts'
import { recordedLog, type RecordedLog } from './log.ts'
import { PLACEHOLDERS } from './scrub.ts'

const log: RecordedLog = {
  release: '0.12.1',
  recordedAt: '2026-11-18T20:15:00Z',
  binary: { name: 'archon-windows-x64.exe', bytes: 90102784, sha256: 'ab12', reports: 'Archon CLI v0.12.1\n  Build: binary' },
  platform: 'win32 x64',
  serverVersion: '0.12.1',
  files: [
    { path: 'workflows/archon-assist.json', holds: 'GET /api/workflows/archon-assist' },
    { path: 'health.json', holds: 'GET /api/health | the first answer' }
  ],
  gaps: [{ what: 'server.json', why: 'this release\nwrites none' }]
}

describe('the recording log', () => {
  test('says when, which release and which binary', () => {
    const text = recordedLog(log)
    assert.match(text, /^# Archon 0\.12\.1: recorded fixtures\n/)
    assert.match(text, /^- Recorded at: 2026-11-18T20:15:00Z$/m)
    assert.match(text, /^- Binary: `archon-windows-x64\.exe`, 90,102,784 bytes, SHA-256 `ab12`$/m)
    assert.match(text, /^- The binary reports: `Archon CLI v0\.12\.1 Build: binary`$/m)
    assert.match(text, /^- The running server reported version: `0\.12\.1`$/m)
    assert.match(text, /^- Recorded on: win32 x64$/m)
  })

  test('lists every file by path, one row each', () => {
    const text = recordedLog(log)
    const rows = text.split('\n').filter((line) => line.startsWith('| `'))
    assert.deepEqual(rows, [
      '| `health.json` | GET /api/health \\| the first answer |',
      '| `workflows/archon-assist.json` | GET /api/workflows/archon-assist |'
    ])
  })

  test('lists what could not be recorded, or says nothing was left out', () => {
    assert.match(recordedLog(log), /## What could not be recorded\n\n- server\.json: this release writes none\n/)
    assert.match(recordedLog({ ...log, gaps: [] }), /## What could not be recorded\n\nNothing was left out\.\n/)
    assert.match(recordedLog({ ...log, files: [] }), /## What was recorded\n\nNothing\.\n/)
  })

  test('names every placeholder the scrubber writes', () => {
    const text = recordedLog(log)
    for (const { as, stands } of Object.values(PLACEHOLDERS)) assert.ok(text.includes(`- \`${as}\`: ${stands}\n`), as)
  })

  test('the time is UTC to the second', () => {
    assert.equal(nowIso(new Date(Date.UTC(2026, 10, 18, 20, 15, 7, 913))), '2026-11-18T20:15:07Z')
  })
})
