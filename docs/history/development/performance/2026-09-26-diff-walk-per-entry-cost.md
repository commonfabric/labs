---
status: historical
created: 2026-09-26
archived: 2026-09-26
reason: "Investigation findings: what a diff walk over a large map of cells spent per entry, what parsing each side's link once measured, and why a shared read transaction and two other shortcuts were ruled out."
---

# The per-entry cost of diffing a map of cells

A caller that rewrites a large map whose entries hold cells, changing one
entry, pays `normalizeAndDiff()` over every entry. With whole-document hashing
gone from the commit path, that walk was the largest cost left on such a
commit. This pass attributed the walk's per-entry time, removed the part that
was redundant, and recorded what is left. An adversarial review then measured
the change harder than the first pass had, and one half of it did not survive.

## What was measured, against what

| | |
| --- | --- |
| labs | `a2476d9e35` (main) and this change |
| workload | a scratch script: one cell holding a map of `N` entries `{ person, fallbackName }`, each `person` a cell of its own made by `runtime.getCell(space, cause)` (no schema on its link, no transaction, its document never written), rewritten whole with one entry's `fallbackName` changed, on `StorageManager.emulate()` and `runtimePresets.unitTest` |
| profile | `deno run --cpu-prof` over thirty `cell.withTx(tx).set(map)` calls with no commit, at `N` = 10,752, attributed by caller chain from the `.cpuprofile` with the samples cut at the `set()` call |
| timing | process CPU per `set()` (`process.cpuUsage()`), fifteen calls per process after the map was committed; main, this change, and this change with the shared transaction, with the order alternated each round over four rounds; the median of the per-process minimums |
| counts | transactions opened at the storage manager, and `Object.keys()` calls on link envelopes and on the whole map, during one `set()` |
| heap | the largest heap `--trace-gc` reported over the same script, three runs per tree |
| journals | a scratch script writing ten scenarios on each tree and dumping, per write, the change set, the write transaction's read activities (address, metadata, clock position) and write attempts, and the committed value; and the review's own twelve scenarios, each under the legacy and the modern cell representation and with `serverExecution` on |
| machine | an M-series laptop running other work, at a load average of 40 to 95 for the timings and heap and 80 to 95 for the profiles |

The profiler's samples are wall-clock, and at that load a sample often lands
while the process waits for a core. The profile says what share of the walk
each part took, and nothing about how many milliseconds it cost.

## Where a walk's time went

Main, samples under `normalizeAndDiff()`:

| cost | share | what it did |
| --- | ---: | --- |
| the entry cell's `schema` getter | 45% | the cell's link states no schema, so the getter resolves the link to find one |
| of which opening a transaction | 19% | with no transaction of its own, the cell opened a read transaction for that one read: the V2 and extended transactions, sixteen callback closures in `Runtime.edit()`, the CFC configuration, and a deep freeze of the trust snapshot, 10,752 times per walk |
| of which the resolution | 26% | one sigil probe of the cell's root, memo keys and records, and the result object |
| recognizing and parsing links, outside the getter | 18% | each call asked of the incoming and the stored value whether it was a link, and parsed it, once per check |
| `retainPendingWriteElision()` | 7% | per unchanged slot, whether the document has a pending write |

In the legacy link representation, recognizing a link runs `Object.keys()` on
the value. Counted over a one-entry rewrite, main enumerated a link envelope 31
times per entry and the whole map 10 times.

## What changed, and what it measured

The incoming value's link is parsed once per call, and every check that asks
whether it is a link or where it points reads that parse. The stored value is
asked once whether it is a link, and its link is parsed only by a check that
reads where it points. A link envelope is now enumerated 17 times per entry and
the whole map 5 times.

| entries | main | this change |
| ---: | ---: | ---: |
| 10,752 | 166.9 ms | 133.4 ms (−20%) |
| 200 | 3.55 ms | 3.05 ms (−14%) |

The review measured maps of plain objects, deeply nested objects, arrays of
links, arrays of cells, a redirect written over a link, and the repository's
`cell-set-shape` and `cell-set-array-shape` benchmarks. Every difference was a
gain or inside the noise except one: the `cell.set` loop of `cell-set-shape`
read 4% slower on wall-clock minimums, which a CPU-timed run of the same body
did not reproduce.

Both journal scripts produce byte-identical output on main and on this change,
statistics and log counts included.

The review also found one input on which a first version of the change parted
from main: a stored link whose path does not parse. Parsing the stored value as
soon as the slot was read made a write redirect over such a link throw, where
main replaces it. The stored link is parsed only where a check reads its target
for that reason, and a test writes a redirect over one.

## Ruled out

**One read transaction per walk.** The first version of this change opened one
read-only transaction the first time a cell needed one and handed it to every
later cell of the walk's runtime. Read transactions per `set()` fell from
10,752 to 1. Against the parse-once change alone:

| entries | parse once | parse once + shared transaction |
| ---: | ---: | ---: |
| 10,752 | 133.4 ms | 138.5 ms |
| 200 | 3.05 ms | 2.15 ms |

It paid where opening transactions dominated the walk and not at the size it
was built for. At 10,752 entries it held every probe's read, document entry
and memo entries until the walk ended, and the largest heap rose from about
270 MB to between 323 and 425 MB. In nineteen pattern tests the walks that
reached a cell averaged 2.2 cells each, and sharing saved 301 transaction opens
in all. Across the runner's own tests 1,142 of 2,908 schema lookups in the walk
would have used it, the `map` builtin's writes among them. It also brought a
public `CellImpl` method, a rule that a walk state lives for one walk, and a
`dereferenceTracesMax` that summed the traces of every cell in a walk.

**Skipping the resolution when the slot already holds the same link.** The
resolved schema's `default` decides whether the walk seeds the cell's
document, and for an output write at a document's root, whether it records
the reference as a preserved output for CFC. A slot already holding the link
settles neither. The seed turns on whether the cell's document is present,
which a link in the slot does not show. The preserved-output record is made
exactly when the slot already references the cell, so a skip on that
condition drops it every time. A schema-less cell's resolved schema carries a
`default` only when its root holds a write redirect to one that does, and
nothing short of reading the root says whether it does. The resolution can
also throw on a redirect cycle, and kicks a pull of a target in another
space. Keeping each of those means keeping the read.

**Building the first probe's memo key from the cycle key.** The resolution
builds the same address key twice per call. Reusing it made no difference
measurable above noise over 10,752 resolutions.

## What is left

- Opening a transaction. It was a fifth of this walk on main, and it costs the
  same wherever a read has no ready transaction to use: 44 `readTx()` call
  sites in the runner, among them every property read through a query-result
  proxy with none. `Runtime.edit()` rebuilds its callback closures and freezes
  a trust snapshot per transaction. Doing that work once would help every one
  of those sites and hold nothing, which is what the shared transaction could
  not do.
- The resolution itself: about 3.5 µs per call when timed alone over 10,752
  absent documents, of which the probe's read is about a third. The rest is the
  memo keys and records, the closures, and the result object, which every
  resolution in the runtime pays.
- `retainPendingWriteElision()` for every unchanged slot: it asks the replica
  whether the document has a pending write, which for every slot of one
  document gives one answer within a walk.
