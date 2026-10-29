/**
 * Measures warmed, batched path queries against container wildcard templates.
 * Each sample performs 8,192 queries; divide reported nanoseconds by that count
 * for per-query cost. Construction and scan-equivalence checks are untimed.
 */

import { ConsumedLabelIndex } from "../src/cfc/consumed-label-index.ts";
import { isPrefix, PathPrefixIndex } from "../src/cfc/path-prefix-index.ts";
import { PATH_INDEX_GRID, pathIndexCorpus } from "./cfc/path-index-corpus.ts";

const QUERY_COUNT = 8192;

for (const { size, fraction } of PATH_INDEX_GRID) {
  const { sources, queries: corpus } = pathIndexCorpus(size, fraction);
  const queries = Array.from(
    { length: QUERY_COUNT },
    (_, i) => corpus[(i * 7919) % corpus.length],
  );
  const prefix = new PathPrefixIndex();
  for (const path of sources) prefix.add(path);
  const entries = sources.map((path) => ({ path, label: {} }));
  const consumed = new ConsumedLabelIndex(entries);
  let expectedPrefix = 0;
  let expectedOverlap = 0;
  for (const query of queries) {
    const expected = sources.some((source) => isPrefix(source, query));
    const overlaps = sources.filter((source) =>
      isPrefix(source, query) || isPrefix(query, source)
    ).length;
    if (
      prefix.hasPrefixOf(query) !== expected ||
      consumed.overlapping(query).length !== overlaps
    ) {
      throw new Error("Path index disagrees with scan");
    }
    expectedPrefix += Number(expected);
    expectedOverlap += overlaps;
  }
  for (const kind of ["prefix", "overlap"] as const) {
    Deno.bench({
      name: `${kind}, sources=${size}, wildcard=${fraction}`,
      group: `path index ${kind} sources=${size}`,
      baseline: fraction === 0,
      warmup: 200,
      n: 100,
      fn: (b) => {
        let hits = 0;
        b.start();
        if (kind === "prefix") {
          for (const query of queries) {
            hits += Number(prefix.hasPrefixOf(query));
          }
        } else {
          for (const query of queries) {
            hits += consumed.overlapping(query).length;
          }
        }
        b.end();
        if (hits !== (kind === "prefix" ? expectedPrefix : expectedOverlap)) {
          throw new Error("Path index query count changed");
        }
      },
    });
  }
}
