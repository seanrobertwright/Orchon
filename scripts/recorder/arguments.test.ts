// The recorder's command line: a release, its binary and nothing that points at the developer's Archon.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT_PORT, DEVELOPER_PORT, parseArguments } from './arguments.ts'

const error = (args: string[]): string => {
  const parsed = parseArguments(args)
  assert.ok('error' in parsed, `accepted: ${args.join(' ')}`)
  return parsed.error
}

describe("the recorder's command line", () => {
  test('takes a release and its binary', () => {
    assert.deepEqual(parseArguments(['0.12.1', '--binary', 'bin/archon']), {
      release: '0.12.1',
      binary: 'bin/archon',
      port: DEFAULT_PORT,
      out: null
    })
    assert.deepEqual(parseArguments(['--out', 'tmp/out', '--port', '41000', '--binary', 'a.exe', '0.14.0']), {
      release: '0.14.0',
      binary: 'a.exe',
      port: 41000,
      out: 'tmp/out'
    })
  })

  test('refuses a missing or malformed release', () => {
    assert.match(error(['--binary', 'archon']), /Name the release/)
    for (const release of ['latest', 'v0.12.1', '0.12', '0.12.1-rc.1', '../0.12.1', '0.12.1/x', '']) {
      assert.match(error([release, '--binary', 'archon']), /three numbers|Name the release/, release)
    }
    assert.match(error(['0.12.1', '0.13.2', '--binary', 'archon']), /one release/)
  })

  test('requires the binary', () => {
    assert.match(error(['0.12.1']), /--binary is required/)
    assert.match(error(['0.12.1', '--binary']), /needs a value/)
    assert.match(error(['0.12.1', '--binary', '--port', '41000']), /needs a value/)
  })

  test("refuses the port of the developer's own Archon and anything that is not a port", () => {
    assert.match(error(['0.12.1', '--binary', 'archon', '--port', String(DEVELOPER_PORT)]), /your own Archon/)
    for (const port of ['0', '80', '65536', '1e4', '4100.5', ' 41000', '-41000', 'NaN', '0x9000']) {
      assert.match(error(['0.12.1', '--binary', 'archon', '--port', port]), /whole number|needs a value/, port)
    }
    assert.notEqual(DEFAULT_PORT, DEVELOPER_PORT)
  })

  test('refuses an option it does not know or one given twice', () => {
    assert.match(error(['0.12.1', '--binary', 'archon', '--home', 'x']), /Unknown option --home/)
    assert.match(error(['0.12.1', '--binary', 'a', '--binary', 'b']), /given twice/)
  })
})
