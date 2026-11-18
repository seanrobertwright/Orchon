# Orchon chat view (prototype)

Throwaway prototype for [What should the chat list and thread look like?](https://github.com/seanrobertwright/Orchon/issues/30).

## Run

```powershell
orca plugin check prototypes/chat-view/plugin
orca plugin dev load prototypes/chat-view/plugin --approve
orca plugin open local.orchon-chat-view-prototype
```

## Captures

Screenshots in `shots/` were captured at 220 px and 440 px panel widths (1.2× display scale) on Windows in dark theme; light theme, keyboard submit (`Enter` vs `Ctrl+Enter`), and 3-second refetch stability were verified interactively in Orca.
