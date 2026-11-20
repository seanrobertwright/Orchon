// The packs whose card declarations Archon could not read, as a frame gets them. It is types and
// constants only, read by the panel and the worker alike.

/** How many packs that could not be read the section lists at most, in Archon's order. */
export const UNREADABLE_PACKS_CAP = 10

/** A pack whose card declarations Archon could not read. */
export type UnreadablePack = {
  /** Unique among the listed packs: the pack's source and name. */
  key: string
  /** The pack's name, Archon's own. */
  pack: string
  /** Where Archon found the pack, such as "bundled" or "project". */
  source: string
  /** Archon's message, cut at 500 characters. */
  message: string
}
