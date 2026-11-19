// The recording run, against a stand-in release: no launch is sent unless Archon itself reads
// the recorder's workflow from the throwaway project with no agent in it, and no chat message
// is ever sent.
import { assert, describe, test } from 'orca/testing'
import type { Answer, LoopbackClient } from './http.ts'
import { recordRelease } from './scenarios.ts'
import { createSession, type Session } from './session.ts'

const json = (body: unknown, status = 200): Answer => ({ status, contentType: 'application/json', body })

/** The bundled workflow the recorder must never launch. The stand-in lists it as bundled. */
const CLEANUP = 'archon-worktree-cleanup'

/**
 * A release that registers the project and creates conversations, lists one bundled workflow,
 * `archon-worktree-cleanup`, and reads every workflow of the recorder's as `loaded` says.
 * Everything else it does not know. It keeps each request it was sent.
 */
function standInRelease(loaded: (name: string) => unknown): { client: LoopbackClient; sent: string[] } {
  const sent: string[] = []
  const client: LoopbackClient = {
    port: 41000,
    async request(method, path) {
      sent.push(`${method} ${path.split('?')[0] ?? path}`)
      const route = `${method} ${path.split('?')[0] ?? path}`
      if (route === 'GET /api/health') return json({ status: 'ok', version: '0.0.0' })
      if (route === 'GET /api/openapi.json') return json({ paths: { '/api/auth/status': { get: {} } } })
      if (route === 'POST /api/codebases') return json({ id: 'project-1', default_cwd: '/tmp/throwaway/project' }, 201)
      if (route === 'GET /api/workflows') return json({ workflows: [{ source: 'bundled', workflow: { name: CLEANUP } }] })
      if (route === `GET /api/workflows/${CLEANUP}`) {
        return json({ source: 'bundled', filename: `${CLEANUP}.yaml`, workflow: { name: CLEANUP, nodes: [{ id: 'a', kind: 'exec' }] } })
      }
      if (route === 'POST /api/conversations') return json({ id: 'conversation-1', conversationId: 'web-1' })
      const workflow = /^GET \/api\/workflows\/(orchon-recorder-[a-z]+)$/.exec(route)
      if (workflow?.[1] !== undefined) return json(loaded(workflow[1]))
      return json({ error: 'Not found' }, 404)
    },
    async openStream() {
      let end: () => void = () => undefined
      const ended = new Promise<{ by: 'recorder' }>((resolve) => {
        end = () => resolve({ by: 'recorder' })
      })
      return { status: 200, contentType: 'text/event-stream', ended, close: async () => end() }
    }
  }
  return { client, sent }
}

async function record(loaded: (name: string) => unknown): Promise<{ session: Session; sent: string[] }> {
  const { client, sent } = standInRelease(loaded)
  const session = createSession('0.0.0', client)
  // An Archon home that does not exist: this stand-in wrote no server.json.
  await recordRelease(session, { projectFolder: '/tmp/throwaway/project', archonHome: '/tmp/throwaway/no-archon-home' })
  return { session, sent }
}

// Each run waits a moment before its launches, so the three are started together and shared.
const withAgent = record(() => ({ source: 'project', workflow: { nodes: [{ id: 'a', kind: 'agent', prompt: 'Fix it.' }] } }))
const fromBundled = record(() => ({ source: 'bundled', workflow: { nodes: [{ id: 'a', kind: 'exec', runtime: 'sh' }] } }))
const unknown = record(() => ({ error: 'Workflow not found' }))

const launches = (sent: readonly string[]): string[] => sent.filter((request) => /^POST \/api\/workflows\/[^/]+\/run$/.test(request))
const gapsAbout = (session: Session, words: RegExp): number => session.gaps.filter((gap) => words.test(gap.why)).length

describe('a recording run', () => {
  test('sends no launch when Archon reads an agent step in the workflow', async () => {
    const { session, sent } = await withAgent
    assert.deepEqual(launches(sent), [])
    assert.ok(gapsAbout(session, /Archon reads a step as agent/) > 0)
  })

  test('sends no launch when the workflow is not read from the throwaway project', async () => {
    const { session, sent } = await fromBundled
    assert.deepEqual(launches(sent), [])
    assert.ok(gapsAbout(session, /is not read from the throwaway project/) > 0)
  })

  test('sends no launch when Archon does not know the workflow', async () => {
    const { sent } = await unknown
    assert.deepEqual(launches(sent), [])
  })

  test('never sends a chat message, and reads archon-worktree-cleanup without launching it', async () => {
    for (const run of [withAgent, fromBundled, unknown]) {
      const { session, sent } = await run
      assert.deepEqual(
        sent.filter((request) => /^POST \/api\/conversations\/[^/]+\/message$/.test(request)),
        []
      )
      // Its load answer is recorded like every bundled workflow's, and nothing else is sent for it.
      assert.deepEqual(
        sent.filter((request) => request.includes(CLEANUP)),
        [`GET /api/workflows/${CLEANUP}`]
      )
      assert.ok(session.files.some((file) => file.path === `workflows/${CLEANUP}.json`))
    }
  })

  test('notes that the assistants route has no null removal to record', async () => {
    const { session, sent } = await unknown
    assert.ok(sent.includes('PATCH /api/config/assistants'))
    const gap = session.gaps.find((entry) => entry.what === 'a null removal on PATCH /api/config/assistants')
    assert.ok(gap, 'no gap names the assistants null removal')
    assert.match(gap.why, /UpdateAssistantConfigBody/)
  })

  test('goes on after a scenario fails, and notes it as a gap', async () => {
    const { session, sent } = await unknown
    // The reads that come after the launches were still sent.
    assert.ok(sent.includes('PATCH /api/config/aliases'))
    assert.ok(sent.includes('DELETE /api/codebases/project-1'))
    assert.ok(session.files.some((file) => file.path === 'health.json'))
    assert.ok(session.gaps.some((gap) => gap.what === 'launch-accepted'))
    assert.ok(session.gaps.some((gap) => gap.what === 'server.json'))
  })
})
