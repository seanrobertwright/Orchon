// The path check: whether the Archon that discovery confirmed is one Orchon works with. It reads
// the server's own path list, the keys of `paths` in `/api/openapi.json`, and never its version
// string: a release, a fork and a source build are all judged by the paths they serve.
import type { Client } from './client'
import type { Features } from './connection-view'

export const OPENAPI_PATH = '/api/openapi.json'

/**
 * The paths every section relies on, all present at the floor (Archon 0.12.1). The spellings
 * were checked against the path list recorded from that release.
 */
export const REQUIRED_PATHS: readonly string[] = [
  '/api/health',
  '/api/codebases',
  '/api/dashboard/runs',
  '/api/runs/attention',
  '/api/runs/{runId}/artifacts',
  '/api/workflows',
  '/api/workflows/validate',
  '/api/workflows/{name}',
  '/api/workflows/{name}/run',
  '/api/workflows/runs/{runId}',
  '/api/workflows/runs/{runId}/cancel',
  '/api/workflows/runs/{runId}/resume',
  '/api/workflows/runs/{runId}/abandon',
  '/api/workflows/runs/{runId}/respond',
  '/api/workflows/runs/{runId}/answer',
  '/api/workflows/runs/{runId}/provider-events',
  '/api/workflows/runs/by-worker/{platformId}',
  '/api/conversations',
  '/api/conversations/{id}',
  '/api/conversations/{id}/messages',
  '/api/conversations/{id}/message',
  '/api/config',
  '/api/config/assistants',
  '/api/config/tiers',
  '/api/config/aliases',
  '/api/providers',
  '/api/update-check'
]

/** The paths of the Metrics section, first served by Archon 0.14.0. */
export const METRICS_PATHS: readonly string[] = ['/api/metrics', '/api/metric-views']

export type PathCheck =
  /** Every required path is listed. The optional features are those whose paths are all listed. */
  | { kind: 'supported'; features: Features }
  /** The document is not JSON, has no `paths` object, or lacks a required path. */
  | { kind: 'unsupported' }
  /** The document did not arrive: the connection was refused, or it timed out. */
  | { kind: 'unreachable' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decides from a parsed document. The path list is its `paths` object's own keys. */
export function judgePathList(document: unknown): PathCheck {
  if (!isRecord(document) || !Object.hasOwn(document, 'paths')) return { kind: 'unsupported' }
  const paths = document['paths']
  if (!isRecord(paths)) return { kind: 'unsupported' }
  const listed = (path: string): boolean => Object.hasOwn(paths, path)
  if (!REQUIRED_PATHS.every(listed)) return { kind: 'unsupported' }
  return { kind: 'supported', features: { metrics: METRICS_PATHS.every(listed) } }
}

/**
 * Reads the path list of a confirmed server through the client, as any read, and decides. A
 * refused connection or a timeout says nothing about the server's paths. Any other failure is
 * an answer that is not a path list: HTML where the document should be, an error status, or a
 * document past the read cap.
 */
export async function checkPaths(client: Client, baseUrl: string, signal: AbortSignal): Promise<PathCheck> {
  const answer = await client.request({ baseUrl, path: OPENAPI_PATH, timeout: 'read', signal })
  if (answer.ok) return judgePathList(answer.value)
  switch (answer.failure.kind) {
    case 'refused':
    case 'timeout':
    case 'cancelled':
      return { kind: 'unreachable' }
    default:
      return { kind: 'unsupported' }
  }
}
