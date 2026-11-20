// The release's environment: the throwaway home and nothing of the developer's own setup.
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { claudeLoginFolder, releaseEnvironment, type ProviderLogin } from './environment.ts'

const HIDDEN: ProviderLogin = { kind: 'hidden', emptyConfigFolder: '/tmp/throwaway/claude-config-empty' }

describe("the release's environment", () => {
  test('points the release at the throwaway home, whatever the shell said', () => {
    const env = releaseEnvironment({ ARCHON_HOME: '/home/dev/.archon', PATH: '/usr/bin' }, '/tmp/throwaway/archon-home', HIDDEN)
    assert.equal(env.ARCHON_HOME, '/tmp/throwaway/archon-home')
    assert.equal(Object.keys(env).filter((name) => name.toLowerCase() === 'archon_home').length, 1)
  })

  test('passes on only what a program needs to start', () => {
    const env = releaseEnvironment(
      {
        Path: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\dev',
        TEMP: 'C:\\Temp',
        archon_home: 'C:\\Users\\dev\\.archon',
        ARCHON_DOCKER: 'true',
        DATABASE_URL: 'postgres://example.invalid/archon',
        ANTHROPIC_API_KEY: 'key',
        CLAUDE_CODE_SESSION_ID: 'session',
        GH_TOKEN: 'token',
        PORT: '3090',
        LOG_LEVEL: 'debug',
        WORKSPACE_PATH: '/workspace',
        EMPTY: undefined
      },
      'C:\\Temp\\throwaway\\archon-home',
      HIDDEN
    )
    assert.deepEqual(env, {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\dev',
      TEMP: 'C:\\Temp',
      ARCHON_HOME: 'C:\\Temp\\throwaway\\archon-home',
      ARCHON_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1',
      CLAUDE_CONFIG_DIR: '/tmp/throwaway/claude-config-empty'
    })
  })

  test('hides the Claude login: its config folder is an empty throwaway folder, whatever the shell said', () => {
    const env = releaseEnvironment(
      { USERPROFILE: 'C:\\Users\\dev', claude_config_dir: 'C:\\Users\\dev\\.claude', CLAUDE_BIN_PATH: 'C:\\Users\\dev\\.local\\bin\\claude.exe' },
      'C:\\Temp\\throwaway\\archon-home',
      { kind: 'hidden', emptyConfigFolder: 'C:\\Temp\\throwaway\\claude-config-empty' }
    )
    assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\Temp\\throwaway\\claude-config-empty')
    assert.deepEqual(
      Object.keys(env).filter((name) => /^claude_/i.test(name)),
      ['CLAUDE_CONFIG_DIR']
    )
  })

  test('passes the login on only as the names that point at it, never a key or a token', () => {
    const parent = {
      USERPROFILE: 'C:\\Users\\dev',
      CLAUDE_CONFIG_DIR: 'D:\\claude-config',
      CLAUDE_BIN_PATH: 'C:\\Users\\dev\\.local\\bin\\claude.exe',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      CLAUDE_API_KEY: 'secret',
      ANTHROPIC_AUTH_TOKEN: 'secret'
    }
    const env = releaseEnvironment(parent, 'C:\\Temp\\throwaway\\archon-home', { kind: 'passed' })
    assert.equal(env.CLAUDE_CONFIG_DIR, 'D:\\claude-config')
    assert.equal(env.CLAUDE_BIN_PATH, 'C:\\Users\\dev\\.local\\bin\\claude.exe')
    assert.equal(env.USERPROFILE, 'C:\\Users\\dev')
    assert.ok(!Object.values(env).includes('secret'))
  })

  test('in spend mode with no config folder named, Claude is left to find its login in the home folder', () => {
    const env = releaseEnvironment({ USERPROFILE: 'C:\\Users\\dev' }, 'C:\\Temp\\throwaway\\archon-home', { kind: 'passed' })
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined)
    assert.equal(env.USERPROFILE, 'C:\\Users\\dev')
  })

  test("knows where Claude keeps the shell's login, by path only", () => {
    assert.equal(claudeLoginFolder({ CLAUDE_CONFIG_DIR: 'D:\\claude-config' }, 'C:\\Users\\dev'), 'D:\\claude-config')
    assert.equal(claudeLoginFolder({ claude_config_dir: '' }, '/home/dev'), join('/home/dev', '.claude'))
    assert.equal(claudeLoginFolder({}, '/home/dev'), join('/home/dev', '.claude'))
  })
})
