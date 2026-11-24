/** Reports initialization reads and paired, uninstrumented update timings. */

import {
  type AggregateWorkload,
  createAggregateFixture,
} from "./aggregate-fixture.ts";

for (const size of [10, 100, 1000]) {
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
    const fixtures = [];
    try {
      for (const generic of [true, false]) {
        fixtures.push(
          await createAggregateFixture(operation, size, generic, true),
        );
      }
      for (const fixture of fixtures) {
        fixture.runtime.scheduler.setReadStatsEnabled(false);
      }
      const samples: number[][] = [[], []];
      for (let iteration = 0; iteration < 13; iteration++) {
        for (const index of iteration % 2 ? [1, 0] : [0, 1]) {
          const start = performance.now();
          await fixtures[index].update();
          const elapsed = performance.now() - start;
          if (iteration > 0) samples[index].push(elapsed);
        }
      }
      for (let index = 0; index < fixtures.length; index++) {
        const fixture = fixtures[index];
        for (
          const key of Object.keys(
            fixture.reads,
          ) as (keyof typeof fixture.reads)[]
        ) fixture.reads[key] = 0;
        fixture.runtime.scheduler.setReadStatsEnabled(true);
        await fixture.update();
        const sorted = samples[index].toSorted((a, b) => a - b);
        console.log(JSON.stringify({
          size,
          operation,
          generic: index === 0,
          initialization: fixture.initialization,
          update: { ...fixture.reads },
          samplesMs: samples[index],
          p75Ms: sorted[Math.ceil(sorted.length * 0.75) - 1],
        }));
      }
    } finally {
      for (const fixture of fixtures) await fixture.dispose();
    }
  }
}
