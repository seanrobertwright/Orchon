# PROTOTYPE: workflow graph in an Orca editor tab

Throwaway code. It answers one question for the Orchon plan: does an Archon workflow graph
render well inside an Orca plugin frame, and should the spec draw it with dagre and plain SVG
or with React Flow? Nothing here is meant to be kept.

## What it is

`plugin/` is an Orca development plugin with two custom editors on the same data and the same
dagre layout:

- **A, dagre + SVG** (`plugin/editor-svg/`): hand-written SVG. No build step; Orca loads the
  files as written, and dagre's ESM build is copied into `plugin/vendor/`.
- **B, React Flow** (`src-flow/`, built into `plugin/editor-flow/`): React, React Flow and dagre
  in one bundle made by esbuild.

`plugin/worker.mjs` stands in for the real worker. It answers the editors' requests from
`plugin/fixtures/graphs.json` and never calls Archon. Its two palette commands open a tab the
way the plan intends: write a pointer file into `.orchon-proto/` in the focused workspace, then
call `editor.open`.

The fixtures are the bundled workflows of a local Archon, trimmed to ids, kinds, edges and
nesting, plus three generated graphs (100, 300 and 1000 nodes) for the performance check. The
run states on the nodes are made up.

## Run it

```sh
npm install
npm run proto      # builds variant B, then loads ./plugin into Orca and streams its logs
```

Loading needs the user's approval in Orca (the command prints what is granted and the
`--approve` value). Then, in Orca's command palette, run "Orchon prototype: open run graph
(A, dagre + SVG)" or "(B, React Flow)". The same route can be driven from a terminal:

```sh
orca plugin dev request ./plugin proto.open --data '{"variant":"svg"}'    # or "flow"
```

Each editor shows its node, edge and element counts and its timings in the toolbar, and sends
the same line to the worker, so `orca plugin logs local.orchon-dag-prototype` lists every
measurement. "Expand loop groups" switches between top-level steps only and every nested step.

`samples/` holds pointer files for fixed cases (a real workflow collapsed and expanded, and the
generated graphs). Open one with `orca plugin open local.orchon-dag-prototype --editor <file>`,
or capture it with `orca plugin shot ./plugin --editor <file> --out <png>`. `shots/` holds the
captures taken while judging the two variants.

`npm run fixtures` rebuilds `plugin/fixtures/graphs.json` from an Archon on port 3090.
`npm run build` rebuilds variant B and prints what each variant ships.
