/** Measures construction plus small numbers of trailing-wildcard cover queries. */

import { ConsumedLabelIndex } from "../src/cfc/consumed-label-index.ts";
import { isPrefix } from "../src/cfc/path-prefix-index.ts";

for (const count of [1, 2, 5, 50]) {
  const entries = Array.from({ length: count * 2 + 1 }, (_, index) => ({
    path: index === 0 ? [] : ["rows", String(index)],
    label: {},
  }));
  const queries = Array.from({ length: count }, () => ["rows", "*"]);
  const expected = queries.reduce(
    (sum, query) =>
      sum + entries.filter(({ path }) => isPrefix(path, query)).length,
    0,
  );
  Deno.bench({
    name: `trailing cover construction and ${count} queries`,
    n: 100,
    warmup: 100,
    fn(b) {
      b.start();
      const index = new ConsumedLabelIndex(entries);
      let found = 0;
      for (const query of queries) {
        found += index.overlapping(query, false).length;
      }
      b.end();
      if (found !== expected) throw new Error("Trailing cover changed");
    },
  });
}
