---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Wildcard-source path index measurements and shared mapped-render attribution."
---

# Wildcard-source path indexes

Both indexes select wildcard sources by the segments preceding their first
`"*"`, alongside their concrete trie. `isPrefix` remains the oracle for
wildcard candidates and wildcard queries. `ConsumedLabelIndex` retains map
order and descendant matches when the query ends before a wildcard. Sources
starting with a wildcard still share the root bucket and can require a scan.

The source-wildcard grid improves substantially. The shared arm-B render
ladder does **not establish an attributable end-to-end gain**: its dominant
`isPrefix` caller is the separate `authoritativeCoverFor` scan. The requested
arm-B improvement criterion remains unmet by these two indexes alone.

## Conditions and correctness

Baseline: `53baf62fdaf9dae6824bc9c5a0da812a64b95d6c`. Apple M3 Max,
Deno 2.9.4, V8 15.0.245.2-rusty. Other development/test processes were active;
absolute wall times and small differences must not be read as quiet-machine
latency measurements. Only the two index modules differ between runtime arms.

The generated grid covers S = 50/250/1000 and wildcard fractions
0/0.05/0.3, rounded down to an integer number of sources. Sources have distinct
container prefixes and trailing wildcards at segment depths 2–5. Queries have
2–7 segments, including hits, misses, ancestors, and descendants. Every one of
70,200 grid queries per index agrees with the plain `isPrefix` scan. Existing
small-path generated tests cover wildcards on both sides, and focused tests
cover duplicate entries, repeated wildcards, source-array reuse, and map order.

## Per-query grid

Microseconds per query, median of seven samples in alternating before/after
order. Each arm warms ten batches. Concrete-source arms and all optimized
arms execute 131,072 queries per batch (over 1.3 million warmup queries);
slower original wildcard-source arms execute 8,192. Result counts are checked
across arms, normalized by batch size. Construction is outside timing.

| Sources | Wildcard fraction | Prefix before → after | Overlap before → after |
| --- | --- | --- | --- |
| 50 | 0 | 0.065 → 0.104 | 0.125 → 0.179 |
| 50 | 0.05 | 0.286 → 0.076 | 8.866 → 0.213 |
| 50 | 0.3 | 0.291 → 0.083 | 11.581 → 0.235 |
| 250 | 0 | 0.091 → 0.107 | 0.224 → 0.194 |
| 250 | 0.05 | 1.440 → 0.108 | 52.482 → 0.324 |
| 250 | 0.3 | 1.282 → 0.108 | 42.982 → 0.227 |
| 1000 | 0 | 0.183 → 0.203 | 0.270 → 0.375 |
| 1000 | 0.05 | 10.265 → 0.192 | 213.459 → 0.387 |
| 1000 | 0.3 | 7.893 → 0.181 | 220.438 → 0.357 |

The optimized wildcard rows are at most 1.68× the corresponding optimized
concrete row in this run. The broad gap to the original wildcard scan is
consistent across the grid. Concrete-only costs include the extra bucket
check; small shifts are mixed with the observed host contention. This corpus
spreads templates over container prefixes; it does not claim constant cost
for many tails in the same bucket or queries that return many descendants.

The maintained `packages/runner/test/cfc-path-index.bench.ts` runs the same
corpus in 8,192-query samples with 200 warmup and at least 100 measured
iterations. Its setup checks scan equivalence outside the timer. The existing
`cfc-dereference-coverage.bench.ts` retains the wildcard-query fallback and
construction arms.

## Shared arm B

The shared fixture is the frozen snapshot of
`packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx` from the
concurrent CFC test-harness work. It waits for SQLite query assertions before
each render, materializes all mapped rows at N = 11/50/150, and separately
copies labeled titles into ordinary writable data. Seed/compile and query
assertions are outside the render intervals. All six runs passed six
assertions. Enforcement was `enforce-explicit`, flow labels `persist`, and
idempotency replay disabled for timing.

Render materialization milliseconds (logger-rounded), in two unprofiled
pairs and one separately identified profiled pair:

| Pair | Indexes | CPU profile | N=11 | N=50 | N=150 |
| --- | --- | --- | --- | --- | --- |
| 1 | before | no | 222 | 1300 | 9000 |
| 1 | after | no | 234 | 1200 | 7500 |
| 2 | before | no | 200 | 1100 | 8600 |
| 2 | after | no | 218 | 974 | 7700 |
| 3 | before | yes | 281 | 1300 | 7800 |
| 3 | after | yes | 227 | 931 | 7000 |

The two unprofiled pairs have medians 211/1200/8800 ms before and
226/1087/7600 ms after. The large rung is lower, but the caller attribution
and concurrent load do not support assigning that whole difference to this
change. The smaller rungs move in different directions.

Across the entire profiled fixture, named `isPrefix` self time was
1065.501 ms (7.02% of sampled time) before and 967.906 ms (7.76%) after.
Its immediate `authoritativeCoverFor` caller accounts for 1044.890 ms and
952.172 ms respectively: over 98% in both arms. This scan does not use either
index. The final fixture's three labeled-copy actions call
`collectConsumedLabel`; its direct `isPrefix` samples fall from 6.228 ms to
zero, which is a sampling result rather than proof of zero execution cost.
Collector wall times remain small and noisy; raw per-step values are in the
data file. The render-only predecessor fixture called the collector zero
times, explaining why that initial ladder could not exercise this index.

The remaining arm-B cost needs separate work on the authoritative-cover
scan. These measurements do not justify expanding this index PR into that
semantic path, and they do not claim the whole mapped-render cost is fixed.

## Reproduction and evidence

- [Raw paired grid, ladder, profile attribution, and harness hashes](2026-09-15-cfc-wildcard-source-index.data.json).
- [Paired-grid replay](2026-09-15-cfc-wildcard-source-index.replay.py).
- [Frozen benchmark harness patch](2026-09-15-cfc-wildcard-source-index.harness.patch), against the baseline above. It contains benchmark support only and is not applied to the production change.

Run the paired grid from a checkout containing this change:

```sh
CHECKOUT="$PWD" python3 docs/history/development/performance/2026-09-15-cfc-wildcard-source-index.replay.py > paired-grid.jsonl
```

For the runtime ladder, create an isolated checkout at the baseline, apply the
harness patch, and run the command below. Alternate the baseline versions of
`packages/runner/src/cfc/{path-prefix-index,consumed-label-index}.ts` with this
change's versions in that isolated checkout; keep every other file identical.

```sh
deno task cf test packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx --cfc-shell-posture --verbose --stats-threshold 0 --no-idempotency-check
```

For the profile pair, replace `deno task cf` with
`CF_PROF_OUT=/tmp/cfc-profile CF_PROF_CPU=1 deno run --no-lock -A skills/perf-investigation/scripts/profile-cf.ts`.
The profile interval is the whole fixture, including setup, rather than only
render materialization. The replay records the runtime patch and fixture
hashes so later harness changes cannot silently be compared with this run.
