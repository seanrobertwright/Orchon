# Archon builder: upstream state and reuse

Research for #5. Plan only: facts and their sources, no product code.

## Short answer

- The premise of #5 is out of date. Upstream PRs 3378 and 3379 both merged on
  2026-10-05 and shipped in Archon 0.12.0 (2026-10-17). The builder at upstream
  HEAD loads the workflow as authored and saves it back through a server
  serialiser that keeps comments, anchors and formatting. The builder README and
  the published docs page still carry the old warning; they were last edited
  before the merge.
- Editing an existing workflow is not blocked in code. The read-only sources
  are `bundled` (Save becomes "Save as", writing a project override) and
  `installed` packs (a notice replaces the editor).
- `loop_group`, `workflow:` sub-run and `include` nodes now open as read-only
  "opaque" nodes that are written back unchanged. They cannot be created or
  edited on the canvas, and nothing upstream plans editors for them.
- Archon is MIT licensed. Builder modules may be vendored or adapted into a
  separately published plugin if the copyright and permission notice travel
  with them. No `@archon/*` package is on npm, so vendoring is the only route.
- React 19, React Flow 12 and dagre together are about 0.43 MiB minified, far
  below every Orca limit named in #5.
- The run graph needs only React and dagre: hand-placed HTML nodes over one SVG
  of elbow paths.

## Sources and method

| Source | What it is | Tag used below |
| --- | --- | --- |
| Shallow clone of `coleam00/Archon`, branch `dev` (the default branch), commit `8d24481ddc6721aff7a6d8476bb61cbe55a9d81d`, committed 2026-11-17, root `package.json` version 0.14.0 | Code and docs read directly | `[code]` |
| `gh` against `coleam00/Archon` on 2026-11-17: PRs, issues, commit history, releases, repository licence metadata | First-party GitHub records | `[github]` |
| `npm view` and `npm pack --dry-run --json` on 2026-11-17 | Registry metadata and tarball file listings | `[registry]` |
| Published tarballs unpacked in a scratch directory; React production files passed through `bun build --minify` (a transform, nothing executed) | Byte counts of real build files | `[measured]` |
| Conclusions drawn from the above | Not stated by any source | `[inferred]` |

Orca's plugin limits are taken from #5 as given; they were not re-verified here.

## 1. Upstream state of the loss-free round trip

### The two PRs

| | PR 3378 | PR 3379 |
| --- | --- | --- |
| Link | <https://github.com/coleam00/Archon/pull/3378> | <https://github.com/coleam00/Archon/pull/3379> |
| Title | fix(server): saving a workflow from the builder keeps the file's comments, anchors and formatting | fix(web): the console builder edits workflows as authored, without false errors, and can save them |
| State | Merged 2026-10-05 into `dev` | Merged 2026-10-05 into `dev` |
| Closes | Upstream issue 3342 | Upstream issue 3377 |
| What it changes | The PUT handler merges the submitted definition into the YAML document already on disk instead of regenerating the file. An unchanged save writes nothing. The rendered text must parse back to the submitted definition or the save fails with 500. | `GET /api/workflows/{name}` gains an optional `authored` field: the file's YAML mapping before the engine normalises it. The builder edits that form. Node modes with no editor become a read-only `opaque` variant. Every key of the generated wire node type must be given a role or the build fails. |

`[github]` for the table. Both changes are present in the clone:
`serializeWorkflowPreservingText` in `packages/server/src/routes/workflow-yaml.ts`,
`authoredForm` in `packages/server/src/routes/workflow-files.ts`, `loadWorkflow`
in `packages/web/src/experiments/console/skills/workflows.ts`, and
`WIRE_KEY_ROLES` in
`packages/web/src/experiments/console/builder/types/wire-keys.ts`. `[code]`

Follow-ups that also merged `[github]`:

- Upstream PR 3966, "preserve workflow YAML outside edited scalars", merged
  2026-10-13. It closed upstream issue 3734, which reported that a one-field
  edit re-rendered the whole file. It is the `tryRenderScalarEdits` path in
  `workflow-yaml.ts`. `[code]`
- Upstream PR 3846, "hide unsupported controls on read-only builder nodes",
  merged 2026-10-05.
- Upstream PRs 4221, 5069, 5159 and 5437 (loop completion validation, new-loop
  default, complexity reduction, loop conditions aligned with the engine),
  merged between 2026-10-15 and 2026-11-09.

`CHANGELOG.md` lists PRs 3378, 3379, 3846 and 3966 under `[0.12.0] - 2026-10-17`:
"The console builder edits and saves workflows as authored, keeping comments,
anchors and formatting". `[code]`

### Stale documentation

The builder `README.md` and the docs page
`packages/docs-web/src/content/docs/adapters/web.md` both still say the round
trip "is not supported until" the two PRs land, and that the builder "does not
represent" include, `loop_group` or `workflow` nodes. `[code]` The README's last
commit is dated 2026-09-21 (upstream PR 3402), two weeks before the merge.
`[github]` No open upstream issue asks for the text to be corrected (searches
for "builder README" and "builder" in open issues found none). `[github]`

Treat the code, the PR records and the CHANGELOG as the truth and the README
warning as historical.

### Limits that remain after the merge

- A YAML merge key (`<<: *base`) is expanded into plain keys on save. Stated in
  the body of PR 3378. `[github]`
- Only scalar-only edits keep the rest of the file byte-for-byte
  (`tryRenderScalarEdits`). Adding, removing or reordering nodes, and any change
  touching an anchor or alias, goes through the document merge in `render`,
  which re-renders the file through the `yaml` library: comments and anchors
  survive, but folded blocks and flow-map spacing can change. `[code]`
- An alias is written out as its value when its anchor moved below it or no
  longer holds the same value (`settleAliases`). `[code]`
- The exporter drops an explicit empty `depends_on: []` (`sparsifyNode` in
  `builder/model/to-workflow.ts`). `[code]`
- A node key the detected variant does not carry is dropped with a
  `structural.field.unsupported` warning (`nodeFromDag` in
  `builder/model/from-workflow.ts`). `[code]`
- The PUT has no version or etag check. `saveWorkflowFile` in
  `packages/server/src/routes/api.workflows.ts` reads the file at save time and
  merges the submitted definition over it, so values changed on disk since the
  load are overwritten without warning. `[code]` `[inferred]`

### Stated roadmap

- The published docs call the builder "a bounded experiment inside the
  console"; the console `README.md` says the `builder/` subtree "remains
  experimental". `[code]`
- Upstream issue 3138 (open, created 2026-09-02) proposes a separate
  agent-assisted workflow-authoring purpose. Its acceptance list includes "This
  outcome does not require preserving or expanding the current visual builder",
  and its scope note says it is "not a commitment to a visual builder".
  `[github]`
- `builder/CONTEXT.md` is a glossary for a "Builder Copilot" that returns
  "Proposed Edits" in "Proposals". No implementation of those terms exists under
  `packages/web/src` or `packages/server/src`; the only match for the terms is
  the glossary itself. `[code]`
- Upstream issue 5343 (open, created 2026-11-03) asks for a run graph with live
  node state and drill-in for `loop_group` bodies and expanded includes. It is
  about viewing runs, not authoring. `[github]`
- Upstream issue 2053 (open) tracks moving the console onto design tokens;
  upstream PR 5397 (merged 2026-11-12) applied a dimension scale across the
  console, builder included. `[github]`
- No open upstream issue or PR was found for: editors for `loop_group`,
  `workflow` or `include` nodes; saving canvas positions; publishing packages to
  npm. `[github]`
- The builder is still maintained: its folder has commits through 2026-11-16,
  mostly keeping it in step with engine changes. `[github]`

Reading these together: upstream keeps the builder working but signals no
investment in widening it, and one open design issue would be satisfied without
it. `[inferred]`

## 2. What the builder can and cannot do today

All `[code]` unless tagged otherwise; paths are under
`packages/web/src/experiments/console/builder/`.

### Node types

- Editable and creatable from the palette, per `VARIANTS` in
  `variants/registry.ts`: prompt, command, bash, script, loop, approval, wait,
  cancel. `VariantId` in `types/variant.ts` aliases the console's
  `WorkflowNodeKind` union, so the builder and the run graph share one list.
- Read-only, per `OpaqueKind` in `types/variant.ts`: `loop_group`, `workflow`,
  `include`. `detectOpaqueKind` in `variants/detect.ts` recognises them by key
  presence. `nodeFromDag` turns each into an `OpaqueBuilderNode` whose mode
  fields are kept in `data.fields` and written back verbatim, with an info issue
  "have no editor yet; shown read-only and saved unchanged". Their base fields
  (`depends_on`, `when` and the other `base` keys of `WIRE_KEY_ROLES`) stay
  editable. They are not in the palette and cannot be switched to.
- The wire keys reserved for opaque nodes are `loop_group`, `workflow`,
  `include`, `input`, `isolation` and `fan_out` (`WIRE_KEY_ROLES`).
- A node with no recognisable mode key is imported as an empty prompt node with
  an error issue (`structural.variant.unknown`) shown in the issue panel. The
  save gate in `doSave` runs `runValidation` on the live workflow and does not
  consult import issues, so that error alone does not stop a save; a third-party
  builder should make it blocking. `[inferred]`
- A `loop_group` body is not drawn; the node is a single box
  (`opaquePreview` in `components/BuilderNodeView.tsx`). Upstream issue 5343
  describes the same from a user's side. `[github]`

### Fields carried without an editor

Kept on the round trip but not editable in the inspector: `approval.decisions`,
`on_timeout` on bash and script nodes, node-local `with` bindings on command and
script nodes (comments in `types/variant.ts`). Workflow-level keys other than
`name`, `description` and `nodes` are held in `BuilderWorkflow.meta` and spread
back by `toWorkflowDefinition`; `BuilderPage.tsx`, `components/Toolbar.tsx` and
`components/Inspector.tsx` contain no reference to `meta`, so there is no editor
for workflow-level settings such as inputs.

### Read-only sources

- `isReadOnlySource` in `connect/save-logic.ts` returns true for `bundled` and
  `installed` only.
- `bundled`: the editor opens, the header button reads "Save as", and
  `saveTargetFor` sends the write to `project`, creating an override that shadows
  the bundled default (`BuilderConnected.tsx`, `connect/BuilderHeader.tsx`).
- `installed` (a pack workflow named `owner/plugin:entrypoint`): the GET answers
  without `authored`; `loadWorkflow` returns `{ installedPack: true }` and
  `connect/BuilderBody.tsx` shows "installed from a pack — read-only" in place of
  the editor.
- `project` and `global`: edited and saved in place.
- Server side, `saveWorkflowFile` and `deleteWorkflowFiles` refuse to overwrite
  or delete a bundled default with a 400.

### Is editing an existing workflow blocked, or only advised against?

Neither any more. Nothing in the client or server blocks a load, edit and save
of a `project` or `global` workflow, and the advice against it in the README
predates the fixes it was waiting for. The one hard client refusal is in
`loadWorkflow`: if the server answers without `authored` for a source other than
`installed`, it throws rather than open the normalised form, because "editing
the normalized form would open every node as unrecognised and write them back as
empty prompts". A third-party client must copy that rule. It also means a
builder built on `authored` needs a server at 0.12.0 or later; `GET /api/health`
reports an optional `version`
(`packages/server/src/routes/api.health.ts`). `[code]` `[inferred]`

### `authored` versus the normalised definition

`getWorkflowDefinition` in `packages/server/src/routes/api.workflows.ts` returns
both:

- `workflow`: the output of `parseWorkflow`, the engine's normalised form. The
  body of PR 3379 describes what normalising does: it adds `kind`, `source` and
  `decisions`, rewrites `bash:` as an exec node, and inlines `include:`. That
  form cannot be sent back; validation rejects it. `[github]`
- `authored`: `authoredForm(content)`, the file's top-level YAML mapping parsed
  with the loader's `parseYaml` and nothing else. Typed in
  `getWorkflowResponseSchema` as an optional record, absent when the top level
  is not a mapping or the workflow is an installed pack.

`GET /api/workflows` (the list) carries only the normalised form, with the
author's declared workflow-level values layered back for display
(`workflowListEntry`).

### Validate

1. Client, synchronous: `runValidation` in `validation/validate.ts` runs
   `validateStructural`, `validateGraph` and `validateContent`. Any issue of
   severity `error` blocks the save (`blockingErrors`, used by `doSave` in
   `connect/use-builder-actions.ts`).
2. Server: `POST /api/workflows/validate` with body `{ definition }`. The
   handler runs `Bun.YAML.stringify(definition)` then `parseWorkflow`, and
   answers HTTP 200 with `{ valid, errors? }` either way. It takes no `cwd`, so
   it checks the definition alone, not whether named commands or scripts exist
   in a project.

### Save

`PUT /api/workflows/{name}?cwd=&source=project|global` with body
`{ definition }` (`saveWorkflowRoute`, `saveWorkflowBodySchema`). In order:

1. `isValidCommandName(name)`, else 400.
2. `resolveWorkflowTarget`: `source=global` writes to the home workflows folder;
   otherwise `cwd` must sit inside a registered codebase path (`validateCwd`),
   else 400 "Invalid cwd: must match a registered codebase path". With no `cwd`
   the first registered codebase is used, and the Archon home folder when none
   is registered.
3. `findWorkflowAt` looks for an existing file: flat `<name>.yaml` or `.yml`,
   then a pack-layout file `<pack>/<workflow>/<file>.yaml` whose declared name
   matches. A new workflow is written as `<name>.yaml`.
4. `serializeWorkflowPreservingText(definition, existing?.content)` produces the
   text and asserts it reads back as the definition.
5. `parseWorkflow` validates the text, else 400 with the engine's error.
6. The file is written only when the text differs from what is on disk.
7. The response carries the normalised `workflow`, `filename` and `source`, but
   no `authored`; `saveWorkflow` in the client reuses the definition it sent.

Rename is a PUT under the new name followed by a DELETE of the old one
(`doRename`); a failed delete leaves both files and raises a warning. The
builder forces the YAML `name:` to equal the route name on every save.

### Other limits

- Canvas positions are never saved. `builderToFlow` computes them with
  `layoutWithDagre` each time a workflow opens.
- The YAML pane is a read-only preview from the hand-written `serializeToYaml`
  in `yaml/serialize.ts`. It is not the text the server writes.
- The unsaved-changes guard covers reload, tab close and the builder's own
  header controls. Browser Back and the project rail are not guarded
  (`BuilderConnected.tsx` header comment).
- The README says workflows in nested folders cannot be loaded by name. At HEAD
  `findWorkflowAt` resolves flat files and the pack layout; any other nesting is
  not found by the single-name route.

## 3. Licence, vendoring, attribution, naming

- `LICENSE` at the repository root is the MIT License, "Copyright (c) 2025-2026
  Cole Medin". `[code]` GitHub reports the repository licence as MIT. `[github]`
- No `package.json` in the root or under `packages/` has a `license` field, and
  no file in the builder folder carries its own licence header, so the root
  `LICENSE` is the only grant. `[code]`
- MIT permits copying, modifying, publishing, sublicensing and selling. Its one
  condition is that "the above copyright notice and this permission notice shall
  be included in all copies or substantial portions of the Software". `[code]`

What that means for a separately published plugin `[inferred]`; this is a
reading of the licence text, not legal advice:

- Vendoring or adapting builder modules is allowed, in source or bundled form.
- Ship Archon's full `LICENSE` text, with its copyright line, inside the plugin
  folder (for example in a third-party notices file) and keep it in the source
  repository. Marking vendored files with their origin path and the upstream
  commit is good practice, not a licence condition.
- The plugin's own code may carry any licence; the vendored portions stay under
  MIT terms.
- The bundled libraries need their notices too. From the registry: React, React
  DOM, scheduler, `@xyflow/react`, `@xyflow/system`, `@dagrejs/dagre`,
  `@dagrejs/graphlib`, zustand and classcat are MIT; the `d3-*` packages React
  Flow pulls in are ISC, except `d3-ease`, which is BSD-3-Clause; `lucide-react`
  is ISC. `[registry]`

Trademark and naming:

- The clone has no trademark policy, no `NOTICE` or `TRADEMARK` file, and no
  match for "trademark" in any Markdown, MDX, text, JSON or Astro file. `[code]`
- A brand guide exists (`packages/docs-web/src/content/docs/brand/index.md`,
  sources in `packages/docs-web/public/brand/`). It covers the logo, gradient
  and type, with visual rules such as "Never: distort · recolor the gradient ·
  place on busy imagery". For "an unusual usage" it says to open a GitHub
  discussion on the upstream repository. It says nothing about third parties
  using the name. `[code]`
- The MIT text grants no trademark rights. Whether "Archon" is a registered
  mark was not checked. `[inferred]`
- Lowest-risk path `[inferred]`: describe the plugin as working with or for
  Archon, say plainly that it is unofficial, do not ship the Archon logo or the
  brand gradient as the plugin's own identity, and do not copy the console's
  brand theme wholesale. Asking upstream through a discussion is the route the
  brand guide itself names, and it would be the owner's decision to take.

## 4. How separable the builder code is

External imports of each builder subfolder, non-test files only. `[code]`

| Folder | Imports from outside the builder | Verdict |
| --- | --- | --- |
| `variants/`, `model/` | none | Pure. Portable as is. |
| `yaml/` | none | Pure and dependency-free. Preview only. |
| `types/` | `@/lib/api.generated` (type-only, through `types/wire.ts`) and the `WorkflowNodeKind` type from `primitives/workflow-graph` | Pure, but needs the generated wire types. |
| `validation/` | `@/lib/node-ref`, `@/lib/input-ref` | Pure. The two helpers are small regex modules with no imports beyond each other. |
| `flow/` | `@dagrejs/dagre` (`layout.ts`), types from `@xyflow/react` (`types.ts`) | Pure functions; `layoutWithDagre` returns a position map. |
| `editor/` | `@/lib/node-ref`; types from the console's `lib/keymap` and `components/KeymapHelp` (`keymap.ts` only) | Pure reducer (`editorReducer` in `state.ts`), history, clipboard, alignment, smart guides. Only `keymap.ts` leans on the console. |
| `components/`, `BuilderPage.tsx` | `react`, `@xyflow/react`, `lucide-react`, `react-markdown`, `rehype-highlight`, the console's `lib/keymap` and `KeymapHelp` | A controlled surface: `BuilderPage` takes the workflow as a prop and reports edits through `onChange`, with no API calls. Tied to the console's Tailwind v4 utilities and CSS variables. |
| `connect/`, `BuilderConnected.tsx` | `react-router`, the console's `store/cache`, `store/keys`, `skills`, `lib/http`, `primitives` | Console-specific. Replace entirely. `save-logic.ts` is the exception: pure functions over an `HttpError` type. |

Points a third party has to handle `[code]` `[inferred]`:

- Wire types. `types/wire.ts` aliases `DagNode` and `WorkflowDefinition` from
  the generated `packages/web/src/lib/api.generated.d.ts`. The server serves the
  same OpenAPI document at `/api/openapi.json` (`app.doc` in
  `packages/server/src/routes/api.ts`), so a plugin can generate its own types
  from a running server or vendor the generated file. The `satisfies` check on
  `WIRE_KEY_ROLES` then turns any new engine node key into a compile error,
  which is the upstream guard against silently dropping fields.
- Styling. Builder components use Tailwind v4 utility classes resolved against
  tokens declared in `packages/web/src/index.css` and re-pointed under
  `.console-root` in the console's `theme.css`. A plugin must run Tailwind at
  build time with equivalent tokens and ship the compiled CSS, or restyle the
  components.
- React Flow CSS. The console imports `@xyflow/react/dist/style.css` once, in
  `packages/web/src/index.css`. A plugin has to bundle that stylesheet itself.
- Fonts. `theme.css` loads Geist and Geist Mono from Google Fonts by URL. An
  Orca frame has no network, so the fonts must be shipped in the plugin folder
  or replaced with a system stack.
- The YAML preview highlights through `react-markdown` and `rehype-highlight`
  (`components/YamlPreview.tsx`). That pair brings a syntax-highlighting grammar
  set with it and is easy to replace with something lighter.
- Size of what would be vendored: the builder's non-test TypeScript is roughly
  290 KB of source at the commit read, about a third of it in `components/`.

The engine schema is not reusable in a browser frame `[code]` `[inferred]`:

- `packages/workflows/src/schemas/` is a large set of zod modules that import
  other workspace packages (`@archon/provider-contract`, `@archon/paths`) and
  engine modules outside `schemas/`.
- `parseYaml` in `packages/workflows/src/loader.ts` calls `Bun.YAML.parse`, and
  the validate route calls `Bun.YAML.stringify`; both need the Bun runtime.
- The web package itself does not import `@archon/workflows`; a comment in
  `packages/web/src/lib/node-ref.ts` states that `@archon/web` "must never
  depend on" it and keeps a deliberate copy of the node-id grammar, checked
  against the engine by a parity test.

So a third-party builder should treat `POST /api/workflows/validate` as the
authoritative validator, exactly as the console does, and use the builder's
client validation only for fast feedback.

npm `[registry]`: `npm view` returns 404 for `@archon/workflows`, `@archon/web`,
`@archon/core`, `@archon/cli`, `@archon/paths`, `@archon/server`,
`@archon/plugin-manifest`, `@archon/script-api` and `@archon/provider-contract`.
The `@archon/workflows` manifest exports TypeScript source paths and depends on
its sibling packages through `workspace:*`, and `@archon/web` is marked private.
`[code]` There is no package to depend on.

## 5. Bundle size against Orca's limits

Versions are the ones Archon's `bun.lock` resolves. `[code]`

Registry metadata, whole packages `[registry]`:

| Package | Version | `dist.unpackedSize` (bytes) | Files |
| --- | --- | --- | --- |
| `@xyflow/react` | 12.10.1 | 1,188,438 | 508 |
| `@xyflow/system` | 0.0.75 | 669,544 | 182 |
| `@dagrejs/dagre` | 2.0.4 | 829,564 | 16 |
| `@dagrejs/graphlib` | 3.0.4 | 369,437 | 12 |
| `react` | 19.2.4 | 171,604 | 27 |
| `react-dom` | 19.2.4 | 7,319,413 | 43 |
| `scheduler` | 0.27.0 | 82,665 | 15 |
| `zustand` | 4.5.7 | 327,043 | 141 |

Unpacked size is a poor proxy for bundle size: it counts source maps, type
declarations, development builds and React DOM's server renderers. The files a
browser bundle actually uses are much smaller.

Build files that end up in a bundle `[measured]`:

| Piece | File in the published tarball | As published (bytes) | Minified (bytes) |
| --- | --- | --- | --- |
| React Flow 12.10.1 | `dist/umd/index.js` | 185,712 | 185,712 (already minified) |
| React Flow stylesheet | `dist/style.css` | 18,574 | 18,574 |
| dagre 2.0.4 | `dist/dagre.esm.js` | 43,825 | 43,825 (already minified) |
| React 19.2.4 | `cjs/react.production.js` | 17,217 | 7,752 |
| React JSX runtime | `cjs/react-jsx-runtime.production.js` | 976 | 976 (not minified here) |
| React DOM 19.2.4 | `cjs/react-dom.production.js` | 6,655 | 3,393 |
| React DOM client | `cjs/react-dom-client.production.js` | 536,016 | 177,341 |
| scheduler 0.27.0 | `cjs/scheduler.production.js` | 10,181 | 10,181 (not minified here) |
| Total | | 819,156 | 447,754 |

Notes on the table:

- The React Flow UMD file requires only `react`, `react/jsx-runtime` and
  `react-dom`, so it already contains `@xyflow/system`, the `d3-*` modules,
  zustand and classcat. `[measured]`
- `dagre.esm.js` has no import statements, while `dagre.cjs.js` requires
  `@dagrejs/graphlib` and is smaller by about the size of graphlib's own
  minified build, so the ESM file has graphlib inlined. `[measured]`
  `[inferred]`
- React 19 publishes its production files unminified; the minified column is
  the output of `bun build --minify` on each file. A real bundler that also
  tree-shakes would land at or below these numbers. `[measured]`

Against the limits in #5:

| Orca limit | Value | This dependency set, minified | Share |
| --- | --- | --- | --- |
| Per panel or editor entry | 10 MiB (10,485,760 bytes) | 447,754 bytes, about 0.43 MiB | about 4% |
| Per plugin folder | 50 MiB | same, plus plugin code, CSS and fonts | about 1% |
| Files per plugin folder | 2,000 | one script and one stylesheet if bundled | negligible |
| Per source file Orca transpiles itself | 1 MiB | not applicable to a pre-built bundle; even unminified the set is 819,156 bytes | under the limit either way |

Consequences `[inferred]`:

- Size is not a constraint for a React Flow builder. Adding the vendored builder
  source, an icon subset and compiled Tailwind CSS still leaves an order of
  magnitude of headroom on the entry limit.
- Because frames have no network, the bundle must contain React, React Flow,
  dagre, the React Flow stylesheet, any fonts and any icons. Nothing can come
  from a CDN.
- React Flow needs its CSS to render correctly. Ship `dist/style.css` (or
  `dist/base.css`, 13,563 bytes, plus own styles) in the bundle output.
- Pre-bundle with the plugin's own toolchain rather than hand Orca raw source.
  That keeps the 1 MiB transpile limit out of play and avoids copying whole
  packages (the packages in the registry table unpack to about 10.4 MiB before
  the `d3-*` modules are counted).

Version drift to be aware of `[registry]`:

- `@xyflow/react` 13.0.0 was published on 2026-11-16, one day before this
  research; the registry's latest is 13.0.2. Its layout changed: one
  `dist/index.js` of 147,176 bytes with `@xyflow/system` 1.0.0 and
  `react-compiler-runtime` as external dependencies. The newest 12.x is 12.12.1
  (UMD build 188,872 bytes). Archon pins `^12.10.1`.
- `@dagrejs/dagre` latest is 3.1.3 (`dist/dagre.esm.js` 48,929 bytes). Archon
  pins `^2.0.4`.
- Vendored builder code is written against the 12.x and 2.x APIs. Stay on those
  lines unless the code is ported.

## 6. The read-only run graph

`packages/web/src/experiments/console/components/RunGraphPanel.tsx`, used by
`routes/RunDetailPage.tsx`. All `[code]`.

How it draws:

- `layout` builds a `dagre.graphlib.Graph` with `rankdir: 'TB'`, fixed node
  width and height, and one edge per `dependsOn` entry whose source exists. It
  runs `dagre.layout` and converts dagre's centre positions to top-left.
- Edges are orthogonal elbow paths computed by hand from the node boxes: down
  from the source's bottom centre, across at the midpoint between ranks, down
  into the target's top centre. dagre's own edge points are not used.
- Rendering is one absolutely positioned `<svg>` holding a `<path>` per edge,
  with each node drawn as an HTML `<button>` positioned over it (`GraphNode`).
  There is no pan, zoom or minimap; the container scrolls.
- Status sets fill, border and glyph colour through CSS variables
  (`statusFill`, `statusBorder`, `statusGlyphClass`); the node kind sets a text
  glyph (`kindGlyph`). A running node pulses while the run is live. Clicking a
  node calls `onNodeSelect`.

Where its data comes from:

- Structure: `getWorkflowGraph` in `skills/workflows.ts` calls the list endpoint
  `GET /api/workflows?cwd=`, finds the workflow by name and maps each node to
  `{ id, dependsOn, kind }`. It uses the list route on purpose, because the
  single-name route does not recurse into sub-folders.
- State: the `nodes` prop is `run.nodes` from the run-detail response
  (`RunNodeState` in `primitives/event.ts`); `deriveNodeStatuses` in
  `primitives/workflow-graph.ts` joins state to structure by node id and treats
  an unlisted node as `pending`.

Limits:

- `nodeKind` in `skills/workflows.ts` tests for loop, approval, wait, cancel,
  bash, command and script and falls back to `prompt`, so a `loop_group` or
  `workflow` node is drawn as a prompt node. `[inferred]`
- The graph is flat: top-level nodes only, no loop-body or include drill-in.
  Upstream issue 5343 asks for exactly that and is open. `[github]`
- `kindGlyph` and the status helpers are switches with one case per kind in
  `WorkflowNodeKind` and per state in `RunNodeState['state']` and no default
  branch. The states handled are running, completed, failed, skipped and
  pending.

Dependency footprint of a visualiser-only approach `[measured]` `[inferred]`:

- Runtime libraries: React, React DOM and dagre. No React Flow, no zustand, no
  `d3-*`, no React Flow stylesheet. From the table above that is about 243 KB
  minified (React, JSX runtime, React DOM, React DOM client, scheduler, dagre),
  a little over half of the full builder set.
- The component itself is one file of under 10 KB of source. Its console ties
  are thin: `useEntity` from the store cache, one skill call, two primitive
  type modules, and Tailwind classes with CSS variables.
- dagre could be replaced by a small longest-path layering routine for
  top-to-bottom DAGs, which would leave React as the only dependency. The cost
  is crossing minimisation, which matters on wide fan-outs.
- A visualiser that reads the authored form instead of the list route could
  also show `loop_group`, `workflow` and `include` nodes under their real kinds,
  which upstream does not do today.

## Conclusions

### What a third-party builder can safely do today

- Require Archon 0.12.0 or later and check `version` from `GET /api/health`.
- Load with `GET /api/workflows/{name}?cwd=`, edit the `authored` mapping, and
  refuse to open anything that arrives without it, as `loadWorkflow` does.
- Create new workflows and edit existing `project` and `global` workflows made
  of prompt, command, bash, script, loop, approval, wait and cancel nodes.
- Keep `loop_group`, `workflow` and `include` nodes, and every key it has no
  editor for, verbatim, and still let the user change their `depends_on` and
  `when`.
- Validate with `POST /api/workflows/validate`, then save the whole definition
  with `PUT /api/workflows/{name}?cwd=&source=`. Leave YAML text preservation,
  the read-back check and the final engine validation to the server.
- Treat `bundled` as "save as a project override" and `installed` as view-only.
- Vendor or adapt the pure builder modules (`variants/`, `model/`,
  `validation/`, `flow/`, `editor/`, `yaml/`, `types/`, plus `lib/node-ref` and
  `lib/input-ref`) under MIT, with Archon's licence text shipped in the plugin.
- Bundle React 19, React Flow 12, dagre 2 and the React Flow stylesheet in one
  entry; at about 0.43 MiB minified this is roughly 4% of the 10 MiB limit.
- Ship a read-only run graph on React and dagre alone.

### What it would have to reimplement

- Everything in `connect/` and `BuilderConnected.tsx`: project selection,
  loading, saving, rename, delete, navigation and the dirty guard, on Orca's
  plugin APIs instead of the console's store, skills and router.
- An HTTP client for the Archon server, and the mapping from an Orca workspace
  to a `cwd` that Archon accepts. The server rejects any `cwd` outside a
  registered codebase path.
- The wire types, generated from `/api/openapi.json` or vendored from
  `api.generated.d.ts`.
- The styling layer: a Tailwind build with equivalent tokens or restyled
  components, offline fonts, and the React Flow stylesheet.
- The keymap glue (`editor/keymap.ts` depends on the console's keymap types and
  help component) and the YAML preview's highlighter.
- Anything upstream does not have: editors for `loop_group`, `workflow` and
  `include`; drawing a loop-group body; an editor for workflow-level settings;
  saved canvas positions (for example a sidecar file outside the workflow YAML);
  detection of a file changed on disk between load and save.
- It cannot reasonably reimplement engine validation. The schema lives in
  workspace-only packages that need Bun, so the server (or the `archon` CLI)
  stays the authority.

### What it should wait for, or not wait for

- Do not wait for PRs 3378 and 3379. They merged and shipped.
- Do not wait for `@archon/*` on npm or for upstream editors for the opaque node
  kinds. Neither is planned in any open issue or PR found.
- Watch upstream issue 3138. If authoring moves to an agent purpose, the visual
  builder may stop changing or be removed, and a vendored copy becomes a fork
  the plugin owns outright. Pin the upstream commit the copy was taken from.
- Watch upstream issue 5343 before building loop drill-in for the run graph; the
  data it describes (`invocation.loopPath`, prefixed body node ids) is the
  starting point either way.
- Hold on React Flow 13 until the vendored code is ported or upstream moves.
- Expect API churn. The `[Unreleased]` section of `CHANGELOG.md` already lists
  breaking changes, and the workflow routes are unversioned, so the plugin
  should fail closed on shapes it does not recognise.

## Open questions this raises for the plan

- Naming: is the plugin presented as "for Archon" without the logo, or should
  the maintainer be asked first? This is the owner's call.
- Does the plan assume a running Archon server at all times? Validation and
  loss-free saving both live on the server; there is no browser-side path to
  either.
- How does an Orca workspace map onto an Archon registered codebase, and who
  registers it?
- Is last-write-wins on save acceptable, given that Orca users are likely to
  have the same YAML file open in an editor or under an agent at the same time?
