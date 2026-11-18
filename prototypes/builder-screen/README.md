# PROTOTYPE: workflow builder editing screen

Throwaway code for [issue #28](https://github.com/seanrobertwright/Orchon/issues/28). Explores the builder's layout (wide tab and ~780 px), connect mode, inspector forms (simple `prompt` and dense `loop`), read-only nodes, the >300-node cap, and two runtime checks (`Ctrl/Cmd+S` inside the frame, and draft restore speed from `orca.storage`).

## Variants

Use the floating bottom bar (or `←` / `→` outside inputs) to switch layouts:

- **A — Split-rail IDE**: Left Outline + Center Canvas/YAML + Right Inspector + Bottom Issues strip. At `<= 860px` (`780px` toggle), Issues moves into a center tab.
- **B — Canvas + Tabbed Sidecar**: Left Canvas + Bottom Issues strip + Right 310 px (`270px` narrow) sidecar tabbed `[Inspector | Outline | YAML]`.
- **C — Outline Workbench**: Left 220 px Outline (always visible) + Right split into Top Inspector and Bottom `[Canvas | YAML | Issues]`.

## Run it in Orca

1. Load the dev plugin (Orca will print the approval fingerprint):
   ```sh
   orca plugin dev load ./prototypes/builder-screen/plugin --json
   ```
   Approve with the printed `--approve <fingerprint>` when ready.
2. Open the builder tab from the command palette:
   **"Orchon prototype: open workflow builder"** (or `orca plugin dev request ./prototypes/builder-screen/plugin proto.open --data '{"key":"project:archon-assist"}'`).

## Checklist to try in Orca

1. **Wide & 780 px**: Flip through variants **A**, **B**, **C** at full width and with the **780px** header toggle (or with both Orca sidebars open on a 1280 px window).
2. **Connect mode**: Select a node, click **Connect** (or press `C`), click a target node (or press `Enter` in the outline) to add the dependency. Click an edge and press `Delete` (or **Remove edge**) to remove it.
3. **Forms & read-only nodes**: Inspect `Triage request` (`prompt`), `Implement & test loop` (`loop` with "Not editable here"), and `Release checks (include)` / `Legacy script` / `Malformed loop` (read-only).
4. **Past the cap**: Switch the workflow dropdown to `oversized-pipeline (project, 320)` to see the >300-node notice and outline-only editing.
5. **Ctrl/Cmd+S**: Click inside the builder frame and press `Ctrl+S` / `Cmd+S` — check the status line and `orca plugin logs local.orchon-builder-prototype` to confirm it reached the frame.
6. **Draft restore on tab switch**: Edit a field (so **Unsaved changes** appears), switch to another Orca tab and back, and check whether the draft restores immediately without flashing the saved copy.
7. **Other theme**: Switch Orca between light and dark themes to check contrast on read-only nodes, errors, and connect highlights.
