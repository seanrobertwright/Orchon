// The recorder's command line: a release, its binary and nothing that points at the developer's Archon.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT_PORT, DEVELOPER_PORT, parseArguments } from './arguments.ts'
import { SPEND_SCENARIOS } from './spend.ts'

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
      out: null,
      scenario: null
    })
    assert.deepEqual(parseArguments(['--out', 'tmp/out', '--port', '41000', '--binary', 'a.exe', '0.14.0']), {
      release: '0.14.0',
      binary: 'a.exe',
      port: 41000,
      out: 'tmp/out',
      scenario: null
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

describe('spend mode on the command line', () => {
  const binary = ['--binary', 'archon']

  test('selects one scenario by name, with the token ceiling it was given', () => {
    assert.deepEqual(parseArguments(['0.14.0', ...binary, '--scenario', 'agent-step', '--allow-token-spend', '--token-ceiling', '150000']), {
      release: '0.14.0',
      binary: 'archon',
      port: DEFAULT_PORT,
      out: null,
      scenario: { name: 'agent-step', tokenCeiling: 150_000 }
    })
    const chat = parseArguments(['0.13.2', ...binary, '--token-ceiling', '60000', '--allow-token-spend', '--scenario', 'chat-turn'])
    assert.ok(!('error' in chat))
    assert.deepEqual(chat.scenario, { name: 'chat-turn', tokenCeiling: 60_000 })
    const metrics = parseArguments(['0.14.0', ...binary, '--scenario', 'metrics'])
    assert.ok(!('error' in metrics))
    assert.deepEqual(metrics.scenario, { name: 'metrics', tokenCeiling: 0 })
  })

  test('refuses a scenario it does not know, and more than one', () => {
    assert.match(error(['0.14.0', ...binary, '--scenario', 'everything']), /agent-step, chat-turn, metrics/)
    assert.match(error(['0.14.0', ...binary, '--scenario', 'agent-step', '--scenario', 'chat-turn']), /given twice/)
  })

  test('no flag, no spend: a scenario that calls a model needs --allow-token-spend', () => {
    for (const name of ['agent-step', 'chat-turn']) {
      assert.match(error(['0.14.0', ...binary, '--scenario', name, '--token-ceiling', '1000']), /--allow-token-spend/, name)
    }
  })

  test('a scenario that calls a model refuses to start without a token ceiling, or with one above its own', () => {
    assert.match(error(['0.14.0', ...binary, '--scenario', 'agent-step', '--allow-token-spend']), /--token-ceiling/)
    assert.match(error(['0.14.0', ...binary, '--scenario', 'agent-step', '--allow-token-spend', '--token-ceiling', '150001']), /at most 150000/)
    assert.match(error(['0.14.0', ...binary, '--scenario', 'chat-turn', '--allow-token-spend', '--token-ceiling', '100001']), /at most 100000/)
    for (const ceiling of ['0', '1e5', '-5', '150k', ' 100', 'NaN']) {
      assert.match(error(['0.14.0', ...binary, '--scenario', 'chat-turn', '--allow-token-spend', '--token-ceiling', ceiling]), /token ceiling|needs a value/, ceiling)
    }
  })

  test('the spend flag and a ceiling mean nothing without a scenario, and are refused', () => {
    assert.match(error(['0.14.0', ...binary, '--allow-token-spend']), /--scenario/)
    assert.match(error(['0.14.0', ...binary, '--token-ceiling', '1000']), /--scenario/)
  })

  test('the metrics scenario spends nothing, and runs on 0.14.0 only', () => {
    assert.match(error(['0.14.0', ...binary, '--scenario', 'metrics', '--allow-token-spend']), /spends no tokens/)
    assert.match(error(['0.14.0', ...binary, '--scenario', 'metrics', '--token-ceiling', '5']), /spends no tokens/)
    assert.match(error(['0.13.2', ...binary, '--scenario', 'metrics']), /0\.14\.0/)
  })

  test("each scenario's ceilings add up to no more than the total the owner agreed", () => {
    const total = Object.values(SPEND_SCENARIOS).reduce((sum, scenario) => sum + scenario.maxTokenCeiling, 0)
    assert.equal(total, 250_000)
    assert.deepEqual(
      Object.fromEntries(Object.entries(SPEND_SCENARIOS).map(([name, scenario]) => [name, scenario.maxTokenCeiling])),
      { 'agent-step': 150_000, 'chat-turn': 100_000, metrics: 0 }
    )
    for (const scenario of Object.values(SPEND_SCENARIOS)) assert.ok(scenario.wallClockMs > 0 && scenario.wallClockMs <= 15 * 60_000)
  })
})
