---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Default-on handler dispatch timing and phase measurements at a pinned revision."
---

# Default-on handler dispatch timings

All 18 cases of the existing handler-dispatch benchmark completed at revision
`f3494fe9547d6589dad8e382e2392f14b8e0cebf`, on macOS Apple silicon with Deno
2.9.4. Each case checks the handler's resulting value after dispatch. Read
accounting was disabled throughout the timing pass. No runtime code was changed
for this measurement, and no live space was accessed.

This repeats the timing surface of the
[F0 baseline](../2026-09-11-lazy-materialization-f0-baseline.md), without
claiming a before/after improvement: the two revisions were not measured as
interleaved matched arms in this session. The runtime uses its default-on lazy
lift behavior, but handler arguments remain eager. The fixture constructs its
runtime directly; it does not use a toolshed or browser.

## Measurement boundary

Run from the pinned checkout:

```sh
deno bench -A --v8-flags=--expose-gc --json \
  packages/runner/test/handler-dispatch-cost.bench.ts
```

Leave `HANDLER_DISPATCH_COUNTS` unset. Capture stdout as
[timings.json](timings.json) and JSON diagnostic lines from stderr as
[phases.jsonl](phases.jsonl). The benchmark explicitly prepares timed runtimes
with accounting disabled. Deno reports eight timed samples per case; the phase
stream contains nine dispatch records per case, including warmup. Do not average
all phase records and describe that as the Deno timing mean.

Each timed interval starts at event send and ends after the commit callback.
Runtime preparation, reset/reseeding, post-callback drains, and correctness
assertions are outside that interval. Variants run sequentially, with the
previous runtime disposed before the next variant is prepared. Phase values are
milliseconds accumulated between timer snapshots for that dispatch. Some phases
enclose others, so their values are not an additive decomposition of the total.
`elapsed` in the phase stream is the dispatch's internal timer; the Deno timer
also includes its surrounding call overhead.

## Observed dispatch times

| Workload                | Minimum (ms) | Mean (ms) | Maximum (ms) |
| ----------------------- | ------------ | --------- | ------------ |
| scalarKey (74 rows)     | 17.3         | 23.3      | 29.3         |
| scalarGet (74 rows)     | 19.9         | 25.2      | 33.9         |
| walk (74 rows)          | 30.0         | 56.3      | 170.2        |
| mutate (74 rows)        | 15.0         | 29.3      | 68.6         |
| plainScalar (74 rows)   | 19.0         | 24.2      | 37.2         |
| plainWalk (74 rows)     | 29.6         | 58.6      | 181.0        |
| scalarKey (296 rows)    | 32.0         | 35.8      | 43.9         |
| scalarGet (296 rows)    | 41.8         | 49.1      | 61.3         |
| walk (296 rows)         | 67.4         | 108.4     | 278.4        |
| mutate (296 rows)       | 36.3         | 41.1      | 47.0         |
| plainScalar (296 rows)  | 50.4         | 82.2      | 192.8        |
| plainWalk (296 rows)    | 64.7         | 85.2      | 95.0         |
| scalarKey (1184 rows)   | 91.6         | 130.4     | 307.1        |
| scalarGet (1184 rows)   | 154.5        | 181.7     | 218.1        |
| walk (1184 rows)        | 267.7        | 378.4     | 542.8        |
| mutate (1184 rows)      | 89.4         | 139.7     | 283.5        |
| plainScalar (1184 rows) | 148.5        | 176.4     | 204.6        |
| plainWalk (1184 rows)   | 313.5        | 373.6     | 648.5        |

`scalarKey` reads one row through a cell key. `scalarGet` reads the whole list
through a cell handle before selecting one row. `walk` reduces that whole-list
read; `mutate` edits one row and appends another. `plainScalar` and `plainWalk`
bind the list as a value, so eager argument materialization occurs before the
body. These are distinct workloads, not equivalent implementation arms.

## Interpretation and limits

The phase records keep dependency preflight, argument reads, body execution,
post-run work, and commit timing available for attribution. They are separate
from reactive-body proxy counters and do not measure browser rendering. Timing
variation is substantial in several cases; minima, means, and maxima are all
retained so the mean does not hide it. This single ordered matrix does not
isolate machine noise, quantify a lazy-versus-eager benefit, or qualify handler
lazy materialization. A comparative performance claim needs matched repeated
arms and correctness checks for the same workload.
