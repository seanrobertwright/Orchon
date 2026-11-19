# Archon's builder logic: upstream record

The folders beside this file are copied from Archon's visual workflow builder. They were copied
once, and there is no routine re-sync. The plugin's own replacements for what they imported from
the rest of Archon's web package are in `../support/`.

## Where it comes from

- Project: [coleam00/Archon](https://github.com/coleam00/Archon)
- Release tag: `v0.14.0`
- Commit: `8def159a6b2c23e832a5283b4131cfffd9af9344`
- Path: `packages/web/src/experiments/console/builder/`
- Licence: MIT, in [`LICENSE`](LICENSE) beside this file, unchanged from the tag.

## What was copied

| Folder | What it holds |
| --- | --- |
| `types/` | The builder's data model and its view of Archon's wire types |
| `variants/` | Reading and writing each of the eight editable node kinds |
| `model/` | Opening a workflow definition and writing it back |
| `validation/` | The local rules: structural, graph, content and the `when:` grammar |
| `yaml/` | The YAML preview text |
| `editor/` | The editing state, undo history, clipboard, alignment, smart guides and keymap table |
| `fixtures/` | Upstream's test fixtures, loaded only by the tests |

Upstream's tests for these folders are copied beside the code they test, as `*.test.ts`. The rest
of the builder folder (`flow/`, `components/`, `connect/` and the React pages) is not copied: it
is React and React Flow, and the plugin draws its own screens.

## Differences from upstream

### Imports

- Every relative import names its file: `'../types'` became `'../types/index.ts'` and
  `'./loop'` became `'./loop.ts'`. The editors load as ES modules in a frame, which follows only
  full paths; the compiler rewrites `.ts` to `.js`.
- `@/lib/node-ref` (in `validation/content.ts`, `validation/structural.ts`,
  `validation/when-grammar.ts`, `editor/state.ts` and `editor/state.test.ts`) became
  `../../support/node-ref.ts`, a copy of Archon's `packages/web/src/lib/node-ref.ts` at the same
  tag.
- `@/lib/api.generated` (in `types/wire.ts`) became `../../support/archon-api`, which holds the
  `WorkflowDefinition` and `DagNode` schemas of Archon's generated `api.generated.d.ts` at the
  same tag. The comment above the import says so.
- `../../primitives/workflow-graph` (in `types/variant.ts`) became `../../support/node-kind.ts`,
  which holds the same `WorkflowNodeKind` union.
- `../flow/types` and `../flow/to-flow` (in `editor/`) became `../../support/flow.ts`, which holds
  `XYPosition`, `edgeId` and `builderToFlowEdges` with no React Flow types. Its edges carry only
  `id`, `source` and `target`, with none of upstream's canvas styling.
- `../flow/layout` (in `editor/align.ts` and `editor/state.ts`) became `../../support/layout.ts`,
  and `layoutWithDagre` became `layoutGraph`. The plugin has no dagre yet, so `layoutGraph` is a
  layered stand-in with the same node size and spacing. The comments that named dagre in
  `editor/align.ts` and `editor/state.ts`, the test name in `editor/align.test.ts` and the keymap
  label `Auto-arrange (dagre)` in `editor/keymap.ts` no longer name it.
- `../../lib/keymap` and `../../components/KeymapHelp` (in `editor/keymap.ts`) became
  `../../support/keymap.ts`, which restates the `Binding` and `KeymapGroup` shapes with no React.

### Code

- `model/from-workflow.ts` drops nothing on import. Upstream turned four inputs into something
  else, and the plugin keeps each one unchanged:
  - A node with no mode field the builder knows became an empty prompt node with an `error`. It
    now opens read-only, as an `opaque` node of kind `unrecognised`.
  - A script node with no `runtime` was edited as `bun`, so a save wrote `runtime: bun`, with an
    `error`. It now opens read-only, of kind `script_without_runtime`.
  - A loop node with both `prompt` and `command` kept `prompt` and dropped `command`, with an
    `error`. It now opens read-only, of kind `loop_with_prompt_and_command`.
  - A field the node's kind does not carry (a field of another kind, or one no release names)
    was dropped with a `warning`. It is now kept with the node's base fields, which a save writes
    back as they were, and its issue is `info`.

  Each read-only node gets one `info` issue, `structural.node.read-only`, as upstream already
  gave a `loop_group`, `workflow` or `include` node. The importer's header comment and the
  comment on `importWorkflowDefinition` say so.
- `types/variant.ts`: `OpaqueKind` gains `unrecognised`, `script_without_runtime` and
  `loop_with_prompt_and_command`, and its comment names them.
- `variants/registry.ts`: their labels are "Unrecognised node", "Script with no runtime" and
  "Loop with prompt and command".
- `editor/align.ts`: `distributeH` and `distributeV` assert that the first and last rectangles
  exist (`sorted[0]!`), which the plugin's `noUncheckedIndexedAccess` setting requires. Both
  already return early below three rectangles.
- `validation/structural.ts` and `validation/content.ts`: `structural.field.missing`,
  `structural.field.invalid` and `content.when.parse` are warnings, where upstream has errors.
  Only `structural.id.empty`, `structural.id.duplicate`, `graph.ref.unknown` and `graph.cycle`
  are errors, and only they block a save (`../save-blockers.ts`). `content.var.unknown` is a
  warning upstream too.
- `validation/structural.ts`: the `until_field` check reads the property's `type` only when the
  property holds it itself (`Object.hasOwn`), where upstream tests `'type' in property`. The
  plugin tests plain objects with `Object.hasOwn`.
- `validation/structural.ts`: the wait timestamp check reads the calendar from the digits (month
  length, leap years, hours to 23, minutes and seconds to 59) in place of a round-trip through
  `new Date(value)`. The plugin reads dates only in its date helper. It accepts and refuses the
  same timestamps.

### Tests

- Each test imports `describe`, `test` and `expect` from `scripts/bun-expect.ts`, the plugin's
  stand-in for `bun:test` on top of `orca/testing`, in place of `bun:test`.
- `model/round-trip.test.ts` and `validation/when-grammar.test.ts` assert that an indexed node,
  issue or `when:` term exists (`nodes[0]!`), which `noUncheckedIndexedAccess` requires.
- `fixtures/index.ts` types `FIXTURES` with `satisfies` in place of a `Record` annotation, so a
  test that names one fixture gets it without `undefined`.
- `model/round-trip.test.ts`: the four "import issues" tests that pinned the lossy import above
  are rewritten to pin the plugin's: each input opens read-only or keeps its field, with an
  `info` issue, and saves unchanged.
- `validation/structural.test.ts` gains the test "wait timestamps must name a real UTC calendar
  instant", which pins the timestamps the upstream check accepted and refused, and the test
  "until_field reads only a type the property holds itself".

### Comments kept as upstream wrote them

Comments that describe Archon's own console, such as its React Flow canvas, its PR series and its
`scripts/node-ref-parity.test.ts`, are kept as upstream wrote them. They describe where the code
came from, not this plugin.
