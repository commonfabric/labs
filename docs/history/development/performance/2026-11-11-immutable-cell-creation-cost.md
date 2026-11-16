---
status: historical
created: 2026-11-11
archived: 2026-11-11
reason: "Measurements of immutable-cell creation cost after the native-snapshot and cell-ownership changes; the code has since moved on."
---

# Immutable-cell creation cost, November 2026

This record measures what `Runtime.getImmutableCell()` costs per call, where
that cost went up in October 2026, and what a round of reductions recovered. The
[live contract](../../../features/immutable-cell-identifiers.md) states the
identifier and ownership rules that the measured code implements.

## Where the cost went up

The Benchmarks workflow on `main` showed three creation benchmarks in
`runtime/runner/test/cell-immutable.bench.ts` and `cell.bench.ts` becoming two
to three times slower in two steps, and the `anyOf: 5-branch const
discriminator` traversal benchmark becoming 24% to 35% slower in the first of
them. In the raw p75 values of each run, the first step falls between the runs
at `338ae77008` (2026-10-14 20:11 UTC) and `662e6c7278` (2026-10-15 00:30 UTC).
That window holds [PR 8814](https://github.com/commonfabric/labs/pull/8814),
which replaced `data:` URIs with content-hashed `snapshot:` identifiers. The
second step falls between `f94e693c24` and `aa59a9ee7b`, which is
[PR 9561](https://github.com/commonfabric/labs/pull/9561): snapshots minted by
`getImmutableCell()` became owned by their cells rather than by the runtime.

A probe that runs the creation benchmark's body (a fresh runtime, 100 calls,
disposal) and reads the process's CPU time confirmed the first step locally: the
CPU time of the 100 calls alone went from 0.65 ms at the parent of `1a6d70bb86`
to 2.0 ms at `1a6d70bb86`, the commit of PR 8814.

## Method

The host was an Apple M5 Max shared with dozens of other agent sessions, at a
load average near 28. Wall-clock results from `deno bench` were unusable under
that load: one benchmark's p75 was 18 ms against a minimum of 0.46 ms. The
comparisons below therefore come from probe scripts that each build ran in turn,
interleaved, three rounds per build, with 100 warm-up iterations and 400
measured ones. Each reports the process's CPU time per iteration, which counts
the garbage collector's threads as well as the main thread, and the minimum and
10th-percentile wall time of an iteration. All builds ran under the same Deno.

The builds are `135400f8bf`, a commit benchmarked before the first step;
`31b1d04166`, `main` at the time; and `31b1d04166` with the reductions below.
The `anyOf` comparison ran the parent of `1a6d70bb86`, PR 8814's commit, in
place of `135400f8bf`.

## Results

Benchmark body, 100 calls of `getImmutableCell(space, { value: i }, schema)`
on a fresh runtime, then disposal (ms per iteration, three rounds):

| Build                  | CPU         | Wall, 10th percentile |
| ---------------------- | ----------- | --------------------- |
| Before the first step  | 0.75 – 0.90 | 0.27 – 0.29           |
| `main`                 | 2.66 – 4.14 | 1.08 – 1.14           |
| With the reductions    | 2.18 – 2.51 | 0.85 – 0.89           |

The same body with each call inside a transaction that is then aborted:

| Build                  | CPU         | Wall, 10th percentile |
| ---------------------- | ----------- | --------------------- |
| Before the first step  | 0.95 – 1.07 | 0.39 – 0.41           |
| `main`                 | 3.06 – 3.44 | 1.22 – 1.28           |
| With the reductions    | 2.53 – 2.99 | 1.02 – 1.09           |

The `anyOf` traversal benchmark's loop of 100 traversals, each through a new
storage transaction (ms per iteration, three rounds):

| Build                       | CPU         | Wall, 10th percentile |
| --------------------------- | ----------- | --------------------- |
| Parent of PR 8814's commit  | 1.65 – 1.78 | 1.33 – 1.35           |
| `main`                      | 2.04 – 2.13 | 1.37 – 1.38           |
| With the reductions         | 1.72 – 1.78 | 1.34 – 1.34           |

Runtime setup and disposal without any call cost about 0.13 ms on every build,
so the creation body's difference is in the calls.

## The reductions

- The Deno SHA-256 backend hashes inputs of up to 192 bytes in WASM, and its
  incremental hasher creates a `node:crypto` hasher only once the input is
  known to be longer. Creating a `node:crypto` hasher costs more than hashing a
  short input in WASM. `hashStringOf({ value: i })` went from about 5.5 to 3.8
  µs of CPU. The WASM module is compiled in the background, starting at the
  first short input, so that a process which hashes none compiles nothing and
  none waits for the compile before hashing. A process that would otherwise
  exit while the compile is running waits for it to finish. Creating the first
  `hash-wasm` hasher, which compiles the module, took 20 to 30 ms under this
  host's load.
- `fabricFromConvertibleJsValue()` records a container it builds as
  deep-frozen and acyclic when each child already is one. The clone and cycle
  checks that `ImmutableCellStore.createOwned()` makes on the converted value
  then find it in their caches instead of walking it.
- A snapshot store allocates each collection on first use, and registers for
  finalization only when it first retains an identifier. A transaction's store
  usually retains nothing, which is where the `anyOf` loop's extra cost was.
- The owner of an owned snapshot is found through its runtime store's own weak
  map, keyed by both the snapshot and its source value, rather than through a
  global weak map holding a new weak map per snapshot.

Two smaller changes go with them. The walks that visit each container once
track what they have visited in a `Set` rather than a `WeakSet`, since the set
lives only as long as the walk. Dependency collection skips the schema-closure
walk when a value references no schema.

The four reductions above were each measured alone before being combined; the
two smaller changes were not measurable at this noise level. None changes
identifiers, ownership or release.

## What the remaining cost is

A CPU profile of the creation body with the reductions attributes, per call:
the content hash about 30%; the store's ownership bookkeeping (the per-snapshot
owner store, its weak references and finalization registration, and
dependency collection) about 35%; value conversion including the new recording
about 20%; and creating the cell about 7%. Two throwaway variants bounded the
bookkeeping, each measured with the hashing and conversion reductions in
place: making `getImmutableCell()` snapshots owned by the runtime again, as
before PR 9561, gave a body of 0.80 to 0.83 ms at the 10th percentile, and
skipping the per-snapshot owner altogether gave 0.62 to 0.66 ms. Neither
keeps the ownership semantics, so neither shipped.

The content hash alone costs more per call than the whole call did before PR
8814, which built a `data:` URI without hashing. A cell's identifier is read
as soon as the cell exists: a node's inputs document is keyed by it, and links
naming it are written into stored documents. So the hash cannot be deferred,
and the creation benchmarks cannot return below their pre-October values while
identifiers stay content-hashed.
