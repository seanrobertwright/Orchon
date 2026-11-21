# Changelog

Each release of Orchon, newest first. The newest version is the supported one.

A release that changes what Orca asks you to approve raises the minor version and says what is new, and why, under "Asks you to approve again". A patch release never changes it.

## 0.1.1

- A new plugin icon of Orchon's own: a small run graph, with steps done, running and waiting on you, drawn like the one on the cover. The icon it replaces was Archon's mark.

## 0.1.0

The first release. It declares everything Orchon asks you to approve; see "What Orchon does on your machine" in the [README](README.md).

- A sidebar panel, Orchon, with Runs, Launch, Workflows, Chat, Metrics and Settings, following the workspace you are in.
- Two editor tabs: the run graph for `.orchonrun` files and the workflow builder for `.orchonflow` files.
- A status bar item that counts the runs that need you, the command "Orchon: Show runs", and desktop notifications.
- Works with Archon 0.12.1 or newer on this computer. Metrics needs Archon 0.14.0 or newer.
