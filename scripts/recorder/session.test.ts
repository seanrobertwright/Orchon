// A session gathers a release's fixtures and lets none through that still holds machine details.
import { assert, describe, test } from 'orca/testing'
import type { LoopbackClient } from './http.ts'
import { createScrubber } from './scrub.ts'
import { createSession, fixtureText, INDENT_LIMIT_BYTES, scrubFiles } from './session.ts'

const client: LoopbackClient = {
  port: 41000,
  request: async () => ({ status: 200, contentType: 'application/json', body: { cwd: 'C:\\Temp\\throwaway\\project' } }),
  openStream: async () => {
    throw new Error('no stream')
  }
}

const scrubber = () =>
  createScrubber({ paths: [{ path: 'C:\\Temp\\throwaway\\project', as: '<project-path>' }], names: [{ name: 'dev', as: '<user>' }] })

describe('a recording session', () => {
  test('keeps a tape as a recording that names its release and scenario', async () => {
    const session = createSession('0.12.1', client)
    const tape = session.tape()
    await tape.call('GET', '/api/codebases')
    session.save('codebases', 'the project list', tape)
    assert.deepEqual(
      session.files.map((file) => [file.path, file.holds]),
      [['codebases.json', 'the project list']]
    )
    const recording = JSON.parse(session.files[0]?.text ?? '') as { release: string; scenario: string; log: unknown[] }
    assert.equal(recording.release, '0.12.1')
    assert.equal(recording.scenario, 'codebases')
    assert.equal(recording.log.length, 1)
  })

  test('refuses a name that is not a safe file name, and a name used twice', () => {
    const session = createSession('0.12.1', client)
    for (const name of ['../escape', '/abs', 'a\\b', 'A', 'a b', 'a//b', '.hidden', '']) {
      assert.throws(() => session.save(name, 'x', session.tape()), /safe fixture name/)
    }
    session.save('workflows/archon-assist', 'x', session.tape())
    assert.throws(() => session.save('workflows/archon-assist', 'x', session.tape()), /recorded twice/)
  })

  test('lists what could not be recorded', () => {
    const session = createSession('0.12.1', client)
    session.missing('server.json', 'this release does not write one')
    assert.deepEqual(session.gaps, [{ what: 'server.json', why: 'this release does not write one' }])
  })

  test('scrubs JSON value by value, so the fixture is still JSON', async () => {
    const session = createSession('0.12.1', client)
    const tape = session.tape()
    await tape.call('GET', '/api/codebases')
    session.save('codebases', 'the project list', tape)
    session.saveText('workflows/a.yaml', 'a workflow', 'cwd: C:/Temp/throwaway/project\n')
    const { files, refused } = scrubFiles(session.files, scrubber())
    assert.deepEqual(refused, [])
    const body = (JSON.parse(files[0]?.text ?? '') as { log: { body: unknown }[] }).log[0]?.body
    assert.deepEqual(body, { cwd: '<project-path>' })
    assert.equal(files[1]?.text, 'cwd: <project-path>\n')
  })

  test('indents a fixture, and writes one past 1 MiB on a single line', () => {
    assert.equal(fixtureText({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}\n')
    const large = { rows: Array.from({ length: 70_000 }, (_, index) => ({ index })) }
    const text = fixtureText(large)
    assert.ok(`${JSON.stringify(large, null, 2)}\n`.length > INDENT_LIMIT_BYTES)
    assert.equal(text, `${JSON.stringify(large)}\n`)
    assert.deepEqual(JSON.parse(text), large)
  })

  test('holds back a fixture that still names something after scrubbing', () => {
    // A name glued to other letters is not replaced, and the check still finds the path rule.
    const session = createSession('0.12.1', client)
    session.saveText('note.txt', 'a note', 'by dev\n')
    session.saveText('other.txt', 'a note', 'clean\n')
    const leaky = { ...scrubber(), scrub: <T>(value: T): T => value }
    const { files, refused } = scrubFiles(session.files, leaky)
    assert.deepEqual(refused, [{ path: 'note.txt', holds: ['<user>'] }])
    assert.deepEqual(
      files.map((file) => file.path),
      ['other.txt']
    )
  })
})
