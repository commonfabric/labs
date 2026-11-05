/**
 * Measures the longest-prefix candidate lookup used by persisted link labels.
 * Each sample builds an index and resolves 8,192 paths. The scan arm uses the
 * same selection rule; query fixtures and equivalence checks are untimed.
 */

import { ConsumedLabelIndex } from "../src/cfc/consumed-label-index.ts";
import { isPrefix } from "../src/cfc/path-prefix-index.ts";
import { PATH_INDEX_GRID, pathIndexCorpus } from "./cfc/path-index-corpus.ts";

const QUERY_COUNT = 8192;

for (const { size, fraction } of PATH_INDEX_GRID) {
  const { sources, queries: corpus } = pathIndexCorpus(size, fraction);
  const entries = sources.map((path) => ({ path, label: {} }));
  const scanned = entries.map((entry, ordinal) => ({
    entry,
    path: entry.path,
    ordinal,
  }));
  const queries = Array.from(
    { length: QUERY_COUNT },
    (_, i) => corpus[(i * 7919) % corpus.length],
  );
  const cover = (query: readonly string[], index?: ConsumedLabelIndex) => {
    let depth = -1;
    let checksum = 0;
    for (const candidate of index?.overlapping(query, false) ?? scanned) {
      if (index === undefined && !isPrefix(candidate.path, query)) continue;
      if (candidate.path.length > depth) {
        depth = candidate.path.length;
        checksum = candidate.ordinal + 1;
      } else if (candidate.path.length === depth) {
        checksum += candidate.ordinal + 1;
      }
    }
    return checksum;
  };
  const index = new ConsumedLabelIndex(entries);
  let expected = 0;
  for (const query of queries) {
    const result = cover(query);
    if (cover(query, index) !== result) {
      throw new Error("Authoritative cover differs from scan");
    }
    expected += result;
  }
  for (const kind of ["scan", "index"] as const) {
    Deno.bench({
      name:
        `authoritative cover ${kind}, sources=${size}, wildcard=${fraction}`,
      group: `authoritative cover sources=${size}, wildcard=${fraction}`,
      baseline: kind === "scan",
      warmup: 100,
      n: 30,
      fn: (b) => {
        let checksum = 0;
        b.start();
        const lookup = kind === "index"
          ? new ConsumedLabelIndex(entries)
          : undefined;
        for (const query of queries) checksum += cover(query, lookup);
        b.end();
        if (checksum !== expected) throw new Error("Cover checksum changed");
      },
    });
  }
}
