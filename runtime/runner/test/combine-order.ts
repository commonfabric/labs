/**
 * Seeded arrangements of a collection's members, for tests checking that an
 * aggregate combine returns one result however the aggregate tree orders and
 * groups those members. A search over seeded arrangements finds the
 * counterexamples it draws; it does not show that none exists.
 */

/**
 * Returns a generator of pseudo-random values in `[0, 1)` determined entirely
 * by `seed`, so a failure reproduces from the seed its test names. Each value
 * carries 32 random bits.
 */
export function seededRandom(seed: number): () => number {
  // mulberry32.
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Returns a copy of `items` in an order drawn from `random`. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Combines `items`, kept in their given order, under a binary grouping drawn
 * from `random`; every grouping of that order can be drawn. Returns `empty`
 * when there are no items, and the item itself when there is one.
 */
export function combineInRandomGrouping<T>(
  items: readonly T[],
  combine: (left: T, right: T) => T,
  empty: T,
  random: () => number,
): T {
  const group = (start: number, end: number): T => {
    if (end - start === 1) return items[start];
    const split = start + 1 + Math.floor(random() * (end - start - 1));
    return combine(group(start, split), group(split, end));
  };
  return items.length === 0 ? empty : group(0, items.length);
}
