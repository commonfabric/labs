/** Measures committed single-row updates through settled aggregate results. */

import {
  type AggregateWorkload,
  createAggregateFixture,
} from "./aggregate-fixture.ts";

for (
  const operation of [
    "count",
    "sum",
    "min",
    "max",
    "minBy",
    "maxBy",
  ] satisfies AggregateWorkload[]
) {
  for (const size of [10, 100, 1000]) {
    for (const generic of [true, false]) {
      Deno.bench({
        name: generic ? "generic reduce" : "incremental",
        group: `${operation} ${size} rows`,
        baseline: generic,
        n: 3,
        warmup: 1,
        async fn(b) {
          const fixture = await createAggregateFixture(
            operation,
            size,
            generic,
          );
          try {
            b.start();
            await fixture.update();
            b.end();
          } finally {
            await fixture.dispose();
          }
        },
      });
    }
  }
}
