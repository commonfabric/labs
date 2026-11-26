---
status: historical
created: 2026-11-23
archived: 2026-11-23
reason: "Investigation of the 2026-11-20 rise in the storage-write and cell benchmarks on the AMD EPYC 7763 runners, traced to the memory engine creating its whole schema in every new in-memory store, and the change that copies the schema instead."
---

# The memory engine's schema and the storage benchmarks, November 2026

## What rose

Between the scheduled Benchmarks runs at `d6ff573a64` and `57583b56d5`
(2026-11-20), and again over the next day, most of the benchmarks in
`runtime/runner/test/storage.bench.ts`, `storage-transaction-path.bench.ts` and
`cell.bench.ts` rose on the AMD EPYC 7763 runners while the machine calibration
stayed at about 555 µs. Comparing the six 7763 runs before `57583b56d5` with the
six from it on, the median of each benchmark's 75th percentile rose 5 to 15% for
every benchmark that opens a store and commits to it. The rows that time plain
JavaScript in the same files, such as `deepEqual` and `Map` overheads, stayed
within 1%. The "measure writes only" rows, which time the writes and not the
commit, also stayed flat. The two "measure commit only" rows rose 9% and 15%.

## Cause

Each of these benchmark iterations creates a store with
`StorageManager.emulate()`, and the memory engine opens an empty in-memory
SQLite database for it. `open()` in `runtime/memory/v2/engine.ts` ran the
engine's whole schema on that database, creating every table and index, and then
the migration checks. The currency index work (labs #10041 onward) added tables
to that schema in nearly every change. The counts below are the `CREATE TABLE`
and `CREATE INDEX` statements in the schema's text at each commit. On
`ca49d0ea75` a migration creates one more index.

| commit | tables | indexes | 7763 "100 writes to 1 entity, measure commit only" |
| --- | ---: | ---: | --- |
| `7f34505379` and earlier | 16 | 14 | 3.29 to 3.42 ms |
| `d6ff573a64` | 22 | 16 | 3.54 ms |
| `57583b56d5`, `de039bab77` | 22 | 18 | 3.67 to 3.75 ms |
| `ba103935aa` to `c672013024` | 27 to 28 | 20 to 21 | 3.93 to 4.08 ms |
| `2aa147d36e` to `3bfcf47c12` | 29 to 30 | 22 to 23 | 4.00 to 4.24 ms |

Measured on an Apple M5 Max with V8's sampling profiler over 3,000 store
lifetimes (open, 100 writes to one document, commit, dispose, close), the time
in `open()` running the schema was 0.32 ms per store at `7f34505379`, 0.41 ms at
`57583b56d5`, and 0.54 ms at `ca49d0ea75`. On `ca49d0ea75` all of `open()` was
0.69 ms of 1.53 ms of profiled time per store. Running the schema alone on an
empty database took 0.33, 0.44 and 0.58 ms for the three versions. The 7763 runs
pay several times what the M5 does for the same work: the whole `cell.bench.ts`
file ran three to five times faster on the M5.

## Ruled out

- The runner image, the Deno version and the calibration were the same either
  side of the window.
- The ambient read-metadata scope that labs #10039 put on the read path: these
  benchmarks do not enter it often, and their profiles do not change across that
  commit.
- The page size: the schema at 4,096-byte pages took 0.53 ms against 0.58 ms at
  the engine's 32,768-byte pages.

## Change

An in-memory store always starts empty, so its schema is always the same.
`open()` now prepares the schema once in each isolate, in an in-memory database
it keeps with no rows, and copies that database into each new in-memory store
with SQLite's backup API. The store then seeds its default branch with the
statement the schema uses, so the branch is dated from the store's opening. Each
isolate keeps the template, 83 pages of 32 KB, for as long as it runs. A store
backed by a file still runs the schema and the migrations, since it may hold an
older layout. Copying took 0.16 ms against 0.58 ms for running the schema. Both
figures include SQLite reading the schema when the store prepares its first
statement.

Measured on the M5, three rounds of the three benchmark files with the builds
interleaved, median of each benchmark's 75th percentile, `ca49d0ea75` against
the change:

| benchmark | `ca49d0ea75` | with the change |
| --- | ---: | ---: |
| `tx.writeValuesOrThrow` nested batch (100x) | 5.84 ms | 3.89 ms |
| single sibling write x100 | 2.01 ms | 1.12 ms |
| 100 writes to 1 entity, measure commit only | 1.68 ms | 0.74 ms |
| 100 new entities, measure commit only | 3.45 ms | 2.71 ms |
| Cell get - simple value schemaless (100x) | 3.09 ms | 2.24 ms |
| `deepEqual`, equal values (1000x) | 0.47 ms | 0.45 ms |

Over the 92 benchmarks in those files that take more than 50 µs, the geometric
mean ratio of the change to `ca49d0ea75` was 0.84.

## Not explained

`Cell get - simple value schemaless (100x)` stepped at `57583b56d5` on the 7763
from about 9.5 to 12 ms, a run whose schema had the same number of tables as the
run before it. It has been bimodal there since: the same commit measured 8.88
and 13.51 ms in two runs. Locally its body measured 2.16 and 2.22 ms either side
of the step, with the same CPU time. Whether the second mode comes from the
hosts or from a change in that window is not settled; a Benchmarks run
dispatched by hand at `d6ff573a64` that lands on a 7763 would separate the two.
