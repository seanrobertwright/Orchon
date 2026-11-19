// A count with its noun, for the lines that say how many rows are not shown. The panel and the
// worker both load it, so it imports nothing.

/** "1 <one>", or "<count> <many>" for any other count. */
export function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${String(count)} ${many}`
}
