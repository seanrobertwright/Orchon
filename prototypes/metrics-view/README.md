# PROTOTYPE: Orchon's Metrics section in an Orca sidebar panel

Throwaway code for [What should the metrics section look like?](https://github.com/seanrobertwright/Orchon/issues/31). Nothing here is meant to be kept.

## What it is

`plugin/` is an Orca development plugin with one components panel (`"ui": "components"`) and a stand-in worker (`plugin/src/worker.ts`) serving fixture data shaped from Archon `v0.14.0` (`metric.ts`, `metric-view.ts`, and `.archon/workflows/sdlc/.shared/metric-views.json`).

It compares two variants:

- **Variant A**: `7d / 30d / 90d` horizontal radio group, `Tabs` for Overview/Details, `IconButton` refresh, `Grid minItemWidth="sm"`, `Heading level={2}` figures with calibration `Badge` beside the figure, and a metric's view **replaces** the Details table with a `← Back to metrics` button.
- **Variant B**: `7 days / 30 days / 90 days` horizontal radio group, `Button` pair for Overview/Details, `Button` refresh, `Grid minItemWidth="md"`, `Heading level={1}` figures with calibration `Badge` stacked below, and a metric's view **sits under** the Details table with a `Close` link.

And five scenarios:

- `normal`: 1 pack (`sdlc`) with count, ratio (`rough`), and cost-per-item cards.
- `states`: all card states (no records, nothing counted, cost withheld, calibration loading, calibration unavailable, not calibrated, unknown shape), 2 packs (`sdlc` + `docs-audit`), 23 refused outputs (20 shown + "and 3 more in Archon's console"), 2 unreadable packs, and an unknown-kind row + no-records row in Details.
- `loading-initial`: card titles over `Skeleton`s before the report answers.
- `loading-window`: `"Loading last 30 days… Showing last 7 days"` with a `Spinner` over the previous figures.
- `empty-packs`: `"No pack declares overview cards."` with an action to open Details.

## Run it

```powershell
orca plugin check prototypes/metrics-view/plugin
orca plugin dev load prototypes/metrics-view/plugin --json
orca plugin open local.orchon-metrics-view-prototype --panel metrics
```

To drive the panel for captures:

```powershell
orca plugin dev request prototypes/metrics-view/plugin proto.set --data '{"variant":"A","scenario":"normal","tab":"overview"}'
orca plugin shot local.orchon-metrics-view-prototype --panel metrics --width 220 --out prototypes/metrics-view/shots/a-overview-220.png
orca plugin dev request prototypes/metrics-view/plugin proto.set --data '{}'
```
