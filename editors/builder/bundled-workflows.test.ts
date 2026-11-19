// Every bundled workflow of every supported Archon release, opened in the builder and saved with
// no edit, must come back as the definition Archon gave. The definitions are the `authored` form
// of each recorded `GET /api/workflows/{name}` answer under fixtures/<release>/workflows/.
//
// Each test also reports, as a test diagnostic, the fields of each node that landed under
// "Not editable here", and each release reports how often each such field appears.
import { test, type TestContext } from 'node:test'
import { assert, describe } from 'orca/testing'
import { listRepoFiles, readRepoText } from '../../scripts/repo-files.ts'
import { fromWorkflowDefinition, toWorkflowDefinition } from './archon/model/index.ts'
import type { WireWorkflowDefinition } from './archon/types/index.ts'
import { notEditableHere } from './not-editable.ts'

const RECORDED_WORKFLOW = /^fixtures\/(\d+\.\d+\.\d+)\/workflows\/([^/]+)\.json$/

/** The recorded workflow answers of each release, by release. */
function recordedWorkflows(): Map<string, { name: string; path: string }[]> {
  const byRelease = new Map<string, { name: string; path: string }[]>()
  for (const { path } of listRepoFiles()) {
    const match = RECORDED_WORKFLOW.exec(path)
    if (match === null) continue
    const [, release = '', name = ''] = match
    byRelease.set(release, [...(byRelease.get(release) ?? []), { name, path }])
  }
  return byRelease
}

/** The definition a recorded answer gives, as its JSON says it. */
function authoredDefinition(path: string): WireWorkflowDefinition {
  const recording = JSON.parse(readRepoText(path)) as { log: { body: { authored?: unknown } }[] }
  const authored = recording.log[0]?.body.authored
  assert.ok(typeof authored === 'object' && authored !== null, `${path}: the answer has no authored definition`)
  return authored as WireWorkflowDefinition
}

/** What a save sends: the definition as JSON, so a property left undefined is not sent. */
const asSent = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const releases = recordedWorkflows()

test('the fixtures hold bundled workflows of at least the three supported releases', () => {
  assert.ok(releases.size >= 3, `found recorded workflows for ${[...releases.keys()].join(', ')}`)
})

/** One line per node that has fields under "Not editable here": `node: field, field`. */
function notEditableLines(definition: WireWorkflowDefinition): string[] {
  const { workflow } = fromWorkflowDefinition(definition)
  return workflow.nodes.flatMap((node) => {
    const fields = notEditableHere(node)
    return fields.length === 0 ? [] : [`${node.id} (${node.variant}): ${fields.join(', ')}`]
  })
}

for (const [release, workflows] of releases) {
  describe(`Archon ${release}: open and save every bundled workflow`, () => {
    for (const { name, path } of workflows) {
      test(`${name} comes back unchanged`, (t: TestContext) => {
        const authored = authoredDefinition(path)
        const { workflow } = fromWorkflowDefinition(authored)
        assert.deepEqual(asSent(toWorkflowDefinition(workflow)), asSent(authored))
        for (const line of notEditableLines(authored)) t.diagnostic(`Not editable here: ${line}`)
      })
    }

    test('reports how often each field lands under "Not editable here"', (t: TestContext) => {
      const counts = new Map<string, number>()
      for (const { path } of workflows) {
        const { workflow } = fromWorkflowDefinition(authoredDefinition(path))
        for (const node of workflow.nodes) {
          const kind = node.variant === 'opaque' ? node.data.kind : node.variant
          for (const field of notEditableHere(node)) {
            const key = `${kind} ${field}`
            counts.set(key, (counts.get(key) ?? 0) + 1)
          }
        }
      }
      const lines = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}: ${count}`)
      t.diagnostic(`Not editable here in ${workflows.length} workflows of Archon ${release}: ${lines.join('; ')}`)
      assert.ok(workflows.length > 0)
    })
  })
}
