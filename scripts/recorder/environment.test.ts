// The release's environment: the throwaway home and nothing of the developer's own setup.
import { assert, describe, test } from 'orca/testing'
import { releaseEnvironment } from './environment.ts'

describe("the release's environment", () => {
  test('points the release at the throwaway home, whatever the shell said', () => {
    const env = releaseEnvironment({ ARCHON_HOME: '/home/dev/.archon', PATH: '/usr/bin' }, '/tmp/throwaway/archon-home')
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
      'C:\\Temp\\throwaway\\archon-home'
    )
    assert.deepEqual(env, {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\dev',
      TEMP: 'C:\\Temp',
      ARCHON_HOME: 'C:\\Temp\\throwaway\\archon-home',
      ARCHON_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1'
    })
  })
})
