---
status: historical
created: 2026-09-25
archived: 2026-09-25
reason: "Measurements of the staged-reference derivation cache against main."
---

# Staged-reference derivation cache

The cache reduced preparation time for binary reference diamonds while
preserving all serialized label maps. It bounds repeated derivation, but does
not bound the number of distinct paths in the flat stored map. The
[compact-map plan](../../../../plans/compact-cfc-label-maps.md) addresses that
separate representation problem.

## Compared code and boundary

Base: `ceb8aa4ce1f62e757e0100c6f33b6353983c3332`, after #8044 merged. The two
arms share the same checkout except for `packages/runner/src/cfc/prepare.ts`:

- Baseline SHA-256:
  `2fd262bc52413e11431daeb87e0a4b0c9e2dec29828cbeacb74cda04cba90f91`.
- Cache SHA-256:
  `bd72ebc7e9301e8919ee96bde15206a81f93afee0d2eedd69f9d490d9c7e108d`.

Machine: the same Apple M5 Max, 18 logical CPUs used in the preceding
investigation; macOS 26.6.2, arm64, Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript
6.0.3. The sandbox did not expose the CPU name to Deno's benchmark header. CPU
identity is from the preceding machine inspection, not that header.

The probe uses an emulated store, enforcement `enforce-explicit`, and persisted
flow labels. A stored leaf has confidentiality `secret`; staged object schemas
have integrity `object-proof`. Each of `depth` nodes has `width` references to
the next node, plus a holder that references the first node. Only
`runtime.prepareTxForCommit(tx)` is timed. Setup, commit, metadata inspection,
hashing, and disposal are outside timing. Nothing renders or subscribes to the
graph. Each sample has a fresh runtime and store.

Five process pairs alternate baseline/cache and cache/baseline. Each process
warms one depth-2 diamond, then measures depths 8, 10, and 12, widths 1 and 2,
and both staging orders. This gives five observations per arm and case, 120
observations total. [Raw records](paired.jsonl) include timings, full-map
hashes, serialized bytes, work counters, and post-process load averages. No CPU
profiler or temporary counting instrumentation runs in these timings; the cache
arm has its production work counters enabled.

## Diamond preparation

Milliseconds; each cell is median / minimum across five process runs.

| Depth | Staging order | Baseline          | Cache           |
| ----- | ------------- | ----------------- | --------------- |
| 8     | bottom-up     | 72.56 / 69.54     | 39.05 / 33.62   |
| 8     | top-down      | 60.38 / 58.50     | 32.23 / 27.15   |
| 10    | bottom-up     | 255.79 / 251.51   | 115.75 / 105.20 |
| 10    | top-down      | 269.49 / 266.28   | 93.91 / 88.39   |
| 12    | bottom-up     | 1254.59 / 1158.25 | 496.81 / 435.61 |
| 12    | top-down      | 1326.94 / 1212.47 | 371.35 / 345.15 |

The one-minute load average ranged from 26.69 to 41.89, above the machine's
logical CPU count. These are busy-machine samples, not isolated latency
estimates. The repeated large improvement, matching minima, identical outputs,
and bounded work counts support the mechanism; small differences do not
establish regressions.

## Chain control

The initial single-sample-per-process chain medians suggested possible overhead.
A dedicated series warmed the actual depth-12 chain workload: five alternating
process pairs, each with 20 repetitions per staging order. The first ten
repetitions in each process are warmup; the last ten yield 50 measured samples
per arm and order. [Raw records](chains.jsonl) retain warmup and measured
samples. Load averages ranged from 17.33 to 19.08.

| Order     | Baseline median | Cache median | Baseline min | Cache min |
| --------- | --------------- | ------------ | ------------ | --------- |
| bottom-up | 7.50 ms         | 7.03 ms      | 5.49 ms      | 5.27 ms   |
| top-down  | 6.84 ms         | 6.29 ms      | 5.12 ms      | 5.08 ms   |

The longer series does not reproduce a chain slowdown. It is a different warmup
regime from the size sweep, so the two series' absolute timings are not directly
comparable. No chain result is reused: cache-hit counts are zero in every
sample.

## Preserved output and remaining growth

Every case has one identical full-map SHA-256 across arms, staging orders, and
repetitions. Every root retains all `width ** depth` confidential leaf paths.
All measured preparations commit successfully.

| Diamond depth | Uncached derivations with cache enabled | Cache hits | Root entries | Total entries | Serialized bytes |
| ------------- | --------------------------------------- | ---------- | ------------ | ------------- | ---------------- |
| 8             | 145                                     | 98         | 512          | 1,524         | 161,358          |
| 10            | 221                                     | 162        | 2,048        | 6,130         | 691,120          |
| 12            | 313                                     | 242        | 8,192        | 24,560        | 2,990,354        |

Bytes are UTF-8 JSON for all inspected label maps, not retained heap, full
transaction bytes, or network traffic. The cache avoids duplicate recursive
work; prefixing, merging, and persisting each distinct path still costs time and
space. Increasing depth remains exponential in output size.

## Reproduction and regression coverage

[probe.ts](probe.ts) accepts `DEPTHS`, `WIDTHS`, `REPEATS`, and `ORDERS`
environment variables. From the repository root, run it with
`ENV=test deno run -A` followed by its path. The sweep uses
`DEPTHS=8,10,12 WIDTHS=1,2 REPEATS=1`; the warmed control uses
`DEPTHS=12 WIDTHS=1 REPEATS=20`, discarding samples below 10. Run each arm in a
separate process, alternate their order five times, and keep other checks
outside the timing interval. The baseline prepare file is obtained from the base
revision above; always restore the working file after comparison.

The maintained benchmark is
`packages/runner/test/cfc-staged-reference.bench.ts`, covered by the existing
benchmark workflow's file glob. Its fixture also carries terminal integrity, so
compare that benchmark only against its own matching baseline. All 12 cases ran
successfully with
`ENV=test deno bench --no-check --allow-read --allow-write
--allow-net --allow-ffi --allow-env`
and the benchmark path.

The derivation tests guard every diamond leaf's confidentiality and integrity,
bounded work, both staging orders, zero reuse for chains and mixed cyclic
graphs, carried-reader refusal, and changed source metadata in a later
transaction.
