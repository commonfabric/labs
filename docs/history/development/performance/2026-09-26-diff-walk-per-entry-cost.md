---
status: historical
created: 2026-09-26
archived: 2026-09-26
reason: "Investigation findings: what a diff walk over a large map of cells spent per entry, what removing the redundant part measured, and the two shortcuts ruled out."
---

# The per-entry cost of diffing a map of cells

A caller that rewrites a large map whose entries hold cells, changing one
entry, pays `normalizeAndDiff()` over every entry. With whole-document hashing
gone from the commit path, that walk was the largest cost left on such a
commit. This pass attributed the walk's per-entry time, removed the part that
was redundant, and recorded what is left.

## What was measured, against what

| | |
| --- | --- |
| labs | `a2476d9e35` (main) and this change |
| workload | a scratch script: one cell holding a map of `N` entries `{ person, fallbackName }`, each `person` a cell of its own made by `runtime.getCell(space, cause)` (no schema on its link, no transaction, its document never written), rewritten whole with one entry's `fallbackName` changed, on `StorageManager.emulate()` and `runtimePresets.unitTest` |
| profile | `deno run --cpu-prof`: twelve commits through `runtime.editWithRetry()`, and thirty `cell.withTx(tx).set(map)` calls with no commit, at `N` = 10,752, attributed by caller chain from the `.cpuprofile` with the samples cut at the `set()` call |
| timing | process CPU per `set()` (`process.cpuUsage()`), fifteen calls per process after the map was committed, main and this change alternated over three rounds |
| counts | transactions opened at the storage manager during one `set()` |
| journals | a scratch script writing ten scenarios on each tree and dumping, per write, the change set, the write transaction's read activities (address, metadata, clock position) and write attempts, and the committed value |
| machine | an M-series laptop running other work: a load average of 80 to 95 for the profiles, 40 to 65 for the timing |

The profiles of the change were taken before review moved the choice of the
shared transaction from a parameter on `Runtime.readTx()` into the cell. That
leaves the work each call does the same. The timing, the counts and the
journals are of the final change.

## Where a walk's time went

Thirty `set()` calls at 10,752 entries on each tree, samples under
`normalizeAndDiff()`:

| cost | main | change | what it did |
| --- | ---: | ---: | --- |
| everything | 20.5 s | 13.1 s | |
| the entry cell's `schema` getter | 9.3 s | 5.8 s | the cell's link states no schema, so the getter resolves the link to find one |
| of which opening a transaction | 4.0 s | 0 | with no transaction of its own, the cell opened a read transaction for that one read: the V2 and extended transactions, their CFC configuration, and a deep freeze of the trust snapshot, 10,752 times per walk |
| recognizing and parsing links, outside the getter | 3.7 s | 1.3 s | each call asked of the incoming and the stored value whether it was a link, and parsed it, once per check |
| `retainPendingWriteElision()` | 1.4 s | 1.1 s | per unchanged slot, whether the document has a pending write |

In the legacy link representation, recognizing a link runs `Object.keys()` on
the value. Counted over a one-entry rewrite of a 1,000-entry map, main ran the
recognizer 44 times per entry, over the entry, its cell's link and what the
slots stored, and 7 times on a whole map; the change runs it 18 times per entry
and twice on a whole map.

## What changed, and what it measured

- One read-only transaction per walk. The walk opens it the first time a cell
  needs one and hands it to every later cell of the same runtime. A cell with
  a ready transaction of its own reads through that, and a cell of another
  runtime through its own runtime's.
- Each side's link parsed once per call, and every check reads that result.

Transactions opened by one `set()` of a 10,752-entry map went from 10,752 to 1.
Samples under `normalizeAndDiff()` over thirty `set()` calls went from 20.5 s to
13.1 s, and the GC samples beside them from 2.3 s to 1.5 s. Process CPU per
`set()`, alternated:

| | main | change |
| --- | ---: | ---: |
| lowest of three runs' minimums | 150 ms | 114 ms |
| median of three runs' 25th percentiles | 167 ms | 138 ms |
| median of three runs' medians | 178 ms | 149 ms |

Process CPU moves less than the sampled main thread because it counts the
collector's and the compiler's background threads too. The journals were
byte-identical on both trees in every scenario, and a deliberate regression,
resolving schemas through the write transaction instead, changed four of the
ten.

One runtime statistic reads differently. `dereferenceTracesMax` is the most
dereference traces one transaction has held, and where the walk's cells reach
their schemas through link hops, the shared transaction holds the traces of
all of them. None of this workload's cells does.

## Ruled out

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

- The resolution itself, 44% of what is left under `normalizeAndDiff()`:
  about 3.5 µs per call when timed alone over 10,752 absent documents, of
  which the probe's read is about a third. The rest is the memo keys and
  records, the closures, and the result object, which every resolution in
  the runtime pays.
- `retainPendingWriteElision()` for every unchanged slot, about 8%: it asks
  the replica whether the document has a pending write, which for every slot
  of one document gives one answer within a walk.
- The shared transaction holds every probe's read and memo entry until the
  walk ends. The collector measured lower for it, not higher.
