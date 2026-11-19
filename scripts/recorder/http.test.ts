// The recorder's HTTP gateway reaches its own release on loopback and nothing else.
import { assert, describe, test } from 'orca/testing'
import { DEVELOPER_PORT } from './arguments.ts'
import { createLoopbackClient, NotOwnServer } from './http.ts'
import { isA } from './testing.ts'

describe("the recorder's HTTP gateway", () => {
  test("never calls the port of the developer's own Archon", () => {
    assert.throws(() => createLoopbackClient(DEVELOPER_PORT), isA(NotOwnServer))
  })

  test('refuses anything that is not a port', () => {
    for (const port of [0, 80, 65536, 41000.5, Number.NaN]) {
      assert.throws(() => createLoopbackClient(port), isA(NotOwnServer))
    }
  })

  test('refuses a path that could name another host, before any request is sent', async () => {
    const client = createLoopbackClient(41000)
    for (const path of ['@example.invalid/api/health', '.example.invalid/', 'api/health', '']) {
      await assert.rejects(client.request('GET', path), isA(NotOwnServer))
      await assert.rejects(
        client.openStream(path, () => undefined),
        isA(NotOwnServer)
      )
    }
  })
})
