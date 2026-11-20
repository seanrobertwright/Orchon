// Keys for listed rows that must be unique among the rows, such as React keys.

/**
 * A key maker: the first time it is given a base it returns the base, and each later time the
 * base followed by "#" and how many times it has been given, such as "run/node#2".
 */
export function keyCounter(): (base: string) => string {
  const seen = new Map<string, number>()
  return (base) => {
    const times = (seen.get(base) ?? 0) + 1
    seen.set(base, times)
    return times === 1 ? base : `${base}#${String(times)}`
  }
}
