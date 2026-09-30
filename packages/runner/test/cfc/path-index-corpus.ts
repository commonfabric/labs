/**
 * Shared correctness and timing corpus for CFC path indexes. Sources model
 * container templates with a trailing wildcard at segment depths 2 through 5.
 * Queries mix exact reads, descendants, shorter ancestors, and divergent paths.
 */

/** Source counts and wildcard fractions used by both indexes' corpus checks. */
export const PATH_INDEX_GRID = [50, 250, 1000].flatMap((size) =>
  [0, 0.05, 0.3].map((fraction) => ({ size, fraction }))
);

/**
 * Generates distinct container paths and concrete queries of lengths 2–7.
 * Wildcards replace the last segment of evenly distributed sources; the
 * concrete query population stays identical across fractions at each size.
 */
export function pathIndexCorpus(size: number, fraction: number): {
  /** Source paths, with `floor(size * fraction)` wildcard templates. */
  sources: string[][];

  /** Concrete queries, including successful and unsuccessful prefix checks. */
  queries: string[][];
} {
  const concrete = Array.from({ length: size }, (_, i) => [
    "rows",
    String(i),
    ...Array.from({ length: 1 + i % 4 }, (_, j) => `field${j}`),
  ]);
  const sources = concrete.map((path, i) => {
    const wildcard = Math.floor((i + 1) * fraction) > Math.floor(i * fraction);
    return wildcard ? [...path.slice(0, -1), "*"] : [...path];
  });
  const queries: string[][] = [];
  for (let i = 0; i < size; i++) {
    for (let depth = 2; depth <= 7; depth++) {
      const path = concrete[i].slice(0, depth);
      while (path.length < depth) path.push("child");
      queries.push(path);
      queries.push(path.map((part, j) => j === 1 ? `missing${i}` : part));
      queries.push(
        path.map((part, j) => j === path.length - 1 ? "other" : part),
      );
    }
  }
  return { sources, queries };
}
