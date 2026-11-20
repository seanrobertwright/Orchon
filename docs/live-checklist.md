# Live Orca checklist

The host behaviour no test can reach, run by hand in Orca before each tag. A listed version is permanent and installs update by themselves 12 hours after it is listed, so a tag waits until every box here is ticked and the sign-off at the end is filled in. Run it again on each new Orca release.

Every item comes from "Live checks before the first tag" in the spec (#33) or from the live checklist of the tooling decision (#23). When a check shows that the spec or Orca's documentation is wrong, report it on #33 before the tag and note it under "Findings".

## Setup

- Orca: the latest release, which `orca plugin validate` is run on below. Version: ____
- Load the plugin from this checkout with `orca plugin dev watch .` and approve what Orca lists.
- Archon: a throwaway Archon home, never your own `config.yaml`. Use a release 0.12.1 server for the checks that name it and the newest supported release (0.14.0) for the rest. Versions run: ____
- A local Git workspace registered with Archon, with at least one workflow that has an approval gate and one with a `wait: attention` node.

## Worker posts and hidden frames

- [ ] A worker post reaches an open editor tab: with a run graph tab open, a step's state changes on the graph when the run moves, without a press.
- [ ] A worker post reaches a hidden panel: with another sidebar panel chosen, or the sidebar closed, a run changes state; on showing Orchon again, the runs table shows the new state.
- [ ] A hidden panel's timers: with the panel hidden for over a minute, note whether it stays mounted and keeps refetching, or remounts on show. Either is fine; record which.
- [ ] `unavailable` for an errored worker: once Orca has marked the plugin errored, the panel shows the Worker unreachable state with "Try again", and after three failures in a row how to turn the plugin off and on. A panel request restarts a worker that crashed fewer than three times.

## Focus and controls

- [ ] Focus after an inline confirmation: after confirming and after cancelling Cancel run, Delete chat and Delete workflow, focus stays where Orca puts it and Orchon never moves it.
- [ ] `RadioGroup` option descriptions: in a question with described options, and in the metrics window, each option's description shows and is read by a screen reader.
- [ ] Selecting text in a `Code` block: on the Not found screen, `archon serve` can be selected and copied by hand.

## Archon release behaviour

- [ ] On a 0.12.1 server: a gate answered from Orchon sends `expectedGate` as a string and is accepted.
- [ ] On a 0.12.1 server: answering a gate that was answered elsewhere first gets the 409, and Orchon shows Archon's refusal in Archon's words and sends nothing more.
- [ ] On a 0.12.1 server: a non-empty attention answer is accepted and the run moves on.
- [ ] On a release server: `PATCH /api/config/*` from each Settings form saves only the changed keys, `null` removes a tier or an alias, and a refused value shows Archon's 400 message.
- [ ] On a release server: the `/api/auth/*` routes answer 401, and Orchon calls none of them.
- [ ] The timing of a metrics query: with a 90 day window, each report answers within Orchon's 30 second timeout. Time taken: ____
- [ ] Archon's restart time: stop and start Archon; note how long it takes, and whether the panel stays on Searching through the 20 second grace without reaching Not found. Time taken: ____
- [ ] When the Archon home folder first exists, on each install route you can try (script, source, Docker): before Archon's first run, Not found uses the right one of its two wordings. Routes tried: ____

## Status bar item, command and notifications

- [ ] The status bar item shows each figure: "Archon", "3 running", "2 need you" with the bell, "Archon…", "Archon off" and "Archon setup", and the status bar's text length leaves each one whole. Its tooltip is one sentence.
- [ ] Pressing the status bar item opens nothing in the sidebar by itself; an open panel switches to Runs with the "Needs you" filter when runs need you.
- [ ] The command's returned sentence: "Orchon: Show runs" from the palette returns the status sentence and where to find the panel.
- [ ] Notification behaviour: one notification per question; a burst of more than 3 folds into one; nothing on the first read after a worker start; whether a notification shows while Orca is focused, and whether its title carries the plugin id as a prefix. Record both.
- [ ] Send test notification in Settings delivers one notification.

## Workspaces

- [ ] An SSH workspace row: the panel opens on "All projects" with "This workspace is on another host. Orchon works with the Archon on this computer.", and matching, Link, Register, launching and both wide tabs are off.
- [ ] A WSL workspace row on Windows: a workspace on a WSL share counts as on another host; a project on a Windows drive opened with a WSL runtime counts as local.

## Look and use

- [ ] Light theme throughout: every section of the panel, the state screens, the run graph tab and the builder tab are readable in Orca's light theme, and no state is shown by colour alone.
- [ ] Keyboard use throughout: every control of the panel and of both editor tabs can be reached and used from the keyboard, the graph pans and zooms by key, and `Ctrl+S` or `Cmd+S` saves in the builder.
- [ ] A 220 px panel: at 220 px wide every section reads and works, the Settings forms' stacked fields per model choice included, and the metrics cards sit in one column. `orca plugin shot --width 220` gives the same picture.

## The approval surface

- [ ] `orca plugin validate` passes on the latest Orca release and accepts the ids as spelled: `console`, `run-graph`, `builder`, `status` and `show-runs`.
- [ ] Orca's approval text lists the five capabilities and the contributions the README section "What Orchon does on your machine" names, and nothing else.
- [ ] The update rules: install a build with a higher version and the same surface, and it updates by itself and stays enabled; install one that asks for more, such as one more capability, and it shows "Update needs review" while the current version keeps running. Do this with throwaway local builds only, never a tag.

## Findings

Anything a check contradicts in #33, with the issue comment that reports it.

- ____

## Sign-off

Each box above is ticked by the owner, who ran the check in Orca.

Version checked:
Orca version:
Date:
Signed off by:
