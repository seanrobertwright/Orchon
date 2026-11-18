# PROTOTYPE: the Orchon runs view in an Orca sidebar panel

Throwaway code. It answers one question for the Orchon plan: what should the runs view look
like, and how is its list capped or paged? Nothing here is meant to be kept.

## What it is

`plugin/` is an Orca development plugin with one components panel (`"ui": "components"`) and a
stand-in worker. The worker answers from made-up runs in `plugin/src/fixtures.ts` and never
calls Archon. The fixture has the sizes of a real install: a few hundred runs, three projects,
long workflow names, two runs waiting on a person.

Three variants of the runs list sit in the same chrome (section bar, scope switch,
unmatched-project notice):

- **A, table** (`plugin/src/variant-a.tsx`): a status select, one table that loads more as it
  scrolls, and a preview of the selected run under it.
- **B, sections of cards** (`plugin/src/variant-b.tsx`): close to Archon's console. Filter
  chips, then "Needs you", "Active" and "Recent" sections, with a "Load more" button.
- **C, grouped tree** (`plugin/src/variant-c.tsx`): groups replace filters. Each status (or
  project) is a branch that loads its runs when opened; the selected run's preview is pinned
  under the tree.

Opening a run shows a stub of run detail with a Back control. No press performs anything: the
line at the bottom of the panel says what the last press would have done.

## Run it

```sh
orca plugin dev load ./plugin --json      # prints what is granted and the --approve value
orca plugin open local.orchon-runs-view-prototype --panel runs
```

Loading needs the user's approval in Orca. The bar at the top of the panel flips the variant
and the fixture (project matched, project not known to Archon, no runs).

A shot cannot press anything while Orca's window is showing, so the panel can also be driven
from a terminal:

```sh
orca plugin dev request ./plugin proto.set --data '{"variant":"B","filter":"failed"}'
orca plugin shot local.orchon-runs-view-prototype --panel runs --width 420 --out shots/b.png
```

`proto.set` takes `variant`, `scenario`, `scope`, `filter`, `detail`, `pick` and `tabIcons`
(`Remote` in `plugin/src/protocol.ts`). Captures are in `shots/`; the number in a file name is
the `--width` asked for, and the image is that width divided by the display scale.

`orca plugin dev unload ./plugin` removes it from Orca.

## Known rough edges

- `orca plugin check` fails when the plugin folder is on another drive than Orca itself
  (`orca-testing.mjs: cannot import "./orca-runtime.mjs"`). A copy of the folder on Orca's
  drive checks cleanly.
- Variants A and C leave a horizontal scrollbar on the panel. The cause was not tracked down.
