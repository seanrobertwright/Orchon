# PROTOTYPE: Orchon's run detail and step view in an Orca sidebar panel

Throwaway code. It answers one question for the Orchon plan: what do run detail and a step's
view look like in the panel? Nothing here is meant to be kept.

## What it is

`plugin/` is an Orca development plugin with one components panel (`"ui": "components"`) and a
stand-in worker. The worker answers from one made-up run in `plugin/src/fixtures.ts` and never
calls Archon. The run is a 16-step workflow with a loop of three inner steps, stopped at four
points: paused on a question, running, failed and completed. Its sizes follow a real install:
330 activity items in the busiest step, 8,905 artifact files in the completed run, a 69 KB
Markdown artifact, a tool call whose input is past 16 KiB and a step whose output is past 256 KB.

The runs table opens a run, a run opens a step, and each level has a way back. Three variants
draw run detail and the step view:

- **A, tables** (`plugin/src/variant-a.tsx`): Back buttons, facts as a key-value block, the
  Steps and Artifacts switch as tabs, every list a table with a preview under it. Activity is
  newest first and the table's own load-more is "Show earlier".
- **B, cards and lists** (`plugin/src/variant-b.tsx`): closest to Archon's console. A
  breadcrumb, facts as one wrapped line in a card, the switch as two buttons, steps and activity
  as lists of rows with badges. Activity reads oldest to newest with **Show earlier** on top.
- **C, outline** (`plugin/src/variant-c.tsx`): a one-line header, facts and the launch message
  folded away, the switch as a select, and trees for steps (a loop holds its inner steps), files
  (by folder) and activity (by attempt). The step view has Previous and Next.

No press performs anything: the line at the bottom of the panel says what the last press would
have done.

The four files under `cut-demo/` in the artifact list are each cut at a few hundred bytes, in place of
16 KiB, inside a code fence, a table, a list and a paragraph, so the join shows on one screen.
The two buttons over a Markdown file switch between cutting at any line break and cutting at a
blank line with a fence or a table opened again.

## Run it

```sh
orca plugin dev load ./plugin --json      # prints what is granted and the --approve value
orca plugin open local.orchon-run-detail-prototype --panel runs
```

Loading needs the user's approval in Orca. The bar at the top of the panel flips the variant.

A shot cannot press anything while Orca's window is showing, and it captures only the part of
the panel that is on screen. So the panel can be put anywhere from a terminal, with the upper
part of a screen left out:

```sh
orca plugin dev request ./plugin proto.set --data '{"variant":"C","run":"completed","step":"implement.build","item":"i329","focus":"lower"}'
orca plugin shot local.orchon-run-detail-prototype --panel runs --width 504 --out shots/c.png
orca plugin dev request ./plugin proto.set --data '{}'    # hand the panel back
```

`proto.set` is the whole position (`Remote` in `plugin/src/protocol.ts`): `variant`, `run`,
`step`, `tab`, `item`, `filter`, `artifact`, `split`, `focus` and `earlier`. Captures are in
`shots/`; the number in a file name is the panel's width in CSS pixels.

`orca plugin dev unload ./plugin` removes it from Orca.

## Known rough edges

- `orca plugin check` fails when the plugin folder is on another drive than Orca itself. A copy
  of the folder on Orca's drive checks cleanly.
- The sidebar is shared by every session in the Orca window. When another session shows its own
  panel, this one unmounts, so it asks the worker for the last `proto.set` when it mounts again.
- Live activity (new items every 3 seconds while a step runs) is not simulated.
