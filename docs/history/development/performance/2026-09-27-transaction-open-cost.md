---
status: historical
created: 2026-09-27
archived: 2026-09-27
reason: "Investigation findings: what opening a transaction through `Runtime.edit()` cost, the two parts made once per runtime, what realistic workloads spent on it, and why the rest was left alone."
---

# The cost of opening a transaction

A read that holds no ready transaction opens one through `Runtime.readTx()`,
which calls `Runtime.edit()`. The
[diff-walk investigation](2026-09-26-diff-walk-per-entry-cost.md) found those
opens to be about a fifth of a walk over a map of 10,752 schema-less cells,
and named the cost of opening one as what was left.
This pass attributed that cost, made the two parts that never vary between a
runtime's transactions once per runtime, and then measured whether opening a
transaction is a material cost anywhere realistic. It is not, and the rest was
left alone.

## What was measured, against what

| | |
| --- | --- |
| labs | `4873205f70` (main) and this change |
| micro-benchmark | a scratch script opening 100,000 transactions through `runtime.readTx()` with one `readValueOrThrow()` each, on `StorageManager.emulate()`; process CPU per open and read (`process.cpuUsage()`), the minimum of five rounds per process |
| A/B | the two trees alternated each round, order reversed every other round, eight processes per tree; the median of the per-process minimums |
| profile | `deno run --cpu-prof` over 200,000 opens, samples attributed to `edit()`'s direct callees |
| realistic workloads | `default-app-note-create.bench.ts` at 0 and 128 notes, `cf test` of lunch-poll (`read-cost`, `main`) and topics, on main; calls counted by wrapping `Runtime.prototype.edit` and `readTx` from a scratch driver; `edit()`'s inclusive share of non-idle profile samples |
| machine | an M-series laptop with 14 cores running other work, at a load average of 20 for the first profile, 90 to 420 for everything else |

The profiles sample wall-clock, so at that load they give shares, not
milliseconds.

## Where an open's time went

On main, `edit()` was 59% of the micro-benchmark's loop, the probe read the
rest. Under `edit()`:

| cost | share of `edit()` |
| --- | ---: |
| `setCfcTrustSnapshot()`: deep-freezing a trust snapshot the default provider built fresh for each transaction, and adding it to the frozen-value `WeakSet` | 33% |
| `ExtendedStorageTransaction`'s field initializers | 23% |
| `edit()`'s own time, most of it building an object of sixteen hook closures | 19% |
| the V2 storage transaction | 10% |
| the module-delegation snapshot, and its copy into the transaction | 7% |
| the twelve setters for the dials and the runtime's CFC configuration | about 7% |

Timed alone, adding a fresh object to a `WeakSet` cost about 120 ns, against
about 19 ns for a `Map` and 65 ns for the object of sixteen closures.

## What changed, and what it measured

The default trust-snapshot provider hands every transaction one snapshot,
frozen once at construction: its principal and the trust revision are both
fixed for the runtime's lifetime. The hooks are built once, in the
constructor, and frozen: each reads the runtime's fields when called, and
those acting on a transaction are handed it. A custom provider is still called
for every transaction, and what it returns is still frozen.

| micro-benchmark, CPU per open and read | main | this change |
| --- | ---: | ---: |
| median of per-process minimums | 2.44 µs | 1.79 µs (−27%) |
| best process | 2.10 µs | 1.64 µs (−22%) |

`runtime-read-tx-fallback.bench.ts`, the median of four alternated minimums
per tree, per hundred reads: a direct read 261 µs against 216 µs, a schema-less
proxy 3,174 µs against 2,712 µs, a `cell.get()` 1,777 µs against 1,609 µs,
that last inside its noise. `cell-set-shape.bench.ts` moved inside noise that
spanned up to twice within one tree between rounds. The benchmarks' `p75` was
unusable at that load: stalls of up to 98 ms reached it.

On the 10,752-entry diff walk, `edit()` fell from 17.7–17.8% of the walk's
samples to 9.2–9.6%, at a load average of 90 to 115. With the
delegation-snapshot memo below added it measured 9–11%.

## Whether it bites

| workload, on main | `edit()` calls | through the `readTx()` fallback | `edit()` share of non-idle samples |
| --- | ---: | ---: | ---: |
| note create, 0 notes | 10 per create | 2 | 1.16% |
| note create, 128 notes | 10 per create | 2 | 0.16% |
| `cf test` lunch-poll `read-cost` | 3,367 | 2,107 | 0.15% |
| `cf test` lunch-poll `main` | 3,162 | 1,433 | 0.16% |
| `cf test` topics | 5,918 | 2,792 | 0.35% |
| the 10,752-entry diff walk | one per entry | one per entry | 17–18% |

Most opens in the realistic workloads are write transactions the scheduler
needs. Of 16,677 `readTx()` calls in lunch-poll `read-cost`, 87% passed a
ready transaction and opened nothing. In the same profiles commit took 11–14%
of a note create, and compiling patterns 15–32% of a `cf test` run. Only a walk
over a large map of cells, the shape of an index keyed by person, spends a
material share opening transactions.

## Stopped short of

Each of these was built or designed, and measured or reviewed, and left out
because the cost it removes is under 1% of every realistic workload above.

**Allocating the transaction's collections lazily.** Fourteen collections in
`ExtendedStorageTransaction` — callback sets, the verdict promise, the outbox
idempotency set, the read memos, the sets recording runtime-marked inputs and
owned stores — made on first addition. It passed 118 test files and added
about two points on the diff walk. It touched the verdict, callback, outbox
and memo paths and three security-adjacent sets. `#cfcState` itself cannot be
made lazily: `edit()` writes the dials into it on every open, and replacing
the object breaks the live forwarding of the read-only view `getCfcState()`
hands out.

**Memoizing the module-delegation snapshot.** About 6% of `edit()`. Each
transaction still copies the snapshot, and the memo adds an invalidation rule.
The copy stays whatever is shared: a frozen `Map` passes the read-only view
unwrapped and still accepts `.set()`.

**Replacing the ownership `WeakSet` with a private brand.** About 120 ns per
open, and it rewrites the authority check external content observation relies
on.

**One module-private call configuring the dials.** The per-dial setters are
public because pattern code reaches the transaction through `cell.tx`, and
each carries an anti-downgrade pin, so a bulk configure has to be
module-private and set every pin.

**Interning a custom provider's snapshots, or memoizing
`trustSnapshotForPrincipal()` per principal.** A provider may return a
different snapshot on each call, and the serving loop calls
`trustSnapshotForPrincipal()` once per run, not per read; a per-principal
memo grows with every principal a long-lived serving runtime sees. The two
connectors that build a fresh snapshot per call can hold one instead.

## What is left

- The callers. `normalizeAndDiff()` reads each entry cell's `schema`, and
  that getter opens one transaction per entry: the only workload where
  opening is material. `Runner.#writeJavaScriptActionResult()` reads a meta link through
  a fallback transaction with the action's transaction in scope; whether the
  meta read is kept off that transaction on purpose was not established.
- The first `getCfcState()` on each transaction allocates a proxy and a
  `WeakMap` entry, and the schema and cell read paths call it on every read
  without a transaction.
- `ExtendedStorageTransaction.#createOnlyMarks` is written and never read.
