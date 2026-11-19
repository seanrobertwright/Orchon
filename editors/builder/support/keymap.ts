// The two shapes the copied builder keymap (../archon/editor/keymap.ts) builds. Archon declares
// them in its console's React keymap hook and help overlay (lib/keymap.ts and
// components/KeymapHelp.tsx at v0.14.0); the plugin restates only the data shapes, with no React.

/** A chord and its label. `keys` is never empty. */
export interface KeyEntry {
  keys: readonly [string, ...string[]]
  label: string
}

/** A chord the editor answers, and an optional gate that hides it when it returns false. */
export interface Binding extends KeyEntry {
  run: () => void
  when?: () => boolean
}

/** A titled group of chords for a shortcuts list. */
export interface KeymapGroup {
  title: string
  entries: readonly KeyEntry[]
}
